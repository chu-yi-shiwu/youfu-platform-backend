// 增量学习服务（A3）：消费 ticket_event → 计算奖励 → 更新 model_state 权重（派单自适应闭环的数据反训）。
//
// 纯函数 computeRewards 可单测；trainFromDb / incrementalLearn 负责 DB 读写。
// 本地若无 PG，DB 路径不会被执行（符合 migrate.ts 约定"结构已审，待 PG 就绪执行"）。
import type { PoolClient } from 'pg';
import { StatsModelBackend, type ModelBackend, type ModelParams } from '../engine/model/ModelBackend.js';
import { generateOptimizations, applyDispatchOptimizations } from './optimizer.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { doneStates } from '../engine/stateMachine.js';

/** pg 驱动对 jsonb 可能返回字符串或已解析对象；统一归一化（T-A 缺陷2修复）。 */
function safeParsePayload(p: any): any {
  if (p == null) return p;
  if (typeof p === 'string') {
    try { return JSON.parse(p); } catch { return p; }
  }
  return p;
}

export interface TicketEventRow {
  type: string;
  to_status: string | null;
  actor: string | null;
  payload: any;
  created_at: string;
}

export interface RewardSignal {
  category: string; // 由调用方补全（work_orders.business_type）
  workerId: string;
  reward: number;
}

// 纯函数：从单个工单的事件序列计算奖励信号（可单测）。
// 规则：
//  - 无 assign 事件（无派单）：空
//  - 超时升级（sla_escalated）：reward = -1
//  - 发生过转派（assign >= 2 次）：reward = -0.5（派单需优化）
//  - 一次派单即完成：reward = +1（派对了）
//  - 满意度信号（飞轮断链 1 修复）：satisfaction_score 1-5 → sat_bonus=(score-3)/2，
//    叠加到【最终 assign】的 reward（当前工人表现决定满意度：5 分+1 / 4 分+0.5 / 3 分 0 / 2 分-0.5 / 1 分-1）
export function computeRewards(events: TicketEventRow[], satisfactionScore?: number | null): RewardSignal[] {
  const normalized = events.map((e) => ({ ...e, payload: safeParsePayload(e.payload) }));
  const assigns = normalized.filter((e) => e.type === 'assign' && e.payload?.worker_id);
  if (assigns.length === 0) return [];
  const escalated = normalized.some((e) => e.type === 'sla_escalated');
  const reassigned = assigns.length >= 2;
  const satBonus =
    typeof satisfactionScore === 'number' && satisfactionScore >= 1 && satisfactionScore <= 5
      ? (satisfactionScore - 3) / 2
      : 0;
  return assigns.map((a, i) => ({
    category: '', // 由调用方补全
    workerId: String(a.payload.worker_id),
    reward: (escalated ? -1 : reassigned ? -0.5 : 1) + (i === assigns.length - 1 ? satBonus : 0),
  }));
}

/** 增量学习（单工单完成即触发）：读该工单事件 → 算奖励 → 更新模型 → 存回 model_state。
 *  AUTO_TUNE 开启时把学习权重写回 dispatch_rule.weight（配置=模型 surface）。 */
export async function incrementalLearn(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  autoTune = false,
  modelKey = 'dispatch_score',
): Promise<void> {
  const o = await client.query<{ business_type: string; satisfaction_score: number | null }>(
    'SELECT business_type, satisfaction_score FROM work_orders WHERE tenant_id = $1 AND id = $2',
    [tenantId, workOrderId],
  );
  const ev = await client.query<TicketEventRow>(
    `SELECT type, to_status, actor, payload, created_at
     FROM ticket_event WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at ASC`,
    [tenantId, workOrderId],
  );
  // C2 数据质量 gate（n3 封死）：无 business_type 无法归因 → 不喂模型，避免污染模型臂
  if (!o.rows[0]?.business_type) return;
  const rewards = computeRewards(ev.rows, o.rows[0]?.satisfaction_score).map((r) => ({
    ...r,
    category: o.rows[0]?.business_type ?? '',
  }));
  if (rewards.length === 0) return;

  const cur = await client.query<{ params: any }>(
    'SELECT params FROM model_state WHERE tenant_id = $1 AND model_key = $2',
    [tenantId, modelKey],
  );
  const raw = cur.rows[0]?.params;
  const loaded = typeof raw === 'string' ? safeParsePayload(raw) : raw;
  const model = new StatsModelBackend(loaded ?? undefined);
  for (const r of rewards) model.learn(r.category, r.workerId, r.reward);
  const params: ModelParams = model.toParams();

  await client.query(
    `INSERT INTO model_state (tenant_id, model_key, version, params, trained_at, updated_at)
     VALUES ($1,$2,$3,$4,now(),now())
     ON CONFLICT (tenant_id, model_key)
     DO UPDATE SET version = model_state.version + 1, params = $4, trained_at = now(), updated_at = now()`,
    [tenantId, modelKey, params.version + 1, JSON.stringify(params)],
  );

  if (autoTune) {
    // C1：走统一优化层写回（保持 T-A 行为：new_weight=max(0.1, arm.weight)）+ 审计落库
    const decisions = generateOptimizations(params, {
      tenant_id: tenantId, total: 0, dispatch_hit_rate: 0, reassign_rate: 0,
      sla_rate: 0, sla_note: '', duration_buckets: { lt_1h: 0, h1_4: 0, h4_24: 0, gt_24h: 0 }, bottleneck: [],
    });
    await applyDispatchOptimizations(client, tenantId, decisions);
  }
}

/** 全量重训练（定时/手动触发）：扫近 N 条已完成工单，重算模型并持久化。
 *  A5 自适应写回受 autoTune 开关控制。 */
export async function trainFromDb(
  client: PoolClient,
  tenantId: string,
  modelKey = 'dispatch_score',
  autoTune = false,
): Promise<ModelBackend> {
  const cur = await client.query<{ params: any }>(
    'SELECT params FROM model_state WHERE tenant_id = $1 AND model_key = $2',
    [tenantId, modelKey],
  );
  const raw = cur.rows[0]?.params;
  const loaded = typeof raw === 'string' ? safeParsePayload(raw) : raw;
  const model = new StatsModelBackend(loaded ?? undefined);

  // A+ Phase1.5：训练样本取"完成态"工单（def 派生：DEFAULT=completed；RICH=completed/closed/evaluated），
  // 富模板下不漏训 closed/evaluated，且不把 cancelled 当完成样本喂模型。
  const def = await getWorkflowDef(client, tenantId, 'work_order');
  const done = doneStates(def);
  const orders = await client.query<{ id: string; business_type: string; satisfaction_score: number | null }>(
    `SELECT id, business_type, satisfaction_score FROM work_orders
     WHERE tenant_id = $1 AND status = ANY($2::text[])
     ORDER BY updated_at DESC LIMIT 200`,
    [tenantId, done],
  );
  for (const o of orders.rows) {
    if (!o.business_type) continue; // C2 n3 封死：无 business_type 不喂模型
    const ev = await client.query<TicketEventRow>(
      `SELECT type, to_status, actor, payload, created_at
       FROM ticket_event WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at ASC`,
      [tenantId, o.id],
    );
    const rewards = computeRewards(ev.rows, o.satisfaction_score).map((r) => ({ ...r, category: o.business_type }));
    for (const r of rewards) model.learn(r.category, r.workerId, r.reward);
  }

  const params: ModelParams = model.toParams();
  await client.query(
    `INSERT INTO model_state (tenant_id, model_key, version, params, trained_at, updated_at)
     VALUES ($1,$2,$3,$4,now(),now())
     ON CONFLICT (tenant_id, model_key)
     DO UPDATE SET version = model_state.version + 1, params = $4, trained_at = now(), updated_at = now()`,
    [tenantId, modelKey, params.version + 1, JSON.stringify(params)],
  );

  if (autoTune) {
    // C1：走统一优化层写回（保持 T-A 行为）+ 审计落库
    const decisions = generateOptimizations(params, {
      tenant_id: tenantId, total: 0, dispatch_hit_rate: 0, reassign_rate: 0,
      sla_rate: 0, sla_note: '', duration_buckets: { lt_1h: 0, h1_4: 0, h4_24: 0, gt_24h: 0 }, bottleneck: [],
    });
    await applyDispatchOptimizations(client, tenantId, decisions);
  }
  return model;
}
