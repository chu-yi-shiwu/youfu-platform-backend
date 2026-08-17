// 工单仓储：所有 SQL 在已注入 tenant_id 的 client 内执行（RLS 自动隔离）。
// 双保险：每条读/写显式 WHERE tenant_id = $1（P1）。
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { isKnownState, type WorkOrderStatus, type WorkflowTransition } from '../engine/stateMachine.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { emitDomainEvent } from '../db/eventBus.js';

export interface CreateDto {
  id: string;
  tenantId: string;
  businessType: string;
  catalog?: string;
  priority?: string;
  location?: string;
  title?: string;
  description?: string;
  contact?: string;
  reporterName?: string; // P1 收尾：申告人真实姓名（顶层列，独立于 ext 动态字段）
  assets?: unknown[];
  // UOne 颗粒度维度（取之所长）
  source?: string;        // 工单来源: wechat/backend/phone
  faultType?: string;     // 故障类型
  serviceDesk?: string;   // 所属服务台
  department?: string;    // 归属部门（部门级抢单维度）
  ext?: Record<string, unknown>; // 工单模板动态字段
  idempotencyKey?: string;
}

export interface WorkOrderRow {
  id: string;
  tenant_id: string;
  order_no: string;        // 业务工单号（DEF-1/DEF-2 修复：真实可读工单号，非成功码）
  business_type: string;
  catalog: string | null;
  priority: string;
  location: string | null;
  title: string | null;
  description: string | null;
  contact: string | null;
  reporter_name?: string | null;
  status: WorkOrderStatus;
  assignee_id: string | null;
  auto_flow: boolean;
  assets: unknown;
  source?: string;
  fault_type?: string | null;
  service_desk?: string | null;
  department?: string | null;
  satisfaction_score?: number | null;
  ext?: unknown;
  created_at: string;
  updated_at: string;
}

/** 生成业务工单号：WO_YYYYMMDD_随机6位（同日不保证严格唯一，由唯一约束兜底）。 */
function genOrderNo(d: Date = new Date()): string {
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `WO_${ymd}_${rand}`;
}

/** 幂等创建：幂等键命中则返回原工单，否则插入 + 写幂等键 + 审计。 */
export async function createWithIdem(
  client: PoolClient,
  dto: CreateDto,
): Promise<{ row: WorkOrderRow; created: boolean }> {
  if (dto.idempotencyKey) {
    const hit = await client.query<{ work_order_id: string }>(
      'SELECT work_order_id FROM idempotency_key WHERE key = $1 AND tenant_id = $2',
      [dto.idempotencyKey, dto.tenantId],
    );
    if (hit.rows[0]?.work_order_id) {
      const existing = await findOne(client, dto.tenantId, hit.rows[0].work_order_id);
      if (existing) return { row: existing, created: false };
    }
  }
  const orderNo = genOrderNo();
  const ins = await client.query<WorkOrderRow>(
    `INSERT INTO work_orders
       (id, tenant_id, order_no, business_type, catalog, priority, location, title, description, contact, reporter_name, assets, status, source, fault_type, service_desk, department, ext)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      dto.id, dto.tenantId, orderNo, dto.businessType, dto.catalog ?? null, dto.priority ?? 'normal',
      dto.location ?? null, dto.title ?? null, dto.description ?? null, dto.contact ?? null,
      dto.reporterName ?? null,
      JSON.stringify(dto.assets ?? []),
      dto.source ?? 'backend', dto.faultType ?? null, dto.serviceDesk ?? null, dto.department ?? null,
      JSON.stringify(dto.ext ?? {}),
    ],
  );
  if (dto.idempotencyKey) {
    await client.query(
      'INSERT INTO idempotency_key (key, tenant_id, work_order_id) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING',
      [dto.idempotencyKey, dto.tenantId, dto.id],
    );
  }
  await client.query(
    `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor)
     VALUES ($1,$2,'create',NULL,'draft','system')`,
    [dto.tenantId, dto.id],
  );
  await emitDomainEvent(client, { tenantId: dto.tenantId, entityType: 'work_order', entityId: dto.id, type: 'create', actor: 'system' });
  return { row: ins.rows[0], created: true };
}

export interface TransitionResult {
  row: WorkOrderRow;
  transition: WorkflowTransition | null;
  /** 更新前的状态（锁内读取，权威）。供调用方做"首次进入触发态"等判定，避免事务外快照并发双触发。 */
  from: string;
}

/** 状态流转：校验合法跳转（拓扑 + 角色门禁 + 必填），更新状态 + 审计 + 副作用。 */
export async function transition(
  client: PoolClient,
  tenantId: string,
  id: string,
  to: WorkOrderStatus,
  opts?: { actor?: string; role?: string; fields?: Record<string, unknown> },
): Promise<TransitionResult> {
  // 行锁：并发流转同一工单时串行化（A 提交释放锁后 B 才拿到锁，此时 cur.status 为最新），
  // 同时让下方"首次进入触发态"判定基于锁内权威快照，杜绝 READ COMMITTED 下双触发增量学习。
  const cur = await findOneForUpdate(client, tenantId, id);
  if (!cur) throw new AppError('NOT_FOUND', 'work order not found', 404);
  // T-①：状态合法性由 workflow_def（可配置状态机）校验，不再写死固定字典
  const def = await getWorkflowDef(client, tenantId, 'work_order');
  if (!isKnownState(def, cur.status) || !isKnownState(def, to)) {
    throw new AppError('CONFLICT', `unknown state: from=${cur.status} to=${to}`, 422);
  }
  // 匹配具体 transition（含规则），拓扑非法直接 422
  const tdef = def.transitions.find((t) => t.from === cur.status && t.to === to) ?? null;
  if (!tdef) {
    throw new AppError('CONFLICT', `illegal transition ${cur.status} -> ${to}`, 422);
  }
  // A+ 角色门禁：allowedRoles 为空/未定义 = 放行（向后兼容，避免门死自己）；显式配置且不在其中 → 403
  const role = opts?.role;
  if (tdef.allowedRoles && tdef.allowedRoles.length > 0 && role && !tdef.allowedRoles.includes(role)) {
    throw new AppError('FORBIDDEN', `role ${role} not allowed for ${cur.status}->${to}`, 403);
  }
  // A+ 必填校验：缺失任一 requiredFields → 422
  const fields = opts?.fields ?? {};
  if (tdef.requiredFields && tdef.requiredFields.length > 0) {
    const missing = tdef.requiredFields.filter(
      (f) => fields[f] === undefined || fields[f] === null || fields[f] === '',
    );
    if (missing.length > 0) {
      throw new AppError('BAD_REQUEST', `missing required fields: ${missing.join(',')}`, 422);
    }
  }
  // A+：若流转携带 assignee（dispatch 等需必填 assignee 的转移），同步落库 assignee_id，使人工派单真正生效。
  const assignee = typeof fields.assignee === 'string' && fields.assignee ? fields.assignee : null;
  const upd = await client.query<WorkOrderRow>(
    `UPDATE work_orders SET status = $1, updated_at = now()${assignee ? ', assignee_id = $4' : ''} WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    assignee ? [to, id, tenantId, assignee] : [to, id, tenantId],
  );
  await client.query(
    `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
     VALUES ($1,$2,'transition',$3,$4,$5,$6)`,
    [tenantId, id, cur.status, to, opts?.actor ?? 'system', JSON.stringify({ fields, transition_event: tdef.event })],
  );
  // ④ 真实事件总线：每次状态流转自动记账到 domain_event（type=新状态=过程挖掘活动节点）。
  await emitDomainEvent(client, {
    tenantId,
    entityType: 'work_order',
    entityId: id,
    type: to,
    actor: opts?.actor ?? 'system',
    payload: { from_status: cur.status, to_status: to, transition_event: tdef.event },
  });
  // A+ 副作用：SLA 暂停/恢复（真实落库，可断言）；notify_* 记录 domain_event（无短信网关，诚实标注 logged-not-delivered）
  const se = tdef.sideEffects ?? [];
  if (se.includes('pause_sla')) {
    await client.query('UPDATE work_orders SET sla_paused_at = now() WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  } else if (se.includes('resume_sla')) {
    await client.query('UPDATE work_orders SET sla_paused_at = NULL WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  }
  if (se.some((x) => x.startsWith('notify_'))) {
    await emitDomainEvent(client, {
      tenantId, entityType: 'work_order', entityId: id, type: 'notify', actor: opts?.actor ?? 'system',
      payload: { sideEffects: se.filter((x) => x.startsWith('notify_')) },
    });
  }
  return { row: upd.rows[0], transition: tdef, from: cur.status };
}

export async function findOne(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<WorkOrderRow | null> {
  const r = await client.query<WorkOrderRow>(
    'SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
  return r.rows[0] ?? null;
}

/** 带行锁读取单个工单，用于状态流转等需串行化的写前读取（FOR UPDATE）。 */
export async function findOneForUpdate(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<WorkOrderRow | null> {
  const r = await client.query<WorkOrderRow>(
    'SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [id, tenantId],
  );
  return r.rows[0] ?? null;
}

export async function list(
  client: PoolClient,
  tenantId: string,
  filter: { status?: WorkOrderStatus; limit?: number; offset?: number },
): Promise<{ items: WorkOrderRow[]; total: number }> {
  const conds = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (filter.status) {
    params.push(filter.status);
    conds.push(`status = $${params.length}`);
  }
  const where = conds.join(' AND ');
  const totalR = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM work_orders WHERE ${where}`,
    params,
  );
  const limit = filter.limit ?? 20;
  const offset = filter.offset ?? 0;
  const listR = await client.query<WorkOrderRow>(
    `SELECT * FROM work_orders WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { items: listR.rows, total: Number(totalR.rows[0].c) };
}
