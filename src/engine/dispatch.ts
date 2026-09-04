// 自动派单引擎。
// 两条路径（批次 A 新增可配置规则 + 保留 M1-M3 已验证的 least_load 兜底）：
//  1) resolveDispatch：按 dispatch_rule 配置表匹配（运营可在管理端自助配置）。
//  2) pickWorker：无规则命中时的 least_load 兜底，保证向后兼容、不破坏已验证行为。
// 红线：本模块只做"选人"，绝不推进工单到 completed（P6）。
import type { PoolClient } from 'pg';
import type { ModelBackend } from './model/ModelBackend.js';
import { safeParseJsonb } from '../util/jsonb.js';

export interface WorkerRow {
  id: string;
  skill_tags: string[];
  load: number;
  active: boolean;
}

// 注意：match/strategy/need 的字段名与 DB 存储(jsonb)、前端表单、路由层保持
// 一致的 snake_case（business_type / skill_tags），避免隐性契约错位导致规则失配。
export interface DispatchRule {
  id: string;
  name: string;
  priority: number;
  match: { business_type?: string; skill_tags?: string[]; priority?: string };
  strategy: { type: 'skill_match' | 'load_balance'; skill_tags?: string[] };
  weight?: number; // 模型学习权重（自适应写回 surface），默认 1
  score?: number; // 模型对该规则的整体评分，默认 0
}

export interface Need {
  business_type?: string;
  skill_tags?: string[];
  priority?: string;
}

// 纯函数：least_load 兜底选人（active + 技能全命中 + 负载最低）
export function pickWorker(
  workers: WorkerRow[],
  need: { skillTags?: string[] },
): WorkerRow | null {
  const required = need.skillTags ?? [];
  const matched = workers.filter(
    (w) => w.active && required.every((t) => w.skill_tags.includes(t)),
  );
  if (matched.length === 0) return null;
  // least_load：负载最低的优先（[...] 避免原地排序污染入参）
  return [...matched].sort((a, b) => a.load - b.load)[0];
}

// 纯函数：规则是否命中 need（AND 语义；未填的匹配维度视为通配）
export function matchRule(rule: DispatchRule, need: Need): boolean {
  const m = rule.match ?? {};
  if (m.business_type && m.business_type !== need.business_type) return false;
  if (m.priority && m.priority !== need.priority) return false;
  if (m.skill_tags && m.skill_tags.length > 0) {
    const needTags = need.skill_tags ?? [];
    if (!m.skill_tags.every((t) => needTags.includes(t))) return false;
  }
  return true;
}

// 纯函数：按优先级降序遍历规则；命中后用模型评分（若提供）对候选排序，否则 least_load 兜底；全不命中返回 null
export function resolveDispatch(
  workers: WorkerRow[],
  rules: DispatchRule[],
  need: Need,
  model?: ModelBackend,
): { worker: WorkerRow; ruleId: string; reason: string } | null {
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const rule of sorted) {
    if (!matchRule(rule, need)) continue;
    const needTags = rule.strategy?.skill_tags ?? need.skill_tags ?? [];
    const candidates = workers.filter(
      (w) => w.active && needTags.every((t) => w.skill_tags.includes(t)),
    );
    if (candidates.length === 0) continue;
    // 模型评分排序（分 = 规则权 × 模型分）；未提供模型则 least_load 兜底（向后兼容）
    const picked = model
      ? rankByModel(candidates, rule, need.business_type ?? '', model)
      : [...candidates].sort((a, b) => a.load - b.load)[0];
    if (picked) {
      return {
        worker: picked,
        ruleId: rule.id,
        reason: `auto dispatched by rule "${rule.name}"${model ? ' (model-scored)' : ''}`,
      };
    }
  }
  return null;
}

// 纯函数：按 规则权 × 模型分 × 负载因子 降序返回最优候选（上下文 bandit 选臂）。
// AL-004 修复（2026-09-04）：此前评分只有 规则权 × 模型分，worker.load 完全不参与——
// load_balance 类规则在有模型时退化为纯 bandit 排序（load=9 可胜过 load=8 的正主）。
// 负载因子 1/(1+load)：load=0 → 因子 1.0（空闲工人最大倾斜），负载越高折损越大；
// 模型分在同负载带内决定质量序，负载差决定公平序。Math.max(0,·) 防脏数据负负载。
function rankByModel(
  candidates: WorkerRow[],
  rule: DispatchRule,
  category: string,
  model: ModelBackend,
): WorkerRow {
  return candidates
    .map((w) => ({
      w,
      s: ((rule.weight ?? 1) * model.score({ category, workerId: w.id })) / (1 + Math.max(0, w.load)),
    }))
    .sort((a, b) => b.s - a.s)[0].w;
}

// DB 读取：租户内启用规则按优先级降序（与 schema 008 对齐）
export async function getActiveRules(
  client: PoolClient,
  tenantId: string,
): Promise<DispatchRule[]> {
  const r = await client.query<{
    id: string;
    name: string;
    priority: number;
    match_json: any;
    strategy_json: any;
    weight: number;
    score: number;
  }>(
    `SELECT id, name, priority, match_json, strategy_json, weight, score
     FROM dispatch_rule WHERE tenant_id = $1 AND enabled = true
     ORDER BY priority DESC, created_at ASC`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    priority: row.priority,
    match: (safeParseJsonb(row.match_json) ?? {}) as DispatchRule['match'],
    strategy: (safeParseJsonb(row.strategy_json) ?? { type: 'load_balance' }) as DispatchRule['strategy'],
    weight: row.weight ?? 1,
    score: row.score ?? 0,
  }));
}
