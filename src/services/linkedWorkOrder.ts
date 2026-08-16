// 共享服务：一键把"巡检异常 / 网管异常"转换为一条标准维修工单，进入既有派单流程。
// 设计要点：
//  - 复用 repo.createWithIdem（含 order_no 生成、SLA、初始事件、幂等键），不裸 INSERT，避免漏字段/绕过契约。
//  - 幂等键 linked:<sourceType>:<sourceId>：同一来源记录重复点"生成工单"只会建一次，防重单（真实需求）。
//  - 自动派单逻辑与 workOrder.ts 创建接口完全一致（优先 dispatch_rule，无命中降级 least_load），
//    保持 M1-M3 已验证行为，不破坏既有工单生命周期。
//  - 不改动已验证的 workOrder.ts；本文件为增量新增。
import type { PoolClient } from 'pg';
import { createWithIdem } from '../repo/ticket.js';
import { pickWorker, resolveDispatch, getActiveRules } from '../engine/dispatch.js';
import { autoRouteFor } from '../engine/stateMachine.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { setSlaDueAt } from '../engine/sla.js';

export interface LinkedWoPayload {
  id: string;
  tenantId: string;
  businessType: string;
  catalog?: string;
  priority?: 'normal' | 'urgent';
  location?: string;
  title?: string;
  description?: string;
  contact?: string;
  assets?: unknown[];
  skillTags?: string[];
  sourceType: string; // 'inspection' | 'monitor'
  sourceId: string; // 来源记录 id（用于幂等键）
}

export interface LinkedWoResult {
  id: string;
  orderNo: string;
  autoFlow: boolean;
  assignee: string | null;
  reason: string;
  created: boolean;
}

export async function createLinkedWorkOrder(
  client: PoolClient,
  p: LinkedWoPayload,
): Promise<LinkedWoResult> {
  const idemKey = `linked:${p.sourceType}:${p.sourceId}`;
  const { row, created } = await createWithIdem(client, {
    id: p.id,
    tenantId: p.tenantId,
    businessType: p.businessType,
    catalog: p.catalog,
    priority: p.priority,
    location: p.location,
    title: p.title,
    description: p.description,
    contact: p.contact,
    assets: p.assets,
    idempotencyKey: idemKey,
  });
  // 已转过：直接返回原工单，不重复建单
  if (!created) {
    return {
      id: row.id,
      orderNo: row.order_no,
      autoFlow: row.auto_flow,
      assignee: row.assignee_id,
      reason: 'already converted',
      created: false,
    };
  }
  // 建单即起算 SLA（与 workOrder.ts 一致）
  const sla = setSlaDueAt(p.catalog, p.priority);
  await client.query(
    'UPDATE work_orders SET sla_minutes = $1, sla_due_at = $2 WHERE id = $3',
    [sla.slaMinutes, sla.dueAt, row.id],
  );
  // 自动派单：优先 dispatch_rule，无命中降级 least_load（与 workOrder.ts 一致）
  const workers = await client.query(
    'SELECT id, skill_tags, load, active FROM worker WHERE tenant_id = $1',
    [p.tenantId],
  );
  const need = {
    business_type: p.businessType,
    skill_tags: p.skillTags,
    priority: p.priority,
  };
  const rules = await getActiveRules(client, p.tenantId);
  // ④⑤ 模数共振：读 workflow_def.autoRoutes，决定本租户自动派发的目标态与策略（缺省保持旧行为：落 assigned、规则优先）
  const def = await getWorkflowDef(client, p.tenantId, 'work_order');
  const initial = def.initial;
  const route = autoRouteFor(def, initial);
  const dispatchTarget = route?.to ?? 'assigned';
  const useLeastLoadOnly = route?.strategy === 'least_load';
  const resolved = useLeastLoadOnly ? null : resolveDispatch(workers.rows, rules, need);
  const picked = resolved ? resolved.worker : pickWorker(workers.rows, { skillTags: p.skillTags });
  let autoFlow = false;
  let assignee: string | null = null;
  let reason = 'manual claim required';
  if (picked) {
    autoFlow = true;
    assignee = picked.id;
    reason = resolved ? resolved.reason : 'auto dispatched by least_load fallback';
    await client.query(
      'UPDATE work_orders SET status = $1, assignee_id = $2, auto_flow = true, updated_at = now() WHERE id = $3',
      [dispatchTarget, picked.id, row.id],
    );
    await client.query('UPDATE worker SET load = load + 1 WHERE id = $1', [picked.id]);
    await client.query(
      `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
       VALUES ($1,$2,'assign',$3,$4,'auto_dispatch',$5)`,
      [p.tenantId, row.id, initial, dispatchTarget, JSON.stringify({ worker_id: picked.id })],
    );
  }
  return { id: row.id, orderNo: row.order_no, autoFlow, assignee, reason, created: true };
}
