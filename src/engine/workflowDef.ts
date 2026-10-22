// workflow_def 仓储（T-①）：读/确保/保存每租户每业务流的状态图定义。
// 状态图存 DB，由可配置状态机引擎消费，实现"流程零代码配置"。
import type { PoolClient } from 'pg';
import { DEFAULT_WORK_ORDER_DEF, doneStates, terminalStates, type WorkflowDef } from './stateMachine.js';
import { ensureClaimHallState } from './claimHallEdges.js';
import { ensureTenantStateLabels } from './labelDictTenant.js';
import { AppError } from '../middleware/error.js';
import { PERMS, ROLES, ROLE_CODE_RE, isRetiredRole } from '../middleware/role.js';

/**
 * V2-F7（2026-09-14）：读路径幂等注入抢单大厅机制态（仅 work_order）。
 * 抢单大厅是引擎滴滴式兜底：派单未命中直接 UPDATE status='claim_hall'（旁路），
 * 但最小 4 态/部分租户 def 无此态 ⇒ transition() isKnownState 拒绝，出厅流转
 * 全 422（合法进、非法出，大厅卡死）。在读路径注入（而非写路径）的原因：
 * 存量已落库 def 与已落大厅的单无需迁移即修复；claim_hall 属引擎机制态，
 * 注入是"引擎真实行为空间"的诚实呈现。纯加法幂等，详见 engine/claimHallEdges.ts。
 */
function withMechanismStates(entityType: string, def: WorkflowDef): WorkflowDef {
  if (entityType !== 'work_order') return def;
  return ensureClaimHallState(def).def;
}

/**
 * 2026-09-14 纵切③ P0-2：状态图写入口校验收口（纯函数可单测）。
 * 此前 PUT /workflow/def 的校验只做 ①initial∈states ②transitions from/to∈states（optimize.ts 内联），
 * 漏掉第三项：autoRoutes.to 允许指向 doneStates/terminalStates——自动派单直达终态，
 * 绕过处理/验收全链路（派单目标态禁止是终态）。校验三违例均抛 422 BAD_REQUEST：
 *   ① initial ∈ states；
 *   ② 所有 transitions 的 from/to ∈ states；
 *   ③ def.config?.autoRoutes（若存在）：每个 route.to ∈ states 且不在 doneStates/terminalStates 中。
 */
export function validateWorkflowDef(def: WorkflowDef): void {
  if (!def.states.includes(def.initial)) {
    throw new AppError('BAD_REQUEST', `initial "${def.initial}" not in states`, 422);
  }
  const transitions = Array.isArray(def.transitions) ? def.transitions : [];
  const unknown = transitions.filter((t) => !def.states.includes(t.from) || !def.states.includes(t.to));
  if (unknown.length > 0) {
    throw new AppError('BAD_REQUEST', `transition references unknown state: ${JSON.stringify(unknown[0])}`, 422);
  }
  // 【地基第二步补漏：角色/权限 ↔ 流程的联动校验】
  // 此前只校验"状态拓扑"，完全不校验 allowedRoles / allowedPerms 里写的名字是否存在：
  //   租户把某条边的 allowedRoles 写成拼错的名字（或引用一个已删除的自定义岗位）→
  //   **这条边永久门死，没有任何人能走这条流转，且保存时不报错**（配错了连提示都没有）。
  //   角色可配置与流程可配置之间缺这道校验，两者就不算真正闭环。
  //
  // ① allowedPerms ∈ PERMS（同步，零存量风险）：allowedPerms 是本批新增字段，
  //    存量只可能是 091/092 回填的 'workflow.approve'（合法），写错即挡。
  for (const t of transitions) {
    const perms = (t as { allowedPerms?: string[] }).allowedPerms;
    if (!Array.isArray(perms)) continue;
    for (const p of perms) {
      if (!(PERMS as readonly string[]).includes(p)) {
        throw new AppError(
          'BAD_REQUEST',
          `transition ${t.from}--${t.event ?? ''}-->${t.to} 引用了未登记的权限点 "${p}"（可用清单见 GET /accounts/roles/perm-catalog）`,
          422,
        );
      }
    }
  }
  const routes = def.config?.autoRoutes;
  if (routes) {
    // 禁止自动派发直达的目标态 = 完成态 ∪ 终态（completed/closed/evaluated 等必须由显式事件驱动，
    // 与引擎红线一致："绝不自动把状态推进到终态"）。
    const forbidden = new Set<string>([...doneStates(def), ...terminalStates(def)]);
    for (const [fromState, route] of Object.entries(routes)) {
      const toState = route?.to;
      if (typeof toState !== 'string' || !def.states.includes(toState)) {
        throw new AppError('BAD_REQUEST', `autoRoutes.${fromState}.to "${String(toState)}" not in states`, 422);
      }
      if (forbidden.has(toState)) {
        throw new AppError(
          'BAD_REQUEST',
          `autoRoutes.${fromState}.to "${toState}" 是完成态/终态，禁止作为自动派单目标（派单目标态禁止直达终态）`,
          422,
        );
      }
    }
  }
}

/**
 * 【地基第二步补漏】流程里 allowedRoles 引用的角色必须真实存在（异步，需查 role_def）。
 *
 * 为什么必须补：此前流程保存只校验状态拓扑，allowedRoles 写什么都能存 ——
 *   租户把某条边的 allowedRoles 写成拼错的名字（如 'weixiuzuzhang'），或引用一个已删掉的
 *   自定义岗位 → **这条边永久门死，谁都走不了，且保存时零提示**。
 *   角色可配置与流程可配置之间少了这道校验，两者就不算闭环。
 *
 * 【存量安全（关键设计）】只校验"本次新出现的角色名"：
 *   oldDef 里已存在的角色名一律豁免（哪怕它现在已不在 role_def 里）。
 *   否则存量 def 里若有历史脏角色名，租户一保存流程就被 422 挡住 = 生产事故。
 *   精准取舍：**拦增量错字，不翻存量旧账。**
 */
export async function assertWorkflowDefRolesUsable(
  client: PoolClient,
  tenantId: string,
  def: WorkflowDef,
  oldDef?: WorkflowDef | null,
): Promise<void> {
  const legacy = new Set<string>();
  for (const t of oldDef?.transitions ?? []) {
    for (const r of t.allowedRoles ?? []) legacy.add(r);
  }
  const need = new Set<string>();
  for (const t of def.transitions ?? []) {
    for (const r of t.allowedRoles ?? []) {
      if (legacy.has(r)) continue; // 存量既有 → 豁免，不翻旧账
      if ((ROLES as readonly string[]).includes(r)) {
        // 内置角色不查 role_def；但**退场角色一律不得新写进流程**。
        // 背景：096 迁移清的是 workflow_def.def（live），草稿行（workflow_def_change）没动；
        // 若此处沿用"内置即放行"，一份 096 之前的旧草稿审批通过就把 dispatcher/service_desk
        // 原样写回 live —— 退场清理被复活、死角色重新出现在门禁里。
        // 存量豁免（上一行 legacy）先于此判定，故已带退场角色的租户保存流程不受影响。
        if (isRetiredRole(r)) {
          throw new AppError(
            'BAD_REQUEST',
            `流程引用了已退场的内置角色 "${r}"（该岗位已停止新建，请改用内置在岗角色，或先在「自定义岗位」建岗后再引用）`,
            422,
          );
        }
        continue;
      }
      if (!ROLE_CODE_RE.test(r)) {
        throw new AppError(
          'BAD_REQUEST',
          `流程引用了形状非法的角色名 "${r}"（须 ^[a-z][a-z0-9_]{1,31}$，如 repair_lead）`,
          422,
        );
      }
      need.add(r);
    }
  }
  if (need.size === 0) return;
  const codes = [...need];
  const r = await client.query<{ code: string }>(
    `SELECT code FROM role_def WHERE tenant_id = $1 AND code = ANY($2::text[])`,
    [tenantId, codes],
  );
  const found = new Set(r.rows.map((x) => x.code));
  const missing = codes.filter((c) => !found.has(c));
  if (missing.length > 0) {
    throw new AppError(
      'BAD_REQUEST',
      `流程引用了本租户不存在的角色：${missing.join('、')}（请先在「角色管理」创建该岗位，或改回内置角色）`,
      422,
    );
  }
}

/** 读状态图；租户无定义时回退指定兜底（不写库，避免只读操作产生副作用）。 */
export async function getWorkflowDefOrDefault(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  fallback: WorkflowDef,
): Promise<WorkflowDef> {
  const r = await client.query<{ def: unknown }>(
    'SELECT def FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
  const raw = r.rows[0]?.def;
  if (!raw) return withMechanismStates(entityType, cloneDef(fallback));
  return withMechanismStates(entityType, normalizeDef(typeof raw === 'string' ? JSON.parse(raw) : raw));
}

/** 读状态图；租户无定义时回退默认（不写库，避免只读操作产生副作用）。 */
export async function getWorkflowDef(
  client: PoolClient,
  tenantId: string,
  entityType: string,
): Promise<WorkflowDef> {
  return getWorkflowDefOrDefault(client, tenantId, entityType, DEFAULT_WORK_ORDER_DEF);
}

/**
 * 确保状态图存在：无则 upsert 默认定义并返回；有则原样返回。
 * @param actor 变更人（T0）：自动补建默认流程也是一次配置写入，同样要留变更人。
 */
export async function ensureWorkflowDef(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  actor?: string,
): Promise<WorkflowDef> {
  const existing = await client.query<{ def: unknown }>(
    'SELECT def FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
  if (existing.rows[0]) {
    const raw = existing.rows[0].def;
    return withMechanismStates(entityType, normalizeDef(typeof raw === 'string' ? JSON.parse(raw) : raw));
  }
  const def = withMechanismStates(entityType, cloneDef(DEFAULT_WORK_ORDER_DEF));
  await client.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version, updated_by) VALUES ($1,$2,$3,1,$4)`,
    [tenantId, entityType, JSON.stringify(def), actor ?? null],
  );
  return def;
}

/** upsert 状态图（版本自增，记录变更历史）。
 *  S2：保存前把「当前旧版」快照写入 workflow_def_history（append-only，S3 版本回滚地基）；
 *  reason 为来源标记（手工保存/模板应用/回滚，G5：模板应用与自优化不互斥）。
 *
 *  V3-D5（2026-09-14）：opts 从可选改必填——TS 编译期强制所有直写调用点留痕
 *  （operator/reason 缺失或空串运行期 422，防 `?? null` 式静默）。live 写边收敛为五条：
 *  approve / rollback / template / auto-tune / provision，全部可归因。
 *
 *  V3-D4（2026-09-14）：删态硬闸——removed = 旧 states − 新 states 非空时，
 *  先按实体表映射清点在途单；有在途且未显式 allowInflightLoss → 409 INFLIGHT_STATE_LOSS
 *  （改 def 不触碰业务表 status，删掉有在途单的状态即永久 422 失联，默认必须拒绝）。
 *  逃生口 allowInflightLoss 仅供 approve/rollback 端点在显式二次确认参数下传入。 */
export interface SaveWorkflowDefOpts {
  /** 留痕：操作者（审计 history.operator），必填非空。 */
  operator: string;
  /** 留痕：写入原因（审计 history.reason），必填非空。 */
  reason: string;
  /** V3-D4 逃生口：仅 approve/rollback 在请求体显式二次确认（confirm_inflight_loss:true）下传入。 */
  allowInflightLoss?: boolean;
  /**
   * T0 并发锚：我这次写入是**基于哪个版本**改的。
   *   传了 ⇒ 单语句锚定版本，版本已被别人推进则 409 DRAFT_STALE，**绝不静默覆盖**；
   *   不传 ⇒ 保持 T0 前的无条件覆盖写（向后兼容，现有调用点零改动即可继续跑）。
   * 想让"防竞态"真正生效，写边**必须**传它；不传只能说明这条边被显式豁免（豁免理由写进调用点注释）。
   */
  expectVersion?: number;
}

/** 在途单按状态清点（V3-D4 纯查询函数）：扫描面按 entity_type 映射（与 transition.ts ALLOWED_TABLES 同源思想）。 */
const ENTITY_STATE_TABLE: Record<string, string> = {
  work_order: 'work_orders',
  inspection_task: 'inspection_task',
  transport_task: 'transport_order',
};

export async function countInflightByStates(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  states: string[],
): Promise<{ total: number; byState: Record<string, number> }> {
  const byState: Record<string, number> = {};
  let total = 0;
  if (states.length === 0) return { total, byState };
  const table = ENTITY_STATE_TABLE[entityType];
  const sql =
    table !== undefined
      ? `SELECT status, COUNT(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND status = ANY($2) GROUP BY status`
      : `SELECT status, COUNT(*)::int AS n FROM business_flow_tasks WHERE tenant_id = $1 AND entity_type = $2 AND status = ANY($3) GROUP BY status`;
  const params = table !== undefined ? [tenantId, states] : [tenantId, entityType, states];
  const r = await client.query<{ status: string; n: number }>(sql, params);
  for (const row of r.rows) {
    byState[row.status] = Number(row.n);
    total += Number(row.n);
  }
  return { total, byState };
}

export async function saveWorkflowDef(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  def: WorkflowDef,
  opts: SaveWorkflowDefOpts,
): Promise<void> {
  // V3-D5：operator/reason 必填非空（运行期兜底，防调用点传空串静默丢审计）。
  if (!opts?.operator?.trim() || !opts?.reason?.trim()) {
    throw new AppError('BAD_REQUEST', 'saveWorkflowDef requires non-empty operator and reason (audit trail)', 422);
  }
  // 2026-09-14 纵切③ P0-2：写入口统一校验收口（initial/transition 拓扑/autoRoutes 目标态非终态）。
  // 违例 422，坏 def 不落库、不产生 history 快照。开通注入（tenantProvision.ts 直 INSERT 内置 def）
  // 不经本函数、不动；optimize.ts 内联校验保留（幂等冗余，减少 diff）。
  validateWorkflowDef(def);
  const cur = await client.query<{ version: number; def: unknown }>(
    'SELECT version, def FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
  // V3-D4 删态硬闸：旧 def 存在且新 def 删掉了状态 → 清点在途单（escape hatch 见 opts.allowInflightLoss）。
  if (cur.rows[0]) {
    const oldRaw = cur.rows[0].def;
    const oldDef = normalizeDef(typeof oldRaw === 'string' ? JSON.parse(oldRaw) : oldRaw);
    // 地基第二步补漏：allowedRoles 存在性校验（只挡"本次新写错的角色"，见函数注释）
    await assertWorkflowDefRolesUsable(client, tenantId, def, oldDef);
    const removed = (oldDef.states ?? []).filter((s: string) => !def.states.includes(s));
    if (removed.length > 0 && !opts.allowInflightLoss) {
      const hits = await countInflightByStates(client, tenantId, entityType, removed);
      if (hits.total > 0) {
        const detail = Object.entries(hits.byState)
          .map(([st, n]) => `${st}:${n}`)
          .join(',');
        throw new AppError(
          'INFLIGHT_STATE_LOSS',
          `删除状态 [${removed.join(',')}] 将使 ${hits.total} 张在途单失联（${detail}）；确认请走审批流并显式 allowInflightLoss`,
          409,
        );
      }
    }
  }
  if (cur.rows[0]) {
    await client.query(
      `INSERT INTO workflow_def_history (tenant_id, entity_type, version, def, operator, reason)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, entity_type, version) DO NOTHING`,
      [
        tenantId,
        entityType,
        cur.rows[0].version,
        JSON.stringify(cur.rows[0].def),
        opts?.operator ?? null,
        opts?.reason ?? null,
      ],
    );
  }
  // ── T0 条件更新（防竞态）───────────────────────────────────────────────────
  // 单语句锚定版本：`WHERE ($5::int IS NULL OR workflow_def.version = $5)`。
  //   · 不传 expectVersion（$5 = NULL）⇒ 条件恒真 ⇒ 与 T0 前行为一致（向后兼容）；
  //   · 传了但 live 已被别人推进 ⇒ UPDATE 分支不命中、INSERT 因冲突也不落 ⇒ rowCount = 0 ⇒ 409。
  // 【为什么必须单语句】原 approve 路径是 check-then-act（先 getWorkflowDefVersion 比对、再写）：
  //   两条语句之间没有锁，两个并发审批可以读到同一 liveVersion 然后双双通过。
  //   单语句 WHERE 把这个 TOCTOU 窗口彻底消掉——这是 T0 选它的唯一理由。
  const expectVersion = typeof opts.expectVersion === 'number' ? opts.expectVersion : null;
  if (expectVersion !== null && !cur.rows[0]) {
    // 期望某版本但该流程根本不存在 ⇒ 调用方看到的是过期事实，按冲突处理（不静默凭空创建一行）
    throw new AppError(
      'DRAFT_STALE',
      `expected version ${expectVersion} but no def exists for ${entityType}; re-read and retry`,
      409,
    );
  }
  const r = await client.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version, updated_by)
     VALUES ($1,$2,$3,1,$4)
     ON CONFLICT (tenant_id, entity_type)
     DO UPDATE SET def = EXCLUDED.def,
                   version = workflow_def.version + 1,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = now()
     WHERE ($5::int IS NULL OR workflow_def.version = $5)`,
    [tenantId, entityType, JSON.stringify(def), opts.operator, expectVersion],
  );
  const affectedRaw =
    (r as { rowCount?: number | null }).rowCount ?? (r as { affectedRows?: number | null }).affectedRows;
  if (expectVersion !== null && Number(affectedRaw ?? -1) === 0) {
    throw new AppError(
      'DRAFT_STALE',
      `expected version ${expectVersion} but live version is ${cur.rows[0]?.version}; re-read and retry`,
      409,
    );
  }
  // #938-B：流程生效即把该 def 的状态名补进租户覆盖字典（098 label_dict_tenant，只补不覆盖既有译名），
  // 让租户自定义状态（如 rated）有中文名可改，而不是在界面上显示裸 key；读侧 GET /api/v1/meta/labels/me。
  //
  // 【为什么挂这里而不是挂在某条路由】live 写边有五条（approve / rollback / template / auto-tune /
  // provision，见上方 SaveWorkflowDefOpts 注释），**全部收敛到本函数**；挂在此处 = 五条路全覆盖，
  // 挂在任一单条路由 = 其余几条路保存的流程状态继续显示裸 key。
  //
  // 【为什么失败只告警不抛出】标签是**展示层**关注点：098 未应用（滚动发布期代码先于迁移）
  // 或权限缺失时，让"配不了流程"这种业务阻断去背展示层的锅是不可接受的降级顺序。
  // 此处失败 ⇒ 界面退化为裸 key（= 本次改动前的行为），流程照常生效。
  try {
    // T0：落字典也留变更人（本次保存的操作人，与 live 行的 updated_by 同源）
    await ensureTenantStateLabels(client, tenantId, def.states ?? [], opts.operator);
  } catch (e) {
    console.warn(
      '[workflowDef] 状态名落租户覆盖字典失败（展示层退化为裸 key，流程已生效）:',
      e instanceof Error ? e.message : e,
    );
  }
}

/** 当前版本号（无定义返回 0）。 */
export async function getWorkflowDefVersion(
  client: PoolClient,
  tenantId: string,
  entityType: string,
): Promise<number> {
  const r = await client.query<{ version: number }>(
    'SELECT version FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
  return r.rows[0]?.version ?? 0;
}

/** 版本历史列表（倒序，含快照，供前端查看/回滚）。def 保留原始快照（不 normalize，避免 passthrough 字段丢失）。 */
export async function listWorkflowDefHistory(
  client: PoolClient,
  tenantId: string,
  entityType: string,
): Promise<Array<{ version: number; def: WorkflowDef; operator: string | null; reason: string | null; createdAt: string }>> {
  const r = await client.query(
    `SELECT version, def, operator, reason, created_at
     FROM workflow_def_history
     WHERE tenant_id = $1 AND entity_type = $2
     ORDER BY version DESC`,
    [tenantId, entityType],
  );
  return r.rows.map((row) => ({
    version: row.version,
    def: (typeof row.def === 'string' ? JSON.parse(row.def) : row.def) as WorkflowDef,
    operator: row.operator,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

/** 按版本号读历史快照（回滚/查看用）；不存在返回 null。保留原始快照（回滚=逐字节还原，不丢字段）。 */
export async function getWorkflowDefHistoryVersion(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  version: number,
): Promise<WorkflowDef | null> {
  const r = await client.query<{ def: unknown }>(
    `SELECT def FROM workflow_def_history
     WHERE tenant_id = $1 AND entity_type = $2 AND version = $3`,
    [tenantId, entityType, version],
  );
  if (!r.rows[0]) return null;
  const raw = r.rows[0].def;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as WorkflowDef;
}

// 补全式规范化：保留 def 所有原始字段（含 passthrough 额外字段），仅对缺失的
// initial/states/transitions/config 补默认值——避免剥离字段导致「读→存」二次保存洗掉字段。
function normalizeDef(d: any): WorkflowDef {
  return {
    ...d,
    initial: d?.initial ?? 'draft',
    states: Array.isArray(d?.states) ? d.states : ['draft', 'assigned', 'processing', 'completed'],
    transitions: Array.isArray(d?.transitions) ? d.transitions : [],
    config: d?.config ?? {},
  } as WorkflowDef;
}

// 深拷贝：用 JSON 往返而非 structuredClone，兼容 ECS Node16（structuredClone 为 Node17+ 全局）。
function cloneDef(d: WorkflowDef): WorkflowDef {
  return JSON.parse(JSON.stringify(d));
}
