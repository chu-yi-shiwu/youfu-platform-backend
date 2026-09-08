// C1 自适应优化层（横切优化带 3c）。
//
// 职责：读模型参数(model_state) + 过程度量(processMetrics) → 生成优化决策 →
//   - dispatch 范围：把模型臂权重写回 dispatch_rule.weight（飞轮写回，保持 T-A AUTO_TUNE 行为并审计）。
//   - workflow 范围：依据过程度量产出流程调优建议，存 pending 待 T-① workflow_def 引擎消费应用。
//
// 设计依赖说明（诚实）：设计文档写 C1「依赖 ① 可配置状态机、写回 workflow_def」，但 workflow_def
// 属 T-①（排在 T-C 之后，代码尚未存在）。本实现不越界建完整状态机引擎，而是把 workflow 类优化
// 决策落库为 pending 建议，待 T-① 引擎建成即可直接消费——既让飞轮可见、可审计，又不阻塞 T-C。
//
// ⑦P2 扩展：新增 generateMiningOptimizations，消费 ⑦P0 过程挖掘结果（飞轮"眼睛"）产出精确实例级
//   优化建议（最慢转移→自动升级、偏离率→复核闸门），与 generateOptimizations（粗粒度 processMetrics）
//   互补，共同驱动 ④ 自我优化闭环 + ⑤ 模数共振。
//
// 纯函数 generateOptimizations / generateMiningOptimizations 脱离 PG 单测；apply*/record* 负责 DB 读写。
import type { PoolClient } from 'pg';
import { safeParseJsonb } from '../util/jsonb.js';
import type { ModelParams } from '../engine/model/ModelBackend.js';
import type { ProcessMetrics } from '../repo/stats.js';
import type { ProcessMiningResult } from '../repo/processMining.js';
import type { WorkflowDef } from '../engine/stateMachine.js';
import { ensureWorkflowDef, saveWorkflowDef } from '../engine/workflowDef.js';

export interface OptimizationDecision {
  // 2026-09-06 任务⑦新增 'transport'：陪检线运力走廊建议（语义=运力调度，非流程改写）。
  // 注意：optimization_feedback.scope 的 DDL CHECK 只允许 ('dispatch','workflow')，
  // 落库时须经 dbScopeFor() 映射（transport → workflow 持久化，语义由 target='transport:*' 前缀保留）。
  scope: 'dispatch' | 'workflow' | 'transport';
  target: string;
  recommendation: Record<string, unknown>;
  reason: string;
}

const WEIGHT_MIN = 0.1; // 与 T-A AUTO_TUNE 写回下限一致（规则权不允许塌到 0）

/** 纯函数：由模型参数 + 过程度量生成优化决策（不碰 DB，可单测）。 */
export function generateOptimizations(
  model: ModelParams | null,
  metrics: ProcessMetrics,
): OptimizationDecision[] {
  const decisions: OptimizationDecision[] = [];

  // 1) dispatch 范围：模型臂权重 → 规则权（保持 T-A 写回语义：new_weight = max(0.1, arm.weight)）
  if (model?.arms) {
    for (const [key, arm] of Object.entries(model.arms)) {
      const [category] = key.split('::');
      const newWeight = Math.max(WEIGHT_MIN, arm.weight);
      decisions.push({
        scope: 'dispatch',
        target: `dispatch_rule:business_type=${category}`,
        recommendation: { business_type: category, new_weight: Number(newWeight.toFixed(4)) },
        reason: `模型臂 ${key} 权重=${arm.weight.toFixed(4)}（pulls=${arm.pulls}）→ 换算规则权=${newWeight.toFixed(4)}`,
      });
    }
  }

  // 2) workflow 范围：依据过程度量产出流程调优建议（待 T-① workflow_def 引擎消费）
  if (metrics.reassign_rate > 0.3) {
    decisions.push({
      scope: 'workflow',
      target: 'work_order:recheck_gate',
      recommendation: { add_step: 'recheck_after_assign', trigger: 'reassign_rate>0.3' },
      reason: `转派率=${metrics.reassign_rate} 偏高，建议派单后增加复核闸门降低二次转派`,
    });
  }
  if (metrics.sla_rate > 0 && metrics.sla_rate < 0.8) {
    decisions.push({
      scope: 'workflow',
      target: 'work_order:sla_tighten',
      recommendation: { action: 'tighten_sla_threshold', current_sla_rate: metrics.sla_rate },
      reason: `SLA 达成率=${metrics.sla_rate} 偏低，建议收紧 SLA 阈值或增加自动升级`,
    });
  }
  const topBottleneck = metrics.bottleneck?.[0];
  if (topBottleneck && topBottleneck.active >= 3) {
    decisions.push({
      scope: 'workflow',
      target: `${topBottleneck.entity_type}:auto_escalate`,
      recommendation: { action: 'enable_auto_escalation', active: topBottleneck.active },
      reason: `瓶颈模块 ${topBottleneck.entity_type} 活跃堆积=${topBottleneck.active}，建议启用自动升级`,
    });
  }
  return decisions;
}

/**
 * ⑦P2：由过程挖掘结果（⑦P0，飞轮"眼睛"）生成"数据驱动"的优化决策（模数共振·数据→模型方向）。
 * 与 generateOptimizations（消费粗粒度 processMetrics）互补，本函数消费精细挖掘结果：
 *   - 合规偏离率 > 0.3 → work_order:recheck_gate（派单后加复核，降变体发散）
 *   - 最慢直接后继边 > 8h（480 分）→ <entity>:auto_escalate（防该业务流堆积）
 * 产出的 target 与 applyRecommendationToDef 约定一致，故可被现有 applyWorkflowOptimizations 直接消费应用。
 * 纯函数，不碰 DB，可单测。
 */
export function generateMiningOptimizations(result: ProcessMiningResult): OptimizationDecision[] {
  const decisions: OptimizationDecision[] = [];
  const devRate = result.conformance?.deviation_rate ?? 0;
  if (devRate > 0.3) {
    decisions.push({
      scope: 'workflow',
      target: 'work_order:recheck_gate',
      recommendation: { trigger: 'deviation_rate>0.3', deviation_rate: devRate },
      reason: `主导路径依从偏离率=${(devRate * 100).toFixed(1)}% 偏高，建议派单后增加复核闸门降低变体发散`,
    });
  }
  const se = result.bottlenecks?.slowest_edge;
  if (se && typeof se.avg_minutes === 'number' && se.avg_minutes > 480) {
    decisions.push({
      scope: 'workflow',
      target: `${result.entity_type}:auto_escalate`,
      recommendation: { edge: [se.from, se.to], avg_minutes: se.avg_minutes },
      reason: `最慢转移 ${se.from}→${se.to}=${Math.round(se.avg_minutes)} 分 (>8h)，建议在该业务流启用自动升级防止堆积`,
    });
  }
  return decisions;
}

// ── 位置×类目高频重复告警（2026-09-06 任务③：C1 优化建议引擎新规则）──
// 规则：同一「位置×类目」在滚动 30 天内 ≥3 次同类报修 → 产出「建议巡检/根因排查」建议。
// 红线：只读 work_orders，不写状态、不自动派单、不自动升级优先级；产出走既有
//   optimization_feedback pending 建议通道（recordWorkflowRecommendations / /optimize/generate），
//   applyWorkflowOptimizations 对本 target 不做自动改流程（见 isAutoApplicableTarget 守卫）。
// 陪检/运送业务线（transport/escort 及类目名含陪检/护送/运送等）不参与本规则（另一条业务线）。
// 模型/阈值体系（CMAB/StatsModel/AUTO_TUNE）与本规则零交集——纯 SQL 聚合 + 纯函数分组。

export interface RepeatHotspotRow {
  location: string | null;
  catalog: string | null; // 类目 id（work_orders.catalog uuid）
  catalog_name?: string | null; // 类目展示名（LEFT JOIN fault_category 带出，可空）
  business_type?: string | null;
  created_at: string | Date;
}

export interface RepeatHotspot {
  location: string; // 归一化后位置（trim + 空白折叠；诚实口径=文本精确匹配，不做激进归一化）
  catalog: string;
  catalog_name: string | null;
  count: number;
}

export interface RepeatHotspotOpts {
  windowDays?: number; // 滚动窗口天数（缺省 30）
  minCount?: number; // 触发阈值（缺省 ≥3 次）
  now?: Date; // 可注入当前时间（单测滚动窗口边界用；缺省取系统时间）
}

export const REPEAT_HOTSPOT_DEFAULTS = { windowDays: 30, minCount: 3 } as const;

// 陪检/运送业务线排除词（business_type 与类目展示名 contains 匹配，大小写不敏感）
// 2026-09-06 任务⑦补充 '检查申请'：该词属陪检线词汇，补入后维修线排除集 L 与
// 陪检线命中集完全相等（互斥闭合：维修线排除的行 = 陪检线纳入的行，无交叠缝隙）。
export const REPEAT_HOTSPOT_EXCLUDED_KEYWORDS: readonly string[] = [
  '陪检', '护送', '运送', '转运', '转科', '检查申请', 'transport', 'escort',
];

/** 位置归一化：trim + 连续空白折叠为单空格（诚实口径：仅空白归一，文本精确匹配）。 */
export function normalizeLocationKey(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ');
}

function isExcludedBusinessLine(...texts: Array<string | null | undefined>): boolean {
  for (const t of texts) {
    if (!t) continue;
    const lower = t.toLowerCase();
    if (REPEAT_HOTSPOT_EXCLUDED_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) return true;
  }
  return false;
}

/**
 * 私有通用聚合：按 includeRow 谓词筛行后聚合「位置×类目」重复对。
 * 口径（维修线热点与陪检线运力走廊共用，保证同口径可比）：
 *  - 窗口 [now - windowDays, now]（含边界，created_at 毫秒比较）；
 *  - location/catalog 任一为空不成组（诚实留白，不臆造分组键）；
 *  - count ≥ minCount 才产出，按 count 降序、同数按位置字典序稳定排序。
 */
function groupHotspotsBy(
  rows: RepeatHotspotRow[],
  opts: RepeatHotspotOpts,
  includeRow: (r: RepeatHotspotRow) => boolean,
): RepeatHotspot[] {
  const windowDays = opts.windowDays ?? REPEAT_HOTSPOT_DEFAULTS.windowDays;
  const minCount = opts.minCount ?? REPEAT_HOTSPOT_DEFAULTS.minCount;
  const nowMs = (opts.now ?? new Date()).getTime();
  const windowStartMs = nowMs - windowDays * 864e5;
  const counts = new Map<string, RepeatHotspot>();
  for (const r of rows) {
    if (!includeRow(r)) continue;
    const locKey = normalizeLocationKey(r.location);
    const catKey = (r.catalog ?? '').trim();
    if (!locKey || !catKey) continue;
    const t = r.created_at instanceof Date ? r.created_at.getTime() : Date.parse(r.created_at);
    if (!Number.isFinite(t) || t < windowStartMs || t > nowMs) continue;
    const key = `${locKey}\u0001${catKey}`;
    const cur = counts.get(key);
    if (cur) cur.count++;
    else counts.set(key, { location: locKey, catalog: catKey, catalog_name: r.catalog_name ?? null, count: 1 });
  }
  return [...counts.values()]
    .filter((h) => h.count >= minCount)
    .sort((a, b) => b.count - a.count || a.location.localeCompare(b.location) || a.catalog.localeCompare(b.catalog));
}

/**
 * 纯函数（维修线）：滚动窗口内聚合「位置×类目」重复对（不碰 DB，可单测）。
 * 排除陪检/运送业务线（business_type 或类目名命中排除词表 REPEAT_HOTSPOT_EXCLUDED_KEYWORDS）。
 */
export function groupRepeatHotspots(rows: RepeatHotspotRow[], opts: RepeatHotspotOpts = {}): RepeatHotspot[] {
  return groupHotspotsBy(rows, opts, (r) => !isExcludedBusinessLine(r.business_type, r.catalog_name));
}

/** 纯函数：热点 → 优化建议（复用引擎既有 OptimizationDecision/pending 通道，每热点一条）。 */
export function generateRepeatHotspotOptimizations(
  hotspots: RepeatHotspot[],
  opts: RepeatHotspotOpts = {},
): OptimizationDecision[] {
  const windowDays = opts.windowDays ?? REPEAT_HOTSPOT_DEFAULTS.windowDays;
  const minCount = opts.minCount ?? REPEAT_HOTSPOT_DEFAULTS.minCount;
  return hotspots.map((h) => ({
    scope: 'workflow' as const,
    target: 'work_order:repeat_hotspot',
    recommendation: {
      action: 'inspect_root_cause',
      location: h.location,
      catalog: h.catalog,
      catalog_name: h.catalog_name,
      count: h.count,
      window_days: windowDays,
      min_count: minCount,
    },
    reason: `位置「${h.location}」×类目「${h.catalog_name ?? h.catalog}」近 ${windowDays} 天重复报修 ${h.count} 次（≥${minCount}），建议安排巡检/根因排查，而非继续被动接单`,
  }));
}

/**
 * 只读检测：拉取租户窗口内工单（location/catalog/类目名/业务线/创建时间）后走纯函数聚合。
 * RLS 纪律：client 须来自 withTenantClient（自动注入 tenant_id），SQL 仍显式 WHERE tenant_id=$1 双保险。
 * 只 SELECT，不写任何状态；cancelled 单也计入（重复报修行为本身即信号，口径诚实不做状态过滤）。
 */
export async function detectRepeatHotspots(
  client: PoolClient,
  tenantId: string,
  opts: RepeatHotspotOpts = {},
): Promise<RepeatHotspot[]> {
  const windowDays = opts.windowDays ?? REPEAT_HOTSPOT_DEFAULTS.windowDays;
  const r = await client.query<{
    location: string | null;
    catalog: string | null;
    catalog_name: string | null;
    business_type: string | null;
    created_at: Date;
  }>(
    `SELECT wo.location, wo.catalog, fc.name AS catalog_name, wo.business_type, wo.created_at
       FROM work_orders wo
       LEFT JOIN fault_category fc ON fc.id::text = wo.catalog AND fc.tenant_id = wo.tenant_id
      WHERE wo.tenant_id = $1 AND wo.created_at >= now() - ($2 || ' days')::interval`,
    [tenantId, String(windowDays)],
  );
  return groupRepeatHotspots(r.rows, opts);
}

// ── 陪检线运力走廊告警（2026-09-06 任务⑦：与维修线热点规则互斥的独立规则）──
// 语义差异：维修线热点=同一位置设备反复故障（巡检/根因排查）；陪检线走廊=同一位置×类目
//   运力需求重复堆积（运力不足信号），建议是运力调度（固定班次/常驻岗/合并派单），不是修设备。
// 互斥口径：本规则只纳入 business_type 或类目名命中 REPEAT_HOTSPOT_EXCLUDED_KEYWORDS 的工单
//   （维修线恰恰排除同一词表），两条规则的命中集互斥、无交叠。
// 红线：只读 work_orders，不写状态、不碰 model_state、不碰派单训练链路、不动 MODEL_AUTO_TUNE；
//   scope='transport' 落库映射为 workflow pending 建议，isAutoApplicableTarget 守卫永不放行
//   transport:repeat_corridor（绝不自动改流程/自动 applied）。

/**
 * 纯函数（陪检线）：滚动窗口内聚合「位置×类目」运力走廊对（不碰 DB，可单测）。
 * 与维修线共用同一分组口径（trim+空白折叠文本精确匹配、[now-30d, now] 含边界、count≥3、降序）。
 */
export function groupEscortCorridors(rows: RepeatHotspotRow[], opts: RepeatHotspotOpts = {}): RepeatHotspot[] {
  return groupHotspotsBy(rows, opts, (r) => isExcludedBusinessLine(r.business_type, r.catalog_name));
}

/** 纯函数：陪检走廊热点 → 优化建议（每热点一条，scope='transport'，语义=运力调度非故障维修）。 */
export function generateEscortCorridorOptimizations(
  hotspots: RepeatHotspot[],
  opts: RepeatHotspotOpts = {},
): OptimizationDecision[] {
  const windowDays = opts.windowDays ?? REPEAT_HOTSPOT_DEFAULTS.windowDays;
  const minCount = opts.minCount ?? REPEAT_HOTSPOT_DEFAULTS.minCount;
  return hotspots.map((h) => ({
    scope: 'transport' as const,
    target: 'transport:repeat_corridor',
    recommendation: {
      action: 'review_staffing',
      location: h.location,
      catalog: h.catalog,
      catalog_name: h.catalog_name,
      count: h.count,
      window_days: windowDays,
      min_count: minCount,
      suggestions: ['评估固定班次', '常驻陪检岗', '合并派单'],
    },
    reason: `位置「${h.location}」×类目「${h.catalog_name ?? h.catalog}」近 ${windowDays} 天陪检/运送类工单 ${h.count} 次（≥${minCount}），属运力走廊信号而非设备故障：建议评估固定班次/常驻陪检岗/合并派单，而非按维修根因排查`,
  }));
}

/**
 * 只读检测（陪检线）：拉取租户窗口内工单后走纯函数聚合，口径与 detectRepeatHotspots 完全一致
 * （同一份 SELECT，分组谓词不同），保证两条规则看到的数据面相同、仅业务线归属互斥。
 * RLS 纪律：client 须来自 withTenantClient（自动注入 tenant_id），SQL 仍显式 WHERE tenant_id=$1 双保险。
 */
export async function detectEscortHotspots(
  client: PoolClient,
  tenantId: string,
  opts: RepeatHotspotOpts = {},
): Promise<RepeatHotspot[]> {
  const windowDays = opts.windowDays ?? REPEAT_HOTSPOT_DEFAULTS.windowDays;
  const r = await client.query<{
    location: string | null;
    catalog: string | null;
    catalog_name: string | null;
    business_type: string | null;
    created_at: Date;
  }>(
    `SELECT wo.location, wo.catalog, fc.name AS catalog_name, wo.business_type, wo.created_at
       FROM work_orders wo
       LEFT JOIN fault_category fc ON fc.id::text = wo.catalog AND fc.tenant_id = wo.tenant_id
      WHERE wo.tenant_id = $1 AND wo.created_at >= now() - ($2 || ' days')::interval`,
    [tenantId, String(windowDays)],
  );
  return groupEscortCorridors(r.rows, opts);
}

/**
 * OptimizationDecision.scope → optimization_feedback.scope 的落库映射（DDL CHECK 兜底）。
 * optimization_feedback.scope 的 CHECK 约束只允许 ('dispatch','workflow')；transport 语义建议
 * 以 scope='workflow' 持久化（走 pending 建议通道），语义由 target='transport:*' 前缀保留，
 * 且 applyWorkflowOptimizations 的 isAutoApplicableTarget 守卫对 transport:* 永不放行 → 永不自动 applied。
 */
export function dbScopeFor(scope: OptimizationDecision['scope']): 'dispatch' | 'workflow' {
  return scope === 'dispatch' ? 'dispatch' : 'workflow';
}

/** applyWorkflowOptimizations 的自动改流程守卫：仅认识这三类 target，其余（如 repeat_hotspot）跳过不应用。 */
export function isAutoApplicableTarget(target: string): boolean {
  return (
    target === 'work_order:recheck_gate' ||
    target === 'work_order:sla_tighten' ||
    target.endsWith(':auto_escalate')
  );
}

/** 读模型参数（model_state）。无则返回 null。 */
export async function getModelParams(
  client: PoolClient,
  tenantId: string,
  modelKey = 'dispatch_score',
): Promise<ModelParams | null> {
  const r = await client.query(
    'SELECT params FROM model_state WHERE tenant_id = $1 AND model_key = $2',
    [tenantId, modelKey],
  );
  const raw = r.rows[0]?.params;
  if (!raw) return null;
  return safeParseJsonb(raw) as ModelParams;
}

/** 把 dispatch 类决策写回 dispatch_rule.weight（保持 T-A AUTO_TUNE 行为），并写审计行。 */
export async function applyDispatchOptimizations(
  client: PoolClient,
  tenantId: string,
  decisions: OptimizationDecision[],
): Promise<void> {
  const dispatchDecisions = decisions.filter((d) => d.scope === 'dispatch');
  for (const d of dispatchDecisions) {
    const businessType = String(d.recommendation.business_type ?? '');
    const newWeight = Number(d.recommendation.new_weight ?? WEIGHT_MIN);
    const up = await client.query(
      `UPDATE dispatch_rule SET weight = $1 WHERE tenant_id = $2 AND match_json->>'business_type' = $3`,
      [newWeight, tenantId, businessType],
    );
    const status = (up.rowCount ?? 0) > 0 ? 'applied' : 'no_match';
    await client.query(
      `INSERT INTO optimization_feedback (tenant_id, scope, target, recommendation, reason, status, applied_at)
       VALUES ($1, 'dispatch', $2, $3, $4, $5, now())`,
      [tenantId, d.target, JSON.stringify(d.recommendation), d.reason, status],
    );
  }
}

/** 把 workflow 类决策作为 pending 建议落库，待 T-① 引擎消费应用。
 *  2026-09-06 任务⑦：同时收运力走廊（scope='transport'）建议——落库映射为 workflow pending，
 *  守卫（isAutoApplicableTarget）永不放行 transport:* target，只会保持 pending 留给人工消费。 */
export async function recordWorkflowRecommendations(
  client: PoolClient,
  tenantId: string,
  decisions: OptimizationDecision[],
): Promise<void> {
  const wf = decisions.filter((d) => d.scope !== 'dispatch');
  for (const d of wf) {
    await client.query(
      `INSERT INTO optimization_feedback (tenant_id, scope, target, recommendation, reason, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [tenantId, dbScopeFor(d.scope), d.target, JSON.stringify(d.recommendation), d.reason],
    );
  }
}

/**
 * 纯函数：把一条 workflow 优化建议应用到状态图 def 上，返回新的 def（不可变）。
 * 支持 C1 当前产出的三类建议：
 *  - work_order:recheck_gate   → 在 assigned 后插入 recheck 状态与转移（降二次转派）
 *  - work_order:sla_tighten    → 在 config 收紧 SLA 目标阈值（落配置，供 sla 计算消费）
 *  - <entity>:auto_escalate    → 增加 escalated 终态与 processing->escalated 转移
 * 重复应用幂等（状态/转移已存在则跳过）。
 */
export function applyRecommendationToDef(def: WorkflowDef, decision: OptimizationDecision): WorkflowDef {
  const next: WorkflowDef = {
    initial: def.initial,
    states: [...def.states],
    transitions: def.transitions.map((t) => ({ ...t })),
    config: { ...(def.config ?? {}) },
  };
  const hasState = (s: string) => next.states.includes(s);
  const addState = (s: string) => { if (!hasState(s)) next.states.push(s); };
  const hasTransition = (from: string, to: string, event: string) =>
    next.transitions.some((t) => t.from === from && t.to === to && t.event === event);
  const addTransition = (from: string, to: string, event: string) => {
    if (!hasTransition(from, to, event)) next.transitions.push({ from, to, event });
  };

  if (decision.target === 'work_order:recheck_gate') {
    addState('recheck');
    addTransition('assigned', 'recheck', 'recheck_open');
    addTransition('recheck', 'processing', 'recheck_pass');
  } else if (decision.target === 'work_order:sla_tighten') {
    const cur = Number(decision.recommendation.current_sla_rate ?? 0);
    next.config = {
      ...next.config,
      sla_tighten: true,
      current_sla_rate: cur,
      target_sla_rate: Number(Math.min(0.95, Math.max(0.8, cur * 1.1)).toFixed(2)),
    };
  } else if (decision.target.endsWith(':auto_escalate')) {
    addState('escalated');
    addTransition('processing', 'escalated', 'auto_escalate');
    next.config = { ...next.config, auto_escalate: true };
  }
  return next;
}

/**
 * 消费 optimization_feedback 中 workflow 类 pending 建议，改写对应 workflow_def 并置 applied。
 * 由路由在 AUTO_TUNE=true（或显式 apply-workflow）下调用，避免试点误改流程定义。
 */
export async function applyWorkflowOptimizations(
  client: PoolClient,
  tenantId: string,
): Promise<{ applied: number; targets: string[]; skipped: string[] }> {
  const rows = await client.query<{ id: string; target: string; recommendation: unknown }>(
    `SELECT id, target, recommendation FROM optimization_feedback
     WHERE tenant_id = $1 AND scope = 'workflow' AND status = 'pending'`,
    [tenantId],
  );
  let applied = 0;
  const targets: string[] = [];
  const skipped: string[] = [];
  for (const row of rows.rows) {
    // 守卫（2026-09-06 任务③）：只自动改流程本引擎认识的 target；不认识的（如
    // work_order:repeat_hotspot 巡检/根因排查建议）保持 pending 留给人工消费，
    // 绝不标记 applied 造成「建议被静默吞掉」的假闭环。
    if (!isAutoApplicableTarget(row.target)) {
      skipped.push(row.target);
      continue;
    }
    const entityType = row.target.split(':')[0];
    const def = await ensureWorkflowDef(client, tenantId, entityType);
    const decision: OptimizationDecision = {
      scope: 'workflow',
      target: row.target,
      recommendation: safeParseJsonb(row.recommendation) ?? {},
      reason: '',
    };
    const newDef = applyRecommendationToDef(def, decision);
    await saveWorkflowDef(client, tenantId, entityType, newDef);
    await client.query(
      `UPDATE optimization_feedback SET status = 'applied', applied_at = now() WHERE id = $1`,
      [row.id],
    );
    applied++;
    targets.push(row.target);
  }
  return { applied, targets, skipped };
}
