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
  scope: 'dispatch' | 'workflow';
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

/** 把 workflow 类决策作为 pending 建议落库，待 T-① 引擎消费应用。 */
export async function recordWorkflowRecommendations(
  client: PoolClient,
  tenantId: string,
  decisions: OptimizationDecision[],
): Promise<void> {
  const wf = decisions.filter((d) => d.scope === 'workflow');
  for (const d of wf) {
    await client.query(
      `INSERT INTO optimization_feedback (tenant_id, scope, target, recommendation, reason, status)
       VALUES ($1, 'workflow', $2, $3, $4, 'pending')`,
      [tenantId, d.target, JSON.stringify(d.recommendation), d.reason],
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
): Promise<{ applied: number; targets: string[] }> {
  const rows = await client.query<{ id: string; target: string; recommendation: unknown }>(
    `SELECT id, target, recommendation FROM optimization_feedback
     WHERE tenant_id = $1 AND scope = 'workflow' AND status = 'pending'`,
    [tenantId],
  );
  let applied = 0;
  const targets: string[] = [];
  for (const row of rows.rows) {
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
  return { applied, targets };
}
