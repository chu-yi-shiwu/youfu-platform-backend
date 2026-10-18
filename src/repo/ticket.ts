// 工单仓储：所有 SQL 在已注入 tenant_id 的 client 内执行（RLS 自动隔离）。
// 双保险：每条读/写显式 WHERE tenant_id = $1（P1）。
import type { PoolClient } from 'pg';
import { randomBytes } from 'crypto';
import { AppError } from '../middleware/error.js';
import { listPerms } from '../middleware/role.js';
import type { AuthLocals } from '../middleware/auth.js';
import { isKnownState, doneStates, terminalStates, timestampColumnFor, isTransitionAllowed, type WorkOrderStatus, type WorkflowTransition, type WorkflowDef } from '../engine/stateMachine.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { pickAutoRule, TERMINAL_STATES } from '../engine/autoRules.js'; // 地基④：自动审核
import { listEnabledAutoRules } from '../repo/autoRule.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { embedText, embeddingConfigured, embeddingModel } from '../services/llm.js';
import { recordShadowSuggestions, resolveDispatchShadow } from '../services/k2Shadow.js';
import { withTenantClient } from '../db/pool.js';

export interface CreateDto {
  id: string;
  tenantId: string;
  businessType: string;
  catalog?: string;
  priority?: string;
  location?: string;
  title?: string;
  // 注意：description 可能含用户主动提供的手机号等 PII。K1 推理路径经 maskPhone 脱敏（llm.ts），
  // K2 向量嵌入路径入口 embedText 亦已补 maskPhone（R4-001）。下游落库/导出须沿用脱敏后文本。
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
  // 决策 #7：列表/详情下发承接人姓名（LEFT JOIN worker 而来；无承接人 → null）
  assignee_name?: string | null;
  created_at: string;
  updated_at: string;
}

/** 生成业务工单号：WO_YYYYMMDD_10位强随机（crypto 32bit 熵，替代原 Math.random 6位弱随机）。
 *  同日碰撞概率可忽略；order_no 唯一索引 DDL 兜底（062，索引 uq_work_orders_tenant_order_no）
 *  已于 2026-08-29 在线上由 postgres 身份应用并入 _migrations 账本（#822 收口记录）。
 *  （2026-08-31 审查修正：本注释曾写"待授权后上线，当前未应用"，与线上事实不符，已更正。） */
function genOrderNo(d: Date = new Date()): string {
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = randomBytes(4).readUInt32BE(0).toString().padStart(10, '0'); // 0..4294967295，32bit 熵
  return `WO_${ymd}_${rand}`;
}

/** 幂等创建：幂等键命中则返回原工单，否则插入 + 写幂等键 + 审计。 */
export async function createWithIdem(
  client: PoolClient,
  dto: CreateDto,
): Promise<{ row: WorkOrderRow; created: boolean }> {
  if (dto.idempotencyKey) {
    // R1-001 零 DDL 串行化：先抢幂等键（依赖 059 后 PK=(tenant_id,key) 唯一约束），抢到者才建单；
    // 冲突者回查并复用既有单，从根上消除 TOCTOU 并发重复建单。
    // work_order_id 在建键时即写入 dto.id（work_orders 的 PK，调用方生成、全程一致），
    // idempotency_key.work_order_id 为纯 text 软引用无 FK，故先插键零风险、零 schema 变更。
    const grab = await client.query(
      'INSERT INTO idempotency_key (key, tenant_id, work_order_id) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, key) DO NOTHING',
      [dto.idempotencyKey, dto.tenantId, dto.id],
    );
    if (grab.rowCount === 0) {
      const hit = await client.query<{ work_order_id: string }>(
        'SELECT work_order_id FROM idempotency_key WHERE key = $1 AND tenant_id = $2',
        [dto.idempotencyKey, dto.tenantId],
      );
      const existing = hit.rows[0]?.work_order_id
        ? await findOne(client, dto.tenantId, hit.rows[0].work_order_id)
        : null;
      if (existing) return { row: existing, created: false };
      // 理论不可达：键存在但 work_order_id 为空（建键即带 dto.id，不应发生）→ 降级继续新建
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
  // （幂等键已在上方抢键分支写入，无需重复插入；无 idempotencyKey 时不写键，保持原语义）
  await client.query(
    `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor)
     VALUES ($1,$2,'create',NULL,'draft','system')`,
    [dto.tenantId, dto.id],
  );
  await emitDomainEvent(client, { tenantId: dto.tenantId, entityType: 'work_order', entityId: dto.id, type: 'create', actor: 'system' });

  // K2（有 embedding key 时）：报修单创建即异步嵌入向量库（best-effort，不阻塞创建响应，失败仅告警）。
  // 走到此处必为新建（幂等命中已在上方提前 return），故直接嵌入。
  const emb = [dto.title, dto.description, dto.businessType, dto.catalog, dto.faultType, dto.location]
    .filter(Boolean).join(' ').slice(0, 8000);
  if (embeddingConfigured() && emb.trim()) {
    embedText(emb, dto.tenantId)
      .then((vec) => {
        if (!vec) return;
        return withTenantClient(dto.tenantId, async (client) => {
          await client.query(
            `SELECT upsert_case_embedding($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [dto.tenantId, 'work_order', String(dto.id), dto.businessType || dto.catalog || '', dto.priority ?? 'normal', emb, vec, embeddingModel(), vec.length],
          );
          // K2 影子模式（R34）：同一向量只读建议——category/dispatch 影子行，绝不参与业务决策。
          // best-effort：失败走外层 catch 仅告警。
          await recordShadowSuggestions(client, dto.tenantId, String(dto.id), vec, dto.businessType || dto.catalog || '');
        });
      })
      .catch((e) => console.warn('[embed work_order] fail:', (e as Error).message));
  }

  return { row: ins.rows[0], created: true };
}

export interface TransitionResult {
  row: WorkOrderRow;
  transition: WorkflowTransition | null;
  /** 更新前的状态（锁内读取，权威）。供调用方做"首次进入触发态"等判定，避免事务外快照并发双触发。 */
  from: string;
  /**
   * 地基④：本次流转**之后**被自动审核规则接走的情况（无自动推进时恒 undefined）。
   * 有值意味着 row.status 已是自动推进后的状态（比调用方传入的 to 更靠后一步）。
   */
  autoAdvanced?: { event: string; to: string; ruleId?: string };
}

/** 状态流转：校验合法跳转（拓扑 + 角色门禁 + 必填），更新状态 + 审计 + 副作用。 */
export async function transition(
  client: PoolClient,
  tenantId: string,
  id: string,
  to: WorkOrderStatus,
  // 批次三纯加法：eventOverride（可选）——按 from+event 精确钉死事件解析转移（缺省不传 = 原 from+to 行为不变）。
  // 场景：同一 from→to 存在多条边（如 completed→closed 同时有 close / acceptance_pass）时，
  // 专用验收端点用 eventOverride='acceptance_pass' 钉死走验收边，通用路径仍按 from+to 解析。
  // perms（地基第二步）：执行者实际生效的权限点集合，供 allowedPerms 门禁判定。
  // 不传则仅有 allowedRoles 生效（存量调用行为逐字不变）。
  // auto（地基④）：由自动审核规则触发的推进，用于防止"自动推进再触发自动推进"的链式失控。
  // systemAuto（地基④）：系统按租户显式启用并过红线的规则执行，**跳过人类角色门禁**——
  //   这不是越权：规则必须由持 workflow.approve 的把关人显式启用，且目标态必过终态红线，
  //   且全程以 actor='system:auto' 写入 ticket_event 留痕可审计。仅 tryAutoAdvance 内部使用。
  // autoFlow（F4 2026-10-19）：显式声明本次流转的 auto_flow 口径。P0-6 曾按"带 assignee
  //   必是人工"打 false——自动派单恰好带 assignee，该假设把自动派单率打成 0（口径失真）。
  //   现在系统发起的流转显式传 true；不传时保持存量语义逐字不变。
  // eventLogType（F4 2026-10-19）：ticket_event.type 覆盖（缺省 'transition'）。自动派单传
  //   'assign'——publicReport 的平均响应时长按 type='assign' 聚合，事件流类型不许因通道统一而断。
  opts?: { actor?: string; role?: string; perms?: readonly string[]; fields?: Record<string, unknown>; eventOverride?: string; auto?: boolean; systemAuto?: boolean; autoFlow?: boolean; eventLogType?: string },
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
  // 匹配具体 transition（含规则），拓扑非法直接 422。
  // 批次三纯加法：eventOverride 显式给定时按 from+event 解析（并校验其目标态与 to 一致，防重定向）；
  // 未给定时保持原 from+to 解析行为逐行不变。
  const tdef = opts?.eventOverride
    ? def.transitions.find((t) => t.from === cur.status && t.event === opts.eventOverride) ?? null
    : def.transitions.find((t) => t.from === cur.status && t.to === to) ?? null;
  if (!tdef) {
    throw new AppError(
      'CONFLICT',
      opts?.eventOverride
        ? `illegal transition ${cur.status} --${opts.eventOverride}--> (event not found)`
        : `illegal transition ${cur.status} -> ${to}`,
      422,
    );
  }
  if (opts?.eventOverride && tdef.to !== to) {
    throw new AppError('CONFLICT', `event ${opts.eventOverride} leads to ${tdef.to}, not ${to}`, 422);
  }
  // A+ 角色门禁：allowedRoles 为空/未定义 = 放行（向后兼容，避免门死自己）；显式配置且不在其中 → 403
  const role = opts?.role;
  // R9-003 修复：角色门禁缺失 role（如生产 JWT 未带 role 声明）应视为"不在白名单"→ 拒。
  // 原 `&& role &&` 会在 role 缺失时短路放行，造成越权门禁失效。
  // 地基第二步：门禁 = allowedRoles ∪ allowedPerms（并集），判定单一事实源 isTransitionAllowed。
  //
  // 【惰性取权限点】仅当该转移**声明了 allowedPerms** 时才查库：
  //   ① 存量转移（无 allowedPerms）→ 零额外查询、零行为变化（与改造前逐字等价）；
  //   ② 调用方不必各自透传权限集合（避免 N 处散落 + 严格 mock 测试被新查询打断）；
  //   ③ 调用方显式传 opts.perms 时以其为准（跳过查库，便于单测）。
  const deny = () =>
    new AppError('FORBIDDEN', `role ${role ?? '(none)'} not allowed for ${cur.status}->${to}`, 403);
  // 地基④：systemAuto = 系统按租户已启用且过红线的规则执行，无人类执行者 → 跳过角色/权限门禁。
  // 安全性由三重前置保证（规则须把关人启用 + 目标态非终态 + 事件白名单），详见 tryAutoAdvance。
  if (!opts?.systemAuto) {
    if (tdef.allowedPerms && tdef.allowedPerms.length > 0) {
      const perms =
        opts?.perms ??
        (await listPerms({ tenantId, requestId: '', role, authMode: 'prod' } as AuthLocals, client));
      if (!isTransitionAllowed(tdef, { role, perms })) throw deny();
    } else if (!isTransitionAllowed(tdef, { role })) {
      throw deny();
    }
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
  // 2026-09-14 纵切② P0-5：assignee 存在性校验——此前携带不存在的 worker id 会静默落库
  // assignee_id，工单派给"幽灵工人"永无人接。调用方契约（已全量排查）：assignee 一律为 worker.id ——
  //   routes/workOrder.ts 通用 transition 端点（dispatch/forward/claim-hall 派单，客户端传 worker id）；
  //   services/acceptance.ts（fields={} 不带 assignee）；抢单/自动派单/联动单为旁路 UPDATE 不走本函数。
  if (assignee) {
    const w = await client.query(
      'SELECT 1 FROM worker WHERE id = $1 AND tenant_id = $2 AND active = true',
      [assignee, tenantId],
    );
    if (w.rowCount === 0) {
      throw new AppError('BAD_PARAM', `assignee 不存在或未启用: ${assignee}`, 422);
    }
  }
  // 074 里程碑回填（2026-09-06）：按目标状态回填对应生命周期时间列（映射单一事实源在
  // stateMachine.STATUS_TIMESTAMP_COLUMNS），transition 是工单流转唯一收口写路径，此处回填
  // 即覆盖人工/接口全部流转；自动派单与抢单旁路在 workOrder.ts / linkedWorkOrder.ts 各自同步回填。
  const milestoneCol = timestampColumnFor(to);
  // F4（2026-10-19）：auto_flow 三态口径——①显式声明 autoFlow → 听声明（自动派单=true；
  //   自动审核推进不带 assignee 也不许把单打成人工）；②未声明且带 assignee → false
  //   （P0-6 人工派单口径，存量行为逐字不变）；③未声明且无 assignee → 不写该列。
  const autoFlowSql =
    opts?.autoFlow === true ? ', auto_flow = true'
    : opts?.autoFlow === false ? ', auto_flow = false'
    : assignee ? ', auto_flow = false' : '';
  const upd = await client.query<WorkOrderRow>(
    `UPDATE work_orders SET status = $1, updated_at = now()${assignee ? ', assignee_id = $4' : ''}${autoFlowSql}${milestoneCol ? `, ${milestoneCol} = now()` : ''} WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    assignee ? [to, id, tenantId, assignee] : [to, id, tenantId],
  );
  // R32 load 对称回收（2026-08-31 拆雷三件套①）：transition 是工单流转唯一写路径，
  // 在此做 worker.load 的净变化结算，修复「load 只增不减」断链（评估报告三条业务断链之一）。
  // 口径：load = 该 worker 当前在身工单数。活跃态 = 全态 − done − terminal − 挂起（与 SLA 扫描同源派生）。
  // 净变化：before = 流转前「活跃且有 assignee」的贡献者；after = 流转后同口径贡献者。
  //   - before 且 before≠after → 旧 assignee -1（完成/取消/挂起/改派旧离场）
  //   - after  且 after≠before → 新 assignee +1（人工派单/恢复/改派新入场）
  // 注意：2026-10-19 起自动派单（F4）、抢单（F6）已并入 transition 主通道，load 由此处净结算
  //   （不再手工 +1，故不会重复计数）；仅 linkedWorkOrder.ts 联动单仍是旁路直写，保持其既有行为。
  const se0 = def.states.filter(
    (s) => !doneStates(def).includes(s) && !terminalStates(def).includes(s) && s !== 'paused' && s !== 'suspended',
  );
  const fromActive = se0.includes(cur.status);
  const toActive = se0.includes(to);
  const nextAssignee = assignee ?? cur.assignee_id ?? null;
  const beforeContrib = fromActive && cur.assignee_id ? cur.assignee_id : null;
  const afterContrib = toActive && nextAssignee ? nextAssignee : null;
  if (beforeContrib && beforeContrib !== afterContrib) {
    await client.query('UPDATE worker SET load = GREATEST(load - 1, 0) WHERE id = $1 AND tenant_id = $2', [beforeContrib, tenantId]);
  }
  if (afterContrib && afterContrib !== beforeContrib) {
    await client.query('UPDATE worker SET load = load + 1 WHERE id = $1 AND tenant_id = $2', [afterContrib, tenantId]);
    // K2 影子回填（R34）：派单/改派发生 → 回填 dispatch 影子 actual（旁路 best-effort，内部吞错不影响主链路）
    await resolveDispatchShadow(client, tenantId, id, afterContrib);
  }
  await client.query(
    `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
     VALUES ($1,$2,'${opts?.eventLogType ?? 'transition'}',$3,$4,$5,$6)`,
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
  // —— 地基④：自动审核（惰性触发；无启用规则时零行为，与改造前逐字等价）——
  const advanced = await tryAutoAdvance(client, tenantId, id, def, to, upd.rows[0], opts);
  if (advanced) return advanced;
  return { row: upd.rows[0], transition: tdef, from: cur.status };
}

/**
 * 地基④：自动审核执行器——工单**刚落到的状态**若命中一条启用规则，就按规则再推一步。
 *
 * 【为什么放在这里】transition 是工单流转的唯一收口写路径，放在这里才能真正做到
 * "进入待审核态就自动审"，而不是只在某一个端点生效。
 *
 * 【四道闸（缺一不可）——"引擎绝不自动推进到终态"红线】
 *   ① 惰性：先查启用中的规则，为空（含 094 未应用）→ 立刻返回 null，零额外行为；
 *   ② 白名单：规则 event 只能是 approve / reject（schema + DB CHECK + 此处 resolveAutoRuleEdge 三重）；
 *   ③ 终态红线：解析出的 target state 命中 def 派生终态（terminalStates，无出边）→ 放弃自动（双保险，保存时已挡一次）；
 *   ④ 单级：opts.auto 标记已自动推进过的流转不再触发，杜绝链式失控（自动→自动→…）。
 *   另：目标边若声明了 requiredFields（需人工填内容）→ 放弃自动，不硬推。
 *
 * 【留痕】每次自动推进额外写一条 ticket_event(type='auto_rule', actor='system:auto')，
 *   谁配的、按哪条规则、从哪个态到哪个态，事后可审计。
 */
async function tryAutoAdvance(
  client: PoolClient,
  tenantId: string,
  id: string,
  def: WorkflowDef,
  currentState: string,
  row: WorkOrderRow,
  opts?: { auto?: boolean },
): Promise<TransitionResult | null> {
  // ④ 单级：本身就是自动推进 → 不再连锁
  if (opts?.auto) return null;
  let rules: Awaited<ReturnType<typeof listEnabledAutoRules>>;
  try {
    rules = await listEnabledAutoRules(client, tenantId, 'work_order');
  } catch {
    return null; // ① 表缺失（094 未应用）→ 零自动行为，绝不影响存量流转
  }
  if (rules.length === 0) return null;

  const ext = (row.ext ?? {}) as Record<string, unknown>;
  const rule = pickAutoRule(rules, currentState, {
    priority: row.priority ?? null,
    category: row.catalog ?? null,
    hasException: ext.has_exception === true,
  });
  if (!rule) return null;

  const edge = def.transitions.find((t) => t.from === currentState && t.event === rule.event);
  if (!edge) return null;
  // ③ 终态红线（双保险：保存时 assertAutoRuleSavable 已挡一次，这里再挡运行期的数据漂移）
  // 2026-10-19 对齐审查修复：硬编码 RICH 终态名 ∪ def 派生终态（无出边）取并集，只加强不削弱——
  // closed 在 RICH 有出边但"自动关单"仍是人工终局决定（autoAdvance.test.ts 红线口径）；
  // 自定义流程的终态名（如 done）运行期同样拦住。
  const terminalSet = new Set<string>([...TERMINAL_STATES, ...terminalStates(def)]);
  if (terminalSet.has(edge.to)) return null;
  // 需人工填字段的边不自动推（自动填不出来，硬推只会 422）
  if (edge.requiredFields && edge.requiredFields.length > 0) return null;

  const next = await transition(client, tenantId, id, edge.to, {
    actor: 'system:auto',
    auto: true,
    systemAuto: true,
    eventOverride: rule.event,
  });
  // 留痕：自动审核是"系统替人做决定"，必须可追溯
  await client.query(
    `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
     VALUES ($1,$2,'auto_rule',$3,$4,'system:auto',$5)`,
    [tenantId, id, currentState, edge.to, JSON.stringify({ event: rule.event, rule_id: rule.id ?? null })],
  );
  return { ...next, autoAdvanced: { event: rule.event, to: edge.to, ruleId: rule.id } };
}

export async function findOne(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<WorkOrderRow | null> {
  // 决策 #7：LEFT JOIN worker 下发承接人姓名（assignee_name）；无承接人/档案缺失 → null，不丢行。
  // JOIN 条件带 tenant_id，防跨租户脏数据串名。
  const r = await client.query<WorkOrderRow>(
    `SELECT wo.*, w.name AS assignee_name
       FROM work_orders wo
       LEFT JOIN worker w ON w.id = wo.assignee_id AND w.tenant_id = wo.tenant_id
      WHERE wo.id = $1 AND wo.tenant_id = $2`,
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
  // 批次三纯加法：unsettledOnly（可选）——过滤"未被任何结算单占用"的工单（结算页建单数据源）。
  // 决策 #8 纯加法：department/priority/source/service_desk 四个可选精确匹配过滤（语义同 status/assignee）；
  // 全部不传时行为与旧版完全一致（零回归）。
  filter: {
    status?: WorkOrderStatus;
    // E-8 QA P3-1（双档案）：支持 string[]——师傅角色多 worker 档案时按集合（ANY）过滤；
    // 单值行为不变（零回归）。
    assignee?: string | string[];
    limit?: number;
    offset?: number;
    unsettledOnly?: boolean;
    department?: string;
    priority?: string;
    source?: string;
    service_desk?: string;
    // P1（TicketList 按"陪检"一键圈单）纯加法：business_type 精确匹配过滤（语义同 department/priority），
    // 不传行为与旧版完全一致（零回归）。
    businessType?: string;
    // 智能体批次一（2026-09-07）纯加法：createdSince（可选）——只查该时刻之后创建的工单
    // （AI 管家「今天」语义；不传行为与旧版完全一致，零回归）。
    createdSince?: Date;
    // 工作台下钻（#949 续）纯加法：三个可选筛选，服务工作台统计卡"点数字看明细"真实下钻。
    // 全部不传时行为与旧版完全一致（零回归）。
    //   autoFlow    → 只回自动流转单（wo.auto_flow = true，对应工作台"自动派单"卡）。
    //   todayOnly   → 只回当日创建单（wo.created_at::date = CURRENT_DATE，与 /stats today_new
    //                 同口径：routes/workOrder.ts /open/me/summary 的 created_at::date = CURRENT_DATE）。
    //   timeoutOnly → 只回"超时且未闭环"单：期望完成时间已过（sla_due_at IS NOT NULL AND
    //                 sla_due_at < now()）且未进终态。排除集复用 SLA 扫描既有口径
    //                 （scheduler/slaScheduler.ts 的 doneStates(def)+terminalStates(def) 并集），
    //                 由 workflow_def 派生不写死：DEFAULT 4 态兜底=completed；
    //                 RICH 模板=completed/closed/evaluated/cancelled。
    autoFlow?: boolean;
    todayOnly?: boolean;
    timeoutOnly?: boolean;
  },
): Promise<{ items: WorkOrderRow[]; total: number }> {
  const conds = ['wo.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (filter.status) {
    // 批次三④：支持逗号分隔多态过滤（如 'completed,closed,evaluated'，结算向导数据源）；
    // 单值时 = ANY(['x']) 与原 status = $n 语义等价，既有调用方零影响。
    const statuses = filter.status.split(',').map((s) => s.trim()).filter(Boolean);
    params.push(statuses);
    conds.push(`wo.status = ANY($${params.length}::text[])`);
  }
  if (filter.assignee) {
    // E-8 QA P3-1（双档案）：数组 → ANY 精确集合匹配；单值保持 = 等值匹配（既有调用方零回归）。
    if (Array.isArray(filter.assignee)) {
      params.push(filter.assignee);
      conds.push(`wo.assignee_id = ANY($${params.length}::text[])`);
    } else {
      params.push(filter.assignee);
      conds.push(`wo.assignee_id = $${params.length}`);
    }
  }
  if (filter.department) {
    params.push(filter.department);
    conds.push(`wo.department = $${params.length}`);
  }
  if (filter.priority) {
    params.push(filter.priority);
    conds.push(`wo.priority = $${params.length}`);
  }
  if (filter.source) {
    params.push(filter.source);
    conds.push(`wo.source = $${params.length}`);
  }
  if (filter.service_desk) {
    params.push(filter.service_desk);
    conds.push(`wo.service_desk = $${params.length}`);
  }
  // P1 纯加法：business_type 精确匹配（escort/repair/transport_task...），不传不拼条件
  if (filter.businessType) {
    params.push(filter.businessType);
    conds.push(`wo.business_type = $${params.length}`);
  }
  // 一单终身一结算：settlement_item 以 UNIQUE(work_order_id) 占用，NOT EXISTS 即"未结算"
  if (filter.unsettledOnly) {
    conds.push('NOT EXISTS (SELECT 1 FROM settlement_item si WHERE si.work_order_id = wo.id)');
  }
  // 智能体批次一纯加法：createdSince（AI 管家「今天」语义），不传不拼条件
  if (filter.createdSince) {
    params.push(filter.createdSince);
    conds.push(`wo.created_at >= $${params.length}`);
  }
  // 工作台下钻（#949 续）纯加法三参：不传不拼条件，旧行为零变化。
  // autoFlow：自动流转单（工作台"自动派单"卡下钻）。
  if (filter.autoFlow) {
    conds.push('wo.auto_flow = true');
  }
  // todayOnly：当日创建单；created_at::date = CURRENT_DATE 与 /open/me/summary today_new 同口径。
  if (filter.todayOnly) {
    conds.push('wo.created_at::date = CURRENT_DATE');
  }
  // timeoutOnly：超时且未闭环。排除集=doneStates(def)+terminalStates(def)（SLA 扫描同口径，
  // 复用 slaScheduler.ts:43 的 slaExclude 派生方式），def 按 tenant 动态取 → 租户自定义工作流
  // 扩展终态自动纳入排除，不写死枚举。
  if (filter.timeoutOnly) {
    const def = await getWorkflowDef(client, tenantId, 'work_order');
    const exclude = Array.from(new Set([...doneStates(def), ...terminalStates(def)]));
    params.push(exclude);
    conds.push(
      `wo.sla_due_at IS NOT NULL AND wo.sla_due_at < now() AND wo.status <> ALL($${params.length}::text[])`,
    );
  }
  const where = conds.join(' AND ');
  const totalR = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM work_orders wo WHERE ${where}`,
    params,
  );
  // P-3：limit/offset 强制上限，防止调用方拉取整表（DoS 面）。
  const limit = Math.min(Math.max(1, Math.floor(Number(filter.limit) || 20)), 200);
  const offset = Math.max(0, Math.min(Math.floor(Number(filter.offset) || 0), 10000));
  // 决策 #7：LEFT JOIN worker 下发承接人姓名（assignee_name），无承接人 → null。
  // JOIN 条件带 tenant_id 防跨租户串名；SELECT wo.* 保持全部既有列不丢。
  const listR = await client.query<WorkOrderRow>(
    `SELECT wo.*, w.name AS assignee_name
       FROM work_orders wo
       LEFT JOIN worker w ON w.id = wo.assignee_id AND w.tenant_id = wo.tenant_id
      WHERE ${where} ORDER BY wo.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { items: listR.rows, total: Number(totalR.rows[0].c) };
}
