// services/k2Shadow.ts —— K2 影子模式（R34 · 智能体兑现三步②）
// ─────────────────────────────────────────────────────────────────────────────
// 定位：K2 语义检索以「只读建议」进主链路——绝不参与业务决策（不回写工单
// 字段、不改变流转、不自动派单）。唯一目的：积累「K2 建议 vs 人工实际」
// 配对数据，量化评估 MODEL_AUTO_TUNE 开启条件（DMR：先数据后模型）。
//
// 三条影子：
//   category 影子：建单嵌入成功时，同一向量检索相似历史单 → category 多数票
//                 → 与工单最终分类立即对比（matched 可当场判定）。
//   dispatch 影子：相似单的 assignee 多数票 → 派单/改派发生时回填 actual。
//                 口径名「人工派单可预测性」——测的是**人的派单习惯**能否从相似单
//                 预测，这是事实描述，不是缺陷（生产实测 0.171 只说明人难预测）。
//   auto_tune_dispatch 影子（双口径改造，2026-10-22）：按**当前生效 dispatch_rule
//                 集合**（AUTO_TUNE 写回权重 + 模型评分，与 autoDispatchAfterCreate
//                 同一条选人链路）算出应派工人 → 派单/改派发生时回填 actual。
//                 口径名「AUTO_TUNE 派单一致性」——测的是**规则派单 vs 现网实际派单
//                 差多少**，这才是 AUTO_TUNE 上线要回答的问题。
//
// 诚实边界：所有函数 best-effort，异常仅告警，绝不影响主链路（建单/流转）。
// ─────────────────────────────────────────────────────────────────────────────

import type { PoolClient } from 'pg';
import { getActiveRules, resolveDispatch } from '../engine/dispatch.js';
import { resolveNeed } from '../engine/dispatch/needResolver.js';
import { StatsModelBackend } from '../engine/model/ModelBackend.js';
import { safeParseJsonb } from '../util/jsonb.js';

/** 余弦相似度；长度不等视为不可比（返回 NaN，由调用方过滤）。 */
export function cosineSim(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return NaN;
  return dot / Math.sqrt(na * nb);
}

// 与 K2 检索护栏同量级：候选拉取上限，防大租户全表载入内存。
const CANDIDATE_LIMIT = 500;
const TOP_K = 3;

export interface ShadowCandidate {
  refId: string;
  category: string;
  sim: number;
}

/** 多数投票（平票取首个达到最高票的键，遍历顺序稳定 → 结果可复现）。 */
export function majorityVote(votes: string[]): string {
  const tally = new Map<string, number>();
  for (const v of votes) if (v) tally.set(v, (tally.get(v) ?? 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [k, n] of tally) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/**
 * 建单嵌入成功后调用（ticket.ts 异步 best-effort 块内）：
 * 同一向量检索相似历史单 → 落 category（当场判 matched）+ dispatch（待回填）两条影子行。
 * @param finalCategory 工单最终分类口径（与嵌入表 category 同源：businessType || catalog）
 */
export async function recordShadowSuggestions(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  vec: number[],
  finalCategory: string,
): Promise<void> {
  // R12-F1 数据稀疏修正：LEFT JOIN work_orders 带出 assignee_id——
  // dispatch 投票只在「有派单记录」的候选内进行（R15 live 诊断：全量候选中大量
  // draft/无 assignee 单稀释 TOP-K 投票，导致 dispatch 影子行几乎不落）。
  const cand = await client.query<{ ref_id: string; category: string; embedding: number[]; assignee_id: string | null }>(
    `SELECT e.ref_id, e.category, e.embedding, w.assignee_id
     FROM ai_case_embeddings e
     LEFT JOIN work_orders w ON w.tenant_id = e.tenant_id AND w.id::text = e.ref_id
     WHERE e.tenant_id = $1 AND e.ref_type = 'work_order' AND e.ref_id <> $2
     LIMIT ${CANDIDATE_LIMIT}`,
    [tenantId, String(workOrderId)],
  );
  const scored: (ShadowCandidate & { assigneeId: string | null })[] = cand.rows
    .map((r) => ({ refId: String(r.ref_id), category: r.category || '', sim: cosineSim(vec, r.embedding), assigneeId: r.assignee_id }))
    .filter((r) => Number.isFinite(r.sim) && r.sim > 0)
    .sort((a, b) => b.sim - a.sim);
  if (scored.length === 0) return;

  // ① category 影子：相似单多数票 vs 工单最终分类（当场可判）
  const catVote = majorityVote(scored.slice(0, TOP_K).map((s) => s.category));
  if (catVote) {
    await client.query(
      `INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, actual, matched, detail)
       VALUES ($1, $2, 'category', $3, $4, $5, $6)`,
      [
        tenantId,
        String(workOrderId),
        catVote,
        finalCategory || null,
        finalCategory ? catVote === finalCategory : null,
        JSON.stringify({ top_k: scored.slice(0, TOP_K).map(({ assigneeId: _a, ...rest }) => rest), vec_dims: vec.length }),
      ],
    );
  }

  // ② dispatch 影子：在有 assignee 的候选中取相似度 TOP_K 多数票（actual 留空，派单时回填）
  const withAsg = scored.filter((s) => s.assigneeId).slice(0, TOP_K);
  const workerVote = majorityVote(withAsg.map((s) => s.assigneeId || ''));
  if (workerVote) {
    await client.query(
      `INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, detail)
       VALUES ($1, $2, 'dispatch', $3, $4)`,
      [tenantId, String(workOrderId), workerVote, JSON.stringify({ top_k: withAsg.map(({ assigneeId, ...rest }) => ({ ...rest, has_assignee: !!assigneeId })) })],
    );
  } else if (scored.length > 0) {
    // V2-F5（派单纵切 P0-12 冷启动）：修复前「候选全无 assignee → 不落 dispatch 行」，
    // 导致首单派单时 resolveDispatchShadow UPDATE 扑空（0 行命中），actual 永远无处回填，
    // 「建议 vs 实际」配对数据永远空转 = 飞轮死锁。
    // 修法：仍有相似候选但无人可投票（冷启动）时，落一条 suggested=''（"无建议"占位，
    // schema 允许 NOT NULL DEFAULT ''，065_ai_shadow_suggestions.sql）的 dispatch 行，
    // 并在 detail 标记 cold_start 供后续评估口径过滤。此后首单真实派单回填 actual 时
    // UPDATE 即可命中本行 → 配对数据闭环，飞轮得以启动。
    await client.query(
      `INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, detail)
       VALUES ($1, $2, 'dispatch', '', $3)`,
      [tenantId, String(workOrderId), JSON.stringify({ cold_start: true, top_k: scored.slice(0, TOP_K).map(({ assigneeId, ...rest }) => ({ ...rest, has_assignee: !!assigneeId })) })],
    );
  }

  // ③ auto_tune_dispatch 影子（双口径改造）：与 ①② **同批触发点、并行新增**的一条写入
  //    路径——本口径不依赖相似度（预测输入是 dispatch_rule + worker + 模型），但沿用
  //    本函数的触发条件（有相似候选才落行），避免两套触发条件分叉；互不影响：只 INSERT
  //    一条 auto_tune_dispatch 行，不回写任何业务字段。内部吞错（旁路自我隔离）——
  //    本路径失败绝不允许拖垮下方自愈回填（那会连既有 dispatch 影子的 actual 都回填不了）。
  const autoTuneWrote = await recordAutoTuneShadow(client, tenantId, String(workOrderId), finalCategory);

  // R12-F1 补强（自愈回填）：建单自动派单（同步）先于本函数（嵌入异步后）执行，
  // 派单路径的 resolveDispatchShadow 会扑空于「影子行尚未 INSERT」的时序竞态。
  // 故此处补查工单当前 assignee：已有则立即回填 actual，确定性消除竞态。
  // 条件含 autoTuneWrote：新口径行落成时同样需要这次自愈（否则它的 actual 永远空着）。
  if (workerVote || autoTuneWrote) {
    try {
      const cur = await client.query<{ assignee_id: string | null }>(
        'SELECT assignee_id FROM work_orders WHERE tenant_id = $1 AND id = $2',
        [tenantId, String(workOrderId)],
      );
      const actual = cur.rows[0]?.assignee_id;
      if (actual) await resolveDispatchShadow(client, tenantId, String(workOrderId), actual);
    } catch (e) {
      console.warn('[shadow self-heal] fail:', (e as Error).message);
    }
  }
}

/**
 * 双口径改造②：AUTO_TUNE 一致性影子的写入路径（与 recordShadowSuggestions **同批触发点、
 * 并行新增**的一条路径，互不影响——只 INSERT 一条 auto_tune_dispatch 行，不回写任何
 * 业务字段，也不看相似度候选）。
 *
 * predicted = 对某工单按**当前生效 dispatch_rule 集合**算出应派工人：规则（权重含
 *   AUTO_TUNE 写回值）+ 实时工人负载 + 模型评分，与 autoDispatchAfterCreate 同一条
 *   选人链路——写回权重只在模型评分排序里生效（规则权×模型分×负载因子），少了模型，
 *   本口径就对「被验收的对象」失明。规则不命中/选不出人 → 不落行（无可预测对象，
 *   不制造假数据）。
 * actual = 派单/改派发生时由 resolveDispatchShadow 回填（与 dispatch 影子同一条 UPDATE）。
 *
 * 时间窗切分（防过拟合）：落库时把当时的规则版本标识（dispatch_rule / model_state 的
 *   max(updated_at)，见 getAutoTuneRuleVersionAt）记进 detail.rule_version_at；统计与
 *   达标判定只计入 created_at 晚于**当前**规则版本生成时间的行（getShadowReplayStats 的
 *   autoTuneRuleVersionAt 参数）——被预测的单若参与过该轮规则生成，则不计入（同一批数据
 *   又当教材又当考卷，分数必虚高）。
 *
 * 旁路自我隔离：内部吞错仅告警、返回 false——本路径失败绝不影响主链路，也不许拖垮
 * 调用方（recordShadowSuggestions）后续的自愈回填（那会连既有 dispatch 影子的 actual
 * 都回填不了）。
 */
export async function recordAutoTuneShadow(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  finalCategory: string,
): Promise<boolean> {
  try {
    // 本单的派单需求维度：business_type/priority/catalog。
    // 技能不落工单表——它由 needResolver 从 catalog 当场派生（与实派同入口）。
    const wo = await client.query<{ business_type: string | null; priority: string | null; catalog: string | null }>(
      // catalog 一并读出：技能维度由 needResolver 派生，影子与实派必须吃同一份输入
      'SELECT business_type, priority, catalog FROM work_orders WHERE tenant_id = $1 AND id = $2',
      [tenantId, String(workOrderId)],
    );
    const woRow = wo.rows[0];
    // 与 autoDispatchAfterCreate 同口径：只有 urgent/normal 参与规则匹配，其余不猜
    const prio = woRow?.priority === 'urgent' || woRow?.priority === 'normal' ? woRow.priority : undefined;
    const businessType = finalCategory || woRow?.business_type || '';
    // 当时的规则版本标识；空 → 无规则集也无模型，没有可版本化的预测输入
    const versionAt = await getAutoTuneRuleVersionAt(client, tenantId);
    if (!versionAt) return false;
    const rules = await getActiveRules(client, tenantId);
    if (rules.length === 0) return false;
    const workers = await client.query<{ id: string; skill_tags: unknown; load: number; active: boolean }>(
      'SELECT id, skill_tags, load, active FROM worker WHERE tenant_id = $1',
      [tenantId],
    );
    const workerRows = workers.rows.map((w) => ({ ...w, skill_tags: safeParseJsonb(w.skill_tags) ?? [] }));
    if (workerRows.length === 0) return false;
    // 模型评分（AUTO_TUNE 写回权重的唯一生效通道）；无 model_state 时用默认模型（强探索）
    const ms = await client.query<{ params: unknown }>(
      'SELECT params FROM model_state WHERE tenant_id = $1 AND model_key = $2',
      [tenantId, 'dispatch_score'],
    );
    const model = new StatsModelBackend(safeParseJsonb(ms.rows[0]?.params) ?? undefined);
    // 与 workOrder.ts 共用同一个 resolveNeed：此前影子侧手写 need（不含 skill_tags）、
    // 实派侧另写一份（含 skill_tags），靠测试看守潜在分叉；收敛后分叉在结构上不可能。
    // 注：回放用的是**当前**目录技能配置，历史实派当时的配置不同则不严格等价——
    //     影子评的是"按此刻配置会派给谁"，这是刻意的口径，不是偏差。
    const shadowNeed = await resolveNeed(
      {
        tenantId,
        entityType: 'work_order',
        business_type: businessType,
        priority: prio,
        catalog: woRow?.catalog ?? undefined,
      },
      client,
    );
    const resolved = resolveDispatch(workerRows, rules, shadowNeed, model);
    if (!resolved) return false; // 无规则命中 / 无候选可选 → 不落行
    await client.query(
      `INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, suggested_by, detail)
       VALUES ($1, $2, 'auto_tune_dispatch', $3, 'auto_tune', $4)`,
      [
        tenantId,
        String(workOrderId),
        resolved.worker.id,
        JSON.stringify({
          rule_id: resolved.ruleId,
          rule_name: rules.find((r) => r.id === resolved.ruleId)?.name ?? null,
          rule_version_at: versionAt.toISOString(),
          model_key: 'dispatch_score',
        }),
      ],
    );
    return true;
  } catch (e) {
    console.warn('[shadow auto-tune] fail:', (e as Error).message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 影子回放只读出口（任务 #356「派单模型上线」的解挂判据）
// ─────────────────────────────────────────────────────────────────────────────
// 背景：ai_shadow_suggestions 此前**只写不读**（全仓无 SELECT），于是「影子达标才开
// MODEL_AUTO_TUNE」这句话没有任何机读通道——达标与否全靠人跑 SQL 手算，而手算口径
// 极易错（见下）。本出口把达标判定变成一次 GET，#356 才具备解挂条件。
//
// 🔴 消解口径两条影子不一样（踩过一次坑，务必保持）：
//   category：matched 在 INSERT 当场就写好（见本文件 :97），**从不写 resolved_at**
//             ⇒ 已判定 = matched IS NOT NULL。若按 resolved_at 统计，category 会被全漏。
//   dispatch：建单时 actual 未知，派单时才 resolveDispatchShadow 回填
//             ⇒ 已判定 = resolved_at IS NOT NULL。
// 曾有人（我）按 resolved_at 统一统计，得出「category 零消解=飞轮断点」的错误结论；
// 实测按正确口径 category 命中率 0.841 已达标。故口径写死在 SQL 里并由真库测试锚住。
//
// 阈值：以下默认值为**建议值**（尚无业务确认口径），可用 env 覆盖，且响应里如实标注
// 来源——不许让「建议值」在接口里伪装成既定标准。
// ─────────────────────────────────────────────────────────────────────────────

function numFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface ShadowTuneThresholds {
  /** 每一类影子至少要有多少条**已判定**样本才谈得上统计显著。 */
  minJudged: number;
  category: number;
  dispatch: number;
  /**
   * AUTO_TUNE 派单一致性口径阈值（双口径改造新增）。与 dispatch 同量级的**建议值**
   * （尚无业务确认口径）：规则派单复现现网实际派单的起码线。env SHADOW_AUTOTUNE_HITRATE 可覆盖。
   */
  autoTuneDispatch: number;
}

export function shadowTuneThresholds(): ShadowTuneThresholds {
  return {
    minJudged: numFromEnv(process.env.SHADOW_MIN_JUDGED, 200),
    category: numFromEnv(process.env.SHADOW_CATEGORY_HITRATE, 0.6),
    dispatch: numFromEnv(process.env.SHADOW_DISPATCH_HITRATE, 0.5),
    autoTuneDispatch: numFromEnv(process.env.SHADOW_AUTOTUNE_HITRATE, 0.5),
  };
}

// ── 展示层口径正名（双口径改造①）─────────────────────────────────────────────
// 背景：dispatch 口径测的是「人工派单可预测性」，却被当成 AUTO_TUNE 的验收线——两个
// 问题被同一个 0.5 阈值绑在一起，判据与验收目标错位。库里 kind 值一律不动（改 kind
// 会让按 kind 聚合的历史数据断链，零收益纯风险）；正名只发生在展示层：每个 kind 挂
// 一个人类可读口径名 + 一句如实说明。未知 kind 原样展示（不臆造口径名）。
export const SHADOW_METRIC_NAMES: Record<string, string> = {
  category: '分类预测一致性',
  dispatch: '人工派单可预测性',
  auto_tune_dispatch: 'AUTO_TUNE 派单一致性',
};

export const SHADOW_CRITERIA_NOTES: Record<string, string> = {
  category: '相似历史工单的分类多数票 vs 本单最终分类（建单当场判定）',
  dispatch:
    '相似历史工单的人工派单多数票 vs 本单实际派单结果——衡量人工派单习惯的可预测性，不是派单规则质量',
  auto_tune_dispatch:
    '按当前生效 dispatch_rule（含 AUTO_TUNE 写回权重，经模型评分）应派工人 vs 本单实际派单结果；仅计入规则版本生成时间之后创建的影子行（被预测的单若参与过该轮规则生成则不计入——同一批数据又当教材又当考卷，分数必虚高）',
};

/** 口径名（未知 kind 原样返回，不臆造）。 */
export function shadowMetricName(kind: string): string {
  return SHADOW_METRIC_NAMES[kind] ?? kind;
}

/** 口径说明（未知 kind 如实标注未登记）。 */
export function shadowCriteriaNote(kind: string): string {
  return SHADOW_CRITERIA_NOTES[kind] ?? '口径说明未登记（新增 kind 尚未展示层正名）';
}

export interface ShadowReplayRow {
  kind: string;
  total: number;
  judged: number;
  hits: number;
  hitRate: number | null;
  lastAt: string | null;
}

/**
 * AUTO_TUNE 口径的「规则版本标识」= 当前生效预测输入集的最近修改时间：
 *   GREATEST(max(dispatch_rule.updated_at), max(model_state.updated_at @ dispatch_score))
 * 两个输入缺一不可——AUTO_TUNE 写回改的是 rule.weight，而 weight 只在**模型评分排序**
 * 里生效（rankByModel：规则权×模型分×负载因子）；少了模型，写回权重对 predicted 零影响，
 * 口径就对「被验收的对象」失明。模型重训同样推进版本（predicted 的另一半输入变了）。
 * 两者皆空 → null（无规则集也无模型：没有可版本化的预测输入）。
 *
 * 为什么 updated_at 可信：applyDispatchOptimizations 的写回 UPDATE 已带 updated_at=now()
 * （optimizer.ts），model_state 的 upsert 亦写 updated_at——「规则/模型被动过」在库里留痕。
 */
export async function getAutoTuneRuleVersionAt(
  client: PoolClient,
  tenantId: string,
): Promise<Date | null> {
  const r = await client.query<{ rule_v: Date | string | null; model_v: Date | string | null }>(
    `SELECT (SELECT max(updated_at) FROM dispatch_rule WHERE tenant_id = $1) AS rule_v,
            (SELECT max(updated_at) FROM model_state WHERE tenant_id = $1 AND model_key = 'dispatch_score') AS model_v`,
    [tenantId],
  );
  const times = [r.rows[0]?.rule_v, r.rows[0]?.model_v]
    .filter((v): v is Date | string => v != null)
    .map((v) => new Date(v as unknown as string).getTime())
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  return new Date(Math.max(...times));
}

/**
 * 按 kind 聚合影子消解情况。days 为空表示全量。
 * @param autoTuneRuleVersionAt AUTO_TUNE 口径的规则版本标识（getAutoTuneRuleVersionAt 的
 *   返回值）。**仅对新口径 auto_tune_dispatch 生效**的时间窗切分：只计入 created_at 晚于
 *   该时刻的影子行——被预测的单若参与过该轮规则生成（同一批数据又当教材又当考卷），
 *   分数必虚高，故整行排除（不只排除回填）。旧口径（category/dispatch）统计逐字不变。
 *   传 null/不传 = 不加窗口（存量调用行为不变；无规则版本时也没有「该轮生成」可污染）。
 */
export async function getShadowReplayStats(
  client: PoolClient,
  tenantId: string,
  days?: number,
  autoTuneRuleVersionAt?: Date | string | null,
): Promise<ShadowReplayRow[]> {
  const r = await client.query<{ kind: string; total: number; judged: number; hits: number; last_at: Date | string | null }>(
    `SELECT kind,
            count(*)::int AS total,
            count(*) FILTER (
              WHERE CASE WHEN kind = 'category' THEN matched IS NOT NULL
                         ELSE resolved_at IS NOT NULL END
            )::int AS judged,
            count(*) FILTER (WHERE matched)::int AS hits,
            max(created_at) AS last_at
       FROM ai_shadow_suggestions
      WHERE tenant_id = $1
        AND ($2::int IS NULL OR created_at >= now() - make_interval(days => $2))
        AND (kind <> 'auto_tune_dispatch' OR $3::timestamptz IS NULL OR created_at > $3::timestamptz)
      GROUP BY kind
      ORDER BY kind`,
    [tenantId, days ?? null, autoTuneRuleVersionAt ?? null],
  );
  return r.rows.map((row) => ({
    kind: row.kind,
    total: Number(row.total),
    judged: Number(row.judged),
    hits: Number(row.hits),
    hitRate: Number(row.judged) > 0 ? Number(row.hits) / Number(row.judged) : null,
    lastAt: row.last_at ? new Date(row.last_at as unknown as string).toISOString() : null,
  }));
}

/**
 * 达标判定。**空集一律判不达标**——没有样本 ≠ 达标，否则新租户上线第一天就是"全绿"，
 * 那是假绿（与仓内护栏"空集通过不算通过"同一条纪律）。
 *
 * 双口径（2026-10-22）：每个 kind 在展示层挂口径名（metric_name/criteria_note）——
 * dispatch=「人工派单可预测性」（人的派单习惯可预测性，事实描述非缺陷），
 * auto_tune_dispatch=「AUTO_TUNE 派单一致性」（规则派单 vs 现网实际，AUTO_TUNE 验收目标）。
 * 新口径同样过 minJudged 门槛 + 空集判不达标；顶层 auto_tune_criteria 是它的单一状态
 * 通道（一行样本都没有时也如实给 present=false + 不达标，不许假绿）。
 * 总门公式保持存量语义不变：在场 kind 全部达标 ∧ category/dispatch 两类必须在场。
 */
export function summarizeShadowReplay(rows: ShadowReplayRow[], th: ShadowTuneThresholds) {
  const want = (kind: string) =>
    kind === 'category' ? th.category : kind === 'auto_tune_dispatch' ? th.autoTuneDispatch : th.dispatch;
  const kinds = rows.map((r) => {
    const threshold = want(r.kind);
    const reasons: string[] = [];
    if (r.judged < th.minJudged) reasons.push(`已判定样本 ${r.judged} 条 < 要求的 ${th.minJudged} 条`);
    if (r.hitRate === null || r.hitRate < threshold) {
      reasons.push(`命中率 ${r.hitRate === null ? '不可计算' : r.hitRate.toFixed(3)} < 要求的 ${threshold.toFixed(2)}`);
    }
    return {
      ...r,
      metric_name: shadowMetricName(r.kind),
      criteria_note: shadowCriteriaNote(r.kind),
      threshold,
      hit_rate: r.hitRate,
      ready: reasons.length === 0,
      reasons,
    };
  });
  // 两类影子都必须在场且都达标 —— 只统计有的那一类会让"从未产生 dispatch 影子"看起来达标。
  // 空集同样走这条路：missing 非空 ⇒ 不达标（不需要另加 kinds.length>0，加了就是冗余条件）。
  const present = new Set(kinds.map((k) => k.kind));
  const missing = ['category', 'dispatch'].filter((k) => !present.has(k));
  const ready = kinds.every((k) => k.ready) && missing.length === 0;
  const reasons = [
    ...kinds.flatMap((k) => k.reasons.map((x) => `${k.kind}：${x}`)),
    ...missing.map((k) => `${k}：无任何影子样本`),
  ];
  // AUTO_TUNE 一致性口径的单一状态通道：有数据时与 kinds 里的同 kind 条目一致；
  // 一行都没有（或全在时间窗外）时 present=false + ready=false——没有样本 ≠ 达标。
  const atKind = kinds.find((k) => k.kind === 'auto_tune_dispatch');
  const auto_tune_criteria = atKind
    ? {
        kind: 'auto_tune_dispatch',
        metric_name: atKind.metric_name,
        criteria_note: atKind.criteria_note,
        threshold: atKind.threshold,
        present: true,
        total: atKind.total,
        judged: atKind.judged,
        hits: atKind.hits,
        hitRate: atKind.hitRate,
        ready: atKind.ready,
        reasons: atKind.reasons,
      }
    : {
        kind: 'auto_tune_dispatch',
        metric_name: shadowMetricName('auto_tune_dispatch'),
        criteria_note: shadowCriteriaNote('auto_tune_dispatch'),
        threshold: th.autoTuneDispatch,
        present: false,
        total: 0,
        judged: 0,
        hits: 0,
        hitRate: null,
        ready: false,
        reasons: ['auto_tune_dispatch：无任何影子样本（AUTO_TUNE 派单一致性口径未积累数据）'],
      };
  return { kinds, ready, reasons, auto_tune_criteria };
}

/**
 * 派单/改派发生时回填影子 actual（ticket.ts transition 内调用）。
 * 一条 UPDATE 覆盖两个派单口径：dispatch（人工派单可预测性）与 auto_tune_dispatch
 * （AUTO_TUNE 派单一致性，双口径改造）——同批触发点、同一回填路径，仅命中未决行。
 * 旁路自我隔离：内部吞错仅告警——影子失败绝不允许炸主流转事务。
 */
export async function resolveDispatchShadow(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  actualWorkerId: string,
): Promise<void> {
  try {
    await client.query(
      `UPDATE ai_shadow_suggestions
       SET actual = $3, matched = (suggested = $3), resolved_at = now()
       WHERE tenant_id = $1 AND work_order_id = $2
         AND (kind = 'dispatch' OR kind = 'auto_tune_dispatch') AND resolved_at IS NULL`,
      [tenantId, String(workOrderId), actualWorkerId],
    );
  } catch (e) {
    console.warn('[shadow resolve] fail:', (e as Error).message);
  }
}
