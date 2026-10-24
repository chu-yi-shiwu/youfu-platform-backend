// 角色鉴权中间件（批次 A2 升级：轻量 RBAC）。
// - requireConfigRole：保持向后兼容（admin/operator 可写管理类资源），不改动既有调用点。
// - requirePermission(perm)：按角色权限点校验（默认矩阵 + 租户 role_permission 覆盖）。
// - admin 恒全放行；dev 模式放行（本地联调）。
import { AppError } from './error.js';
import type { PoolClient } from 'pg';
import type { AuthLocals } from './auth.js';

// AL-002 修复（2026-09-04）：补 reviewer / service_desk 两角色。
// 背景：workflow_def allowedRoles 与 stateMachine 转移（accept/dispatch/forward/claim 用
// service_desk；approve/reject 用 reviewer）早已引用这两角色，workOrder 抢单门禁也含
// service_desk，但账号层（z.enum / AccountRole / DB CHECK）建不出 → 审核支线实际仅 admin
// 可做。此处 ROLES 为角色单一事实源，account.ts/accounts.ts/auth.ts 均派生自本清单。
// 【用户要求①】dispatcher（派单员）/ service_desk（服务台角色）退场。
//
// ⚠️ 为什么**不从 ROLES 里删除这两个 code**（零破坏的唯一正确做法）：
//   1. 存量 account_user.role 里已有 'dispatcher'/'service_desk' 的行。一旦从 ROLES 移除，
//      它们立刻变成"自定义角色" → roleRank 由 2 暴跌到 CUSTOM_ROLE_RANK(=worker 的 1)，
//      存量账号权限当场缩水；ROLE_RANK/DEFAULT_PERM_MATRIX 按 Record<Role> 索引也会缺键。
//   2. DB CHECK（069/070 迁移）同样以这 6 个 code 为合法值，删常量等于让存量行变非法。
//   ⇒ 正确做法：**值保留（存量照常登录、照常有权限），但标记为"已退场"**——
//     退场角色不可新建、不可再分配给新账号、不出现在角色下拉里。
//     存量账号由管理员自行改派，系统不自动改数据（改数据是破坏性动作，需人决策）。
//
// ⚠️ 名字撞车警告：'service_desk' 既是角色 code，**也是业务表名**（018_service_desk.sql）
//   与业务模块（src/routes/serviceDesk.ts，服务台管理 + 来电弹屏代申告，挂 server.ts:190）。
//   本退场**只针对角色**，绝不触碰表与模块——删角色 ≠ 删服务台业务。
export const ROLES = ['admin', 'operator', 'dispatcher', 'worker', 'reviewer', 'service_desk'] as const;
export type Role = (typeof ROLES)[number];

/**
 * 已退场角色（用户要求①）：不再作为可选项参与任何"新建 / 分配 / 下拉列表"。
 * 存量账号保留其角色值与既有权限，直到管理员手动改派。
 */
export const RETIRED_ROLES: readonly Role[] = ['dispatcher', 'service_desk'];

/** 是否为已退场角色（不查库，纯常量判定）。 */
export function isRetiredRole(role: string | undefined | null): boolean {
  return !!role && (RETIRED_ROLES as readonly string[]).includes(role);
}

/**
 * 可新建/可分配的角色（内置 − 退场）：角色下拉、分配校验、GET /accounts/roles 的统一口径。
 * 自定义角色不在本常量内（租户级，需查 role_def）。
 */
export const ASSIGNABLE_BUILTIN_ROLES: readonly Role[] = ROLES.filter(
  (r) => !(RETIRED_ROLES as readonly string[]).includes(r),
);

/**
 * 权限点**单一事实源**（2026-10-25「权限不该写死」改造）。
 *
 * 改造前，一个权限点被**写死在三处**，新增一个要同步改三处、漏一处就出事：
 *   ① `PERMS` 常量数组（清单，本文件）
 *   ② `DEFAULT_PERM_MATRIX`（各角色默认权限，6 行手工清单，本文件）
 *   ③ `routes/accounts.ts` 的 `PERM_LABELS`（中文名，`Record<Perm,string>` 缺 key 直接编译失败）
 * 且 accounts.ts 另有一条「catalog 数量 != PERMS.length 就抛 500」的兜底 ——
 * 那是**拿运行时报错去兜「三处手工同步」这个设计缺陷本身**。
 *
 * 现在 `PERM_DEFS` 一处定义（code + label + 默认角色），①②③ 全部派生：
 *   · 新增权限点 = 只写这一处；label / 默认角色是定义的必填字段 ⇒ **结构上不可能漏登记**
 *   · 那条 500 脆断同步删除 —— 它要防的漏登记已不可能发生
 *
 * ⚠️ **有一处仍然必须留在代码里**：业务路由的 `requirePermission('x')` 检查点。
 *    权限点只有在代码里有检查点时才有效；凭空在配置里造一个 perm 没有任何语义。
 *    ⇒ 「权限点清单完全数据库化」在本系统是**伪需求**。真正可配置的是**授予**
 *      （哪个角色有哪些 ⇒ `role_permission` 表 + 权限矩阵界面，已支持）与
 *      **实例级作用域**（T3 的 `perm@entityType`，已支持）。
 *    本次把清单收敛到一处，正是为将来若真要换成数据源驱动留口子（届时只改这里）。
 */
export const PERM_DEFS = {
  'dashboard.view': { label: '总览看板', defaults: ['operator', 'dispatcher', 'reviewer', 'service_desk'] },
  'intake.create': { label: '建单录入', defaults: ['operator', 'worker'] },
  'ticket.manage': { label: '工单管理', defaults: ['operator', 'dispatcher', 'reviewer', 'service_desk'] },
  // 流程配置审核一期（20260912《优服家_流程配置审核设计》§6）：审批把关点。
  //   approve / reject / pending / rollback 四端点使用；默认矩阵仅 admin，
  //   租户可经 role_permission 按角色授予（配合 080 迁移六角色 CHECK 后可授 reviewer 等）。
  //   自审自批禁令不在此层——按账号（submitted_by ≠ 当前 username）在路由层强校验，admin 不豁免。
  'workflow.edit': { label: '流程配置', defaults: [] },
  'workflow.approve': { label: '流程审批', defaults: [] },
  'basicdata.edit': { label: '基础数据', defaults: ['operator'] },
  'dispatch.override': { label: '派单覆盖', defaults: ['operator', 'dispatcher', 'service_desk'] },
  'role.manage': { label: '账号权限', defaults: [] },
  // T8（2026-10-25）：巡检**配置面**独立权限点。此前 13 处巡检配置端点走 requireConfigRole
  // （同步、只读 res.locals.auth.role 的 admin/operator 白名单，**不查权限表** ⇒ 租户无法配置）。
  //   命名沿用既有 xxx.manage 模式（material.manage / asset.manage / volunteer.manage），
  //   与执行面 `inspect.execute` 分开：能巡检 ≠ 能改巡检计划。
  //   🔴 为什么不复用 `basicdata.edit`：下方 volunteer 条目注释已明确「志愿者模块独立权限点
  //     （此前蹭 basicdata.edit）」—— 蹭 basicdata.edit 是被淘汰的旧做法，不走回头路。
  //   🔴 operator 默认给这个是**为了等价、不是策略选择**：原白名单就是 admin+operator，
  //     不给就会从放行变 403。**与 material.manage / asset.manage「收口 admin」策略不一致**
  //     ⇒「巡检配置要不要也收紧到 admin」是独立产品决策，已登记待做项（E6 不夹带）。
  'inspect.manage': { label: '巡检配置', defaults: ['operator'] },
  'inspect.execute': { label: '巡检执行', defaults: ['operator', 'dispatcher', 'worker'] },
  'asset.scan': { label: '资产扫码', defaults: ['operator', 'dispatcher', 'worker'] },
  'optimize.tune': { label: '优化调参', defaults: [] },
  // 批次三 卡4：结算三凭证（读列表/详情/导出 = settlement.read；建/改/删/确认 = settlement.edit）
  'settlement.read': { label: '结算查看', defaults: [] },
  'settlement.edit': { label: '结算操作', defaults: [] },
  // V1 批次（20260911）：志愿者模块独立权限点（此前蹭 basicdata.edit / requireConfigRole）。
  //   volunteer.view   = 查看（GET records/people/stats + FE 菜单可见性）
  //   volunteer.manage = 活动管理（POST activities、PUT /activities/:id/status；发布/关闭/重开不拆分）
  //   volunteer.audit  = 现场执行（checkin / checkout / approve）
  'volunteer.view': { label: '志愿者查看', defaults: ['operator'] },
  'volunteer.manage': { label: '志愿者管理', defaults: ['operator'] },
  'volunteer.audit': { label: '志愿者核销', defaults: ['operator'] },
  // E-9 批次（20260914《优服家_E9_自动结算与耗材二级库存设计》§4 权限边界清单）：三点。
  //   material.manage    = 耗材目录增删改 + 手工出入库 + 批量导入。原 requireConfigRole(admin+operator) → **仅 admin**。
  //   asset.manage       = 资产目录增删改 + 调拨/故障/维保 + 批量导入。原 requireConfigRole(admin+operator) → **仅 admin**。
  //   consumable.consume = 工单耗材消耗（流水强制挂 work_order_id）。默认 worker + operator（执行侧动作）。
  //   读取不收：GET /materials、/assets、/inventory* 维持「已认证即放」（工人选耗材依赖目录读）。
  'material.manage': { label: '耗材维护', defaults: [] },
  'asset.manage': { label: '资产维护', defaults: [] },
  'consumable.consume': { label: '工单耗材领用', defaults: ['operator', 'worker'] },
  // T8 第三批（2026-10-25）：设备模块独立权限点。equipment.ts 8 处写端点
  //   （设备 / 设备类型 / 设备厂商三类主数据 CRUD + CSV 导入导出 + 保养记录增删改）
  //   此前走 requireConfigRole（同步角色白名单，不查权限表 ⇒ 租户无法配置）。
  //   🔴 为什么不用 `asset.manage`：设备与资产是**两套表**（equipment* vs asset*）、两个页面
  //     （EquipmentPage vs AssetPage），且 asset.manage 经 E-9 收口为「仅 admin」，
  //     复用它会把 operator 从放行变 403（破坏等价）。
  //   🔴 为什么不蹭 `basicdata.edit`：见 inspect.manage 注释——蹭基础数据是被淘汰的旧做法；
  //     且设备是独立运维模块，并入基础数据权限点就退化成「要么都给要么都不给」，
  //     与「权限可配置」的诉求相悖（配了设备就得配字典，无法单独授权）。
  //   🔴 operator 默认给这个是**为了等价、不是策略选择**：原白名单就是 admin+operator，
  //     不给就会从放行变 403。是否收紧到 admin 属独立产品决策，不在本批夹带（E6）。
  'equipment.manage': { label: '设备维护', defaults: ['operator'] },
  // T8 第四批（2026-10-25）：应急模块**拆两个权限点**——照 inspect.manage / inspect.execute 的既有先例
  //   （配置面 vs 执行面分开：能改预案库 ≠ 能处置预警）。
  //   emergency.manage = 应急预案库 CRUD（plans 3 处）——知识库 / 目录，配置性质
  //   emergency.handle = 预警处置（alerts 创建 / 处置 / 关联预案 / 转工单 4 处）——执行面动作
  //   🔴 两者都默认给 operator 是**为了等价**（原 requireConfigRole 白名单就是 admin+operator），
  //     不是策略选择；是否收紧属独立产品决策，不在本批夹带（E6）。
  //   ⚠️ 已知待决（登记，未做）：worker 当前**不能处置预警**（等价迁移保留了原行为）。
  //     收敛后租户可自行授予 emergency.handle —— 这正是本次收敛兑现的价值。
  'emergency.manage': { label: '应急预案库', defaults: ['operator'] },
  'emergency.handle': { label: '预警处置', defaults: ['operator'] },
  // T8 第五批（2026-10-25）：网管监控模块**拆两个权限点**，与 emergency 同构
  //   （照 inspect.manage / inspect.execute 的既有先例：配置面 vs 执行面分开）。
  //   monitor.manage = 监控设备台账 CRUD（POST / PUT /devices 2 处）——配置面
  //   monitor.handle = 告警处置（设备告警上报 / resolve / convert 3 处）——执行面
  //   🔴 两者都默认给 operator 是**为了等价**（原 requireConfigRole 白名单就是 admin+operator），
  //     不是策略选择；是否收紧属独立产品决策，不在本批夹带（E6）。
  //   ⚠️ 已知待决（登记，未做）：worker 当前**不能处置监控告警**（等价迁移保留了原行为），
  //     收敛后租户可自行授予 monitor.handle。
  'monitor.manage': { label: '监控设备', defaults: ['operator'] },
  'monitor.handle': { label: '告警处置', defaults: ['operator'] },
  // T8 第六批（2026-10-25）：人员（worker 档案）主数据维护。**只用一个点、不拆**：
  //   4 处全是「人员主数据维护」——档案 CRUD 3 处 + 一键入驻（建账号 + 档案）1 处，
  //   没有配置面 / 执行面之分（不像 inspection / emergency / monitor 那样要拆 manage + handle）。
  //   命名 `worker.manage`、label 用「人员档案」，避免被误读成「worker 角色的权限」。
  //   🔴 operator 默认给是**为了等价**（原 requireConfigRole 白名单 admin+operator），非策略选择。
  //   ⚠️ POST /workers/with-account 之后还有一层 canAssignRole(auth.role,'worker')（事务外同步），
  //     worker.ts:180 注释自述「当前矩阵恒真」（ROLE_RANK.worker=1 最低，所有角色均 ≥1）
  //     ⇒ 守卫移入事务内导致的顺序反转不改变实际行为，本批不动它。
  'worker.manage': { label: '人员档案', defaults: ['operator'] },
  // T8 第七批（2026-10-25）：I4 灰度总开关（租户级 AI 能力生杀）。**读+写共用一个点**：
  //   GET /ai/features 虽是读端点，但原实现就带配置角色守卫 —— 它属**管理面配置读取**
  //   （小程序侧印证：只有 pages/admin/agents/ 调它），不是业务数据读取 ⇒ 等价迁移保留读守卫，不摘。
  //   不复用 basicdata.edit：AI 能力总开关是独立功能域，与「基础数据」不是一回事
  //   （role.ts:69 已把"蹭 basicdata.edit"定为淘汰做法）；判据沿用批 3 equipment：独立模块 → 独立点。
  //   🔴 operator 默认给是**为了等价**（原白名单 admin+operator），非策略选择。
  'ai.manage': { label: 'AI 功能', defaults: ['operator'] },
  // T8 第九批（2026-10-25）：服务反馈模块独立权限点。**只用一个点、不拆**（照批 6 worker 判据）：
  //   2 处端点 —— POST /:id/reply（回复处置）+ GET /export（CSV 导出，R9-F1 认定属管理面）——
  //   同属「处理服务反馈」一件事的两面，没有配置面 / 执行面之分（不像 emergency / monitor 要拆
  //   manage + handle）。拆成 reply / export 两个点会得到一对几乎总是一起授予的点 = 伪粒度。
  // 🔴 为什么不复用 ticket.manage：它 defaults 含 dispatcher/reviewer/service_desk，
  //    复用会把这三个角色从 403 变放行（破坏等价），且反馈不是工单。
  // 🔴 为什么不蹭 basicdata.edit：见 inspect.manage 注释——蹭基础数据是淘汰做法；
  //    反馈是独立业务域（自有 feedback 表 + PRD §D + 事件总线）。
  // 🔴 operator 默认给是**为了等价**（原白名单 admin+operator），非策略选择。
  'feedback.manage': { label: '服务反馈', defaults: ['operator'] },
  // T8 第十批（2026-10-25）：巡更模块独立权限点。**只用一个点、不拆**：
  //   4 处全是**配置面** —— 点位 CRUD 3 处（POST/PUT/DELETE /points）+ 任务创建 1 处（POST /tasks）；
  //   执行面（checkin / miss）本来就无守卫 ⇒ 不新增 patrol.execute（YAGNI：没有检查点的权限点是空头支票）。
  // 🔴 为什么不复用 `inspect.manage`（巡检配置）：**两套表**（patrol_point / patrol_task
  //    vs inspection_plan / _task / _point / _item / _record 六张）、**两个前端页面**
  //   （PatrolPage vs InspectionPage + InspectionPlansPage）⇒ 复用会「只管巡检的人顺带能改巡更任务」。
  // 🔴 operator 默认给是**为了等价**（原 requireConfigRole 白名单 admin+operator），非策略选择。
  'patrol.manage': { label: '巡更配置', defaults: ['operator'] },
  // T8 第十一批（2026-10-25）：服务台模块独立权限点。**只用一个点、不拆**：
  //   4 处全是**配置面** —— 服务台主数据（POST/PUT /service-desks）+ 客服人员编排
  //   （POST/DELETE /service-desks/:id/agents）；**代申告 POST /tickets 不在内**
  //   （它是坐席执行动作，早已走 intake.create，本批不动）。
  // 🔴 为什么不复用 `basicdata.edit`：**两套表**（service_desk + service_desk_agent）、
  //   独立业务域（批次 C，自带代申告通道与幂等键），且蹭基础数据是已淘汰做法。
  //   ⚠️ 服务台配置入口确在 `BasicData.tsx` / `AdminPage.tsx`，但那只是**页面归属**，
  //      不是权限点归属 —— 按页面判会把服务台和字典/术语捆成"要么都给要么都不给"。
  // 🔴 operator 默认给是**为了等价**（原 requireConfigRole 白名单 admin+operator），非策略选择。
  'servicedesk.manage': { label: '服务台配置', defaults: ['operator'] },
} as const satisfies Record<string, { label: string; defaults: readonly Role[] }>;

/** 权限点清单（由 PERM_DEFS 派生，勿手改）。 */
export const PERMS = Object.keys(PERM_DEFS) as unknown as readonly Perm[];

export type Perm = keyof typeof PERM_DEFS;

// ─────────────────────────────────────────────────────────────────────────────
// 【T3 实例级权限（2026-10-24）】perm 的两种形态
//
//   全局授权：   ticket.manage                 ← 存量行全是这个形态
//   实例级授权： ticket.manage@transport_task  ← 新增：只对某类单据生效
//
// 🔴 **为什么用模板字面量 `${Perm}@${string}` 而不是直接放宽成 `string`**：
//   `requirePermission(..., perm: Perm)` 的参数类型是 `Perm`，这是架构🔴1⑤ 的修复成果
//   ——**权限点拼错在编译期就炸**（此前传 'settlment.read' 这种错字也能编译过，
//     运行期恒 403 且极难排查）。放宽成 `string` ⇒ 这个收益当场归零。
//   模板字面量能让 **`@` 前面的 base 部分继续受 PERMS 约束**：
//     ✅ 'ticket.manage@transport_task'   （base 合法）
//     ❌ 'ticket.mange@transport_task'    （拼错 ⇒ 编译期报错，这正是 V4 要验的）
//
// ⚠️ **`@` 后面（entityType）编译期管不了**：`${string}` 什么都收。
//   ⇒ 必须有 **S5 的运行时白名单**兜住，否则 `ticket.manage@随便写` 能进库，
//     权限配置变成不可控的垃圾。详见下方 `assertEntityTypeScope()`。
// ─────────────────────────────────────────────────────────────────────────────

/** 实例级权限 key：`权限点@单据类型`，如 `ticket.manage@transport_task`。 */
export type PermScope = `${Perm}@${string}`;

/** 落库/判定时的 perm 形态：全局 或 实例级。 */
export type PermKey = Perm | PermScope;

/** 取权限点的 base 部分（去掉 `@单据类型` 后缀）：`ticket.manage@transport_task` ⇒ `ticket.manage`。 */
export function permBase(perm: string): string {
  const at = perm.indexOf('@');
  return at < 0 ? perm : perm.slice(0, at);
}

/**
 * 🔴 实体类型形状（**全仓唯一一份**，routes/businessFlow.ts 也从这里引）。
 *
 * 为什么放在 middleware 而不是留在 businessFlow：S5 的运行时白名单要在本文件里校验
 * entityType，而 `role.ts → businessFlow.ts` 会形成**运行时循环依赖**（businessFlow 已
 * import 本文件的 requireConfigRole）⇒ 只能把这份正则放在依赖方向的上游。
 * ⚠️ 因此 **businessFlow.ts 不许再自己留一份副本**——两个正则迟早漂移。
 */
export const ENTITY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * S5 运行时白名单：entityType 部分编译期管不了（`${string}` 什么都收），
 * 不校验的话 `ticket.manage@随便写` 能进库 ⇒ 权限配置变成不可控。
 *
 * 校验两件事：
 *   ① 形状（ENTITY_RE）——不合法直接 400，**不静默放行**；
 *   ② 可选：是否在 `listEntityTypes()` 内（调用方传入 known 集合时才判）。
 *
 * @param entityType 单据类型
 * @param known      可选：合法的实体类型全集（`businessFlow.ts` 的 `listEntityTypes` 结果）。
 *                   传了 ⇒ 不在集合内也 400（防"写错但形状合法"的垃圾进库）。
 */
export function assertEntityTypeScope(entityType: string, known?: readonly string[]): void {
  if (!ENTITY_RE.test(entityType)) {
    throw new AppError(
      'BAD_PARAM',
      `invalid entity_type for permission scope: ${JSON.stringify(entityType)}（只允许 ${ENTITY_RE.source}）`,
      400,
    );
  }
  if (known && !known.includes(entityType)) {
    throw new AppError(
      'BAD_PARAM',
      `unknown entity_type for permission scope: ${entityType}（可用清单见 GET /flow/entities）`,
      400,
    );
  }
}

// 默认权限矩阵（内置；租户可经 role_permission 表覆盖）。
// 新角色按最小权限给默认：reviewer 审核工单（看板+工单）；service_desk 接线派单（+派单覆盖）。
// 批次三：settlement.read（列表/详情/导出）默认 admin/operator；settlement.edit 仅 admin；
// 其余角色不给结算权限点（未覆盖存量租户随默认矩阵自动生效，批次二已实证该机制）。
// E-8（BUG-009 收紧，2026-09-14）：外部测试反馈 operator 默认可读结算过宽 → operator 移除
//   settlement.read（settlement.edit 本就仅 admin）。影响面：
//   - 无 role_permission 覆盖行的租户：operator 立即失去结算列表/详情/导出（FE 菜单随 /auth/me
//     permissions 收起，API 403）——行为变化即本次修复目的；
//   - 有覆盖行的租户：以租户显式授权为准，不受默认矩阵变化影响（租户自治，不做强制清洗）；
//   - 回滚方式：租户经角色管理授予 settlement.read，或代码还原本矩阵（无 DDL、无数据迁移）。
//   权限矩阵本身**无需 DDL**（默认矩阵为代码层事实，role_permission 表无种子行——046/070
//   只建表/扩 CHECK，从不 INSERT 默认权限）；E-9 的 084 迁移位已用于耗材联动
//   （settlement_item.source/material_id + 唯一约束放宽 + inventory_log.work_order_id uuid→text）。
// 流程审核一期：workflow.edit 维持现状不动（operator 默认矩阵本就不含，行为零变化）；
// workflow.approve 仅 admin（经 admin 的 [...PERMS] 自动收录，勿在其它角色清单里手加）。
/**
 * 角色默认权限矩阵 —— **由 PERM_DEFS 派生，勿在此手工列清单**。
 * 各权限点「默认给哪些角色」写在 PERM_DEFS[x].defaults 里，此处只做反查聚合。
 * admin 恒全量（`[...PERMS]`）：新权限点自动进 admin 口袋，无需逐行补（沿用改造前语义）。
 *
 * ⚠️ 派生顺序按 PERM_DEFS 定义顺序 ⇒ 与改造前的手写清单**顺序可能不同、集合完全一致**。
 *    实测逐角色比对：admin/operator/dispatcher/reviewer/service_desk 五角色顺序也一致，
 *    仅 worker 一处顺序变化（原 ['inspect.execute','asset.scan','intake.create','consumable.consume']
 *    → 现 ['intake.create','inspect.execute','asset.scan','consumable.consume']），集合相同、
 *    语义无影响（排序未在任何断言里被锚定）。
 *
 * 历史决策留痕（原在此处的注释，已随权限点下沉到 PERM_DEFS 各条目）：
 *   E-8 移除 operator 的 settlement.read；E-9 operator 加 consumable.consume、不加 material/asset.manage；
 *   T8 operator 加 inspect.manage（等价需要，非策略选择）。
 */
export const DEFAULT_PERM_MATRIX: Record<Role, readonly Perm[]> = (() => {
  const m = {} as Record<Role, Perm[]>;
  for (const r of ROLES) m[r] = [];
  m.admin = [...PERMS];
  for (const [perm, def] of Object.entries(PERM_DEFS)) {
    for (const r of def.defaults) m[r].push(perm as Perm);
  }
  return m;
})();

// 角色层级（数值越大权限越高）；用于账户写接口的"不可越级/不可提权"门禁。
// service_desk 与 dispatcher 同层（2）：接线派单属执行管理层；reviewer 与 operator 同层（3）：
// 质量审核属管理动作。同层仅影响 canAssignRole 的 <= 比较，不破坏 worker<dispatcher<operator<admin 严格序。
export const ROLE_RANK: Record<Role, number> = {
  worker: 1,
  service_desk: 2,
  dispatcher: 2,
  reviewer: 3,
  operator: 3,
  admin: 4,
};

// —— 自定义角色（地基第二步）——
// 090 迁移已建租户级 role_def 表，并放宽 account_user.role / role_permission.role 的枚举 CHECK。
// 代码层同步：合法角色不再只有内置 6 个，租户自建岗位（如"维修组长" repair_lead）同为合法角色。
//
// ⚠️ 为什么要改：改造前 `ROLE_RANK[自定义角色]` 恒为 undefined，
//   canAssignRole 里 `undefined <= callerRank` 恒 false → **自定义岗位根本分配不出去**
//   （090 放宽了 DB CHECK，但代码层仍把门关着）。此处给自定义角色一个确定层级。

/** 角色 code 形状（与 090 role_def.code 的 CHECK 同口径，内外一致，避免双标）。 */
export const ROLE_CODE_RE = /^[a-z][a-z0-9_]{1,31}$/;

/** 自定义角色的兜底层级：与 worker 同层（最低）——自建岗位不得天然高于既有执行岗。 */
export const CUSTOM_ROLE_RANK: number = ROLE_RANK.worker;

/**
 * 角色层级解析（单一事实源）：内置角色查 ROLE_RANK，自定义角色取 CUSTOM_ROLE_RANK。
 * 缺失/空 → 0（fail-closed，与 isAdmin 的 `?? 0` 同口径）。
 */
export function roleRank(role: string | undefined): number {
  if (!role) return 0;
  return ROLE_RANK[role as Role] ?? CUSTOM_ROLE_RANK;
}

/** 角色 code 形状校验（内置与自定义同口径）。 */
export function isValidRoleCode(code: string): boolean {
  return ROLE_CODE_RE.test(code);
}

// —— 角色分组（单一事实源，架构🟡12）——
// 此前 'admin'/'operator' 这类角色名以字面量散落在 config.ts / llmUsage.ts / accounts.ts /
// workOrder.ts 等处，新增角色要改 N 处。集中到这里，各处只引用分组常量与判定函数。
/** 管理配置类资源（派单规则 / 术语 / 系统配置 / 账户写）的角色：admin 全权 + operator 业务配置。 */
export const CONFIG_ROLES: readonly Role[] = ['admin', 'operator'];
/**
 * 运维类后台动作（SLA 扫描 / 通知自检 / 巡检报表导出）的角色：一线 worker / reviewer 不参与。
 * 【用户要求①】摘除退场的 dispatcher；运维职责落到 admin/operator（operator 默认矩阵含
 * dispatch.override，SLA 扫描/通知自检这类调度运维动作能力零损失）。
 */
export const OPS_ROLES: readonly Role[] = ['admin', 'operator'];

/** admin 判定：按 ROLE_RANK 取最高层级（admin=4 且唯一），避免 role === 'admin' 字面量散落。 */
export function isAdmin(role: string | undefined): boolean {
  if (!role) return false;
  return (ROLE_RANK[role as Role] ?? 0) >= ROLE_RANK.admin;
}
/** 配置类角色判定（与 requireConfigRole 同口径）。 */
export function isConfigRole(role: string | undefined): boolean {
  return !!role && CONFIG_ROLES.includes(role as Role);
}
/** 运维类角色判定。 */
export function isOpsRole(role: string | undefined): boolean {
  return !!role && OPS_ROLES.includes(role as Role);
}
/** admin 判定的"含 dev 放行"版（dev 模式恒 true，与既有 dev 约定一致）。 */
export function isAdminOrDev(auth: AuthLocals): boolean {
  return auth.authMode === 'dev' || isAdmin(auth.role);
}
/** admin 门禁：非 admin → 403。 */
export function assertAdmin(auth: AuthLocals, message = 'admin only'): void {
  if (!isAdminOrDev(auth)) throw new AppError('FORBIDDEN', message, 403);
}
/**
 * 运维后台动作门禁（QA🟡7 / 架构🟡12）：非运维角色 → 403。
 * 用途：/sla/scan、/open/notify/selftest 等会真实消耗外部配额或改动全租户数据的端点。
 */
export function assertOpsRole(auth: AuthLocals): void {
  if (auth.authMode === 'dev') return;
  if (!isOpsRole(auth.role)) {
    throw new AppError('FORBIDDEN', `role ${auth.role ?? '(none)'} not allowed for this operation`, 403);
  }
}

/**
 * 角色分配门禁（R15-005 修复）：账户写接口（建/改）据此阻止越级与提权。
 *   - admin 可分配任意角色（含 admin）；
 *   - operator 可分配 operator/dispatcher/worker，但**绝不可分配 admin**（防铸造管理员）；
 *   - 任何非 admin 调用方都不可分配高于自身层级的角色。
 * 说明：账户管理写接口本身由 requireConfigRole 限定为 admin/operator，
 * 本门禁进一步收窄 operator 的授权边界，消除"operator 自提权 / 铸造 admin"的内鬼路径。
 */
export function canAssignRole(caller: string | undefined, target: string): boolean {
  if (caller === 'admin') return true;
  // caller 缺失沿用原语义（按 worker 层计，而非 0），避免收紧既有行为。
  const callerRank = roleRank(caller ?? 'worker');
  const targetRank = roleRank(target);
  // 非 admin 既不能分配高于自身的角色，也绝不可分配 admin。
  // 自定义角色取 CUSTOM_ROLE_RANK → operator/worker 均可分配（090 已允许建，此处放行分配）。
  return target !== 'admin' && targetRank <= callerRank;
}

/** 默认矩阵判定（无租户覆盖时用）；admin 恒 true */
export function hasPermDefault(role: string | undefined, perm: string): boolean {
  if (!role) return false;
  if (role === 'admin') return true;
  return (DEFAULT_PERM_MATRIX[role as Role] ?? []).includes(perm as Perm);
}

/**
 * 租户级权限判定：role_permission 表有该租户该角色的行 → 用覆盖集合；
 * 无覆盖行 → 回退默认矩阵。admin 恒 true；dev 恒 true。
 *
 * 【T3 实例级作用域（2026-10-24）】新增第 4 参 `entityType`：
 *   - 不传 ⇒ 纯全局判定（**存量调用点行为完全不变**）。
 *   - 传了 ⇒ 命中顺序：① 全局 `ticket.manage` 优先放行；② 否则查 `ticket.manage@<entityType>`。
 *     ⇒ 租户可以只把 `workflow.approve@transport_task` 授给某人，他能批运送流程、批不了巡检。
 *
 * ⚠️ **已知边界（不是 bug，是当前语义，改动前必须重读）**：
 *   默认矩阵路径（无覆盖行）只判**全局形态**，entityType 不参与。因为默认矩阵是平台内置、
 *   只含全局 perm，实例级授权只能由租户显式写 role_permission 行产生。
 *   ⇒ 若将来往 DEFAULT_PERM_MATRIX 里塞 `x@entity` 形态，此处必须同步改，否则静默失效。
 */
export async function hasPerm(
  auth: AuthLocals,
  client: PoolClient,
  perm: string,
  entityType?: string,
): Promise<boolean> {
  if (auth.authMode === 'dev') return true;
  if (auth.role === 'admin') return true;
  const r = await client.query(
    `SELECT perm FROM role_permission WHERE tenant_id = $1 AND role = $2`,
    [auth.tenantId, auth.role ?? ''],
  );
  if (r.rowCount && r.rowCount > 0) {
    const set = new Set(r.rows.map((x: { perm: string }) => x.perm));
    // ① 全局授权：命中即放行（存量行全是这个形态 ⇒ 存量行为不变）
    if (set.has(perm)) return true;
    // ② 实例级授权：`perm@entityType` 只在作用域匹配时放行
    if (entityType) return set.has(`${perm}@${entityType}`);
    return false;
  }
  return hasPermDefault(auth.role, perm);
}

/** 列出该租户该角色最终生效的全部权限点（/auth/me 与前端菜单过滤用） */
export async function listPerms(auth: AuthLocals, client: PoolClient): Promise<string[]> {
  if (auth.authMode === 'dev') return [...PERMS];
  if (auth.role === 'admin') return [...PERMS];
  const r = await client.query(
    `SELECT perm FROM role_permission WHERE tenant_id = $1 AND role = $2`,
    [auth.tenantId, auth.role ?? ''],
  );
  if (r.rowCount && r.rowCount > 0) {
    return r.rows.map((x: { perm: string }) => x.perm);
  }
  return [...(DEFAULT_PERM_MATRIX[(auth.role as Role) ?? 'worker'] ?? [])];
}

/**
 * 权限守卫（async，需在 withTenantClient 内调用）：无权限抛 403。
 * 审查修复（架构🔴1⑤）：参数类型由 string 收紧为 Perm——编译期就暴露拼错/未登记的权限点
 * （此前传入 'settlment.read' 这类错字也能通过编译，运行期恒 403 且难排查）。
 */
export async function requirePermission(
  auth: AuthLocals,
  client: PoolClient,
  perm: Perm,
  entityType?: string,
): Promise<void> {
  if (!(await hasPerm(auth, client, perm, entityType))) {
    // 403 消息带上作用域，否则"为什么批不了这个流程"在日志里查不出来（E3 不静默失败）
    const scope = entityType ? `${perm}@${entityType}` : perm;
    throw new AppError('FORBIDDEN', `permission denied: ${scope}`, 403);
  }
}

/**
 * 任一满足型权限守卫：多个权限点命中任意一个即放行（全部不满足才 403）。
 * 用途：同一动作存在多条合规权限路径时避免权限矩阵回归——如登录态建单
 * （/open/work_order）：operator 等走 ticket.manage，worker 走 intake.create（#942 R15：
 * 陪检登记复用建单引擎，此前仅挂 ticket.manage 把工人登记陪检当场 403）。
 * 覆盖表模式：role_permission 行的权限集合与 perms 有交集即放行。
 */
export async function hasPermAny(
  auth: AuthLocals,
  client: PoolClient,
  perms: readonly Perm[],
  entityType?: string,
): Promise<boolean> {
  if (auth.authMode === 'dev') return true;
  if (auth.role === 'admin') return true;
  const r = await client.query(
    `SELECT perm FROM role_permission WHERE tenant_id = $1 AND role = $2`,
    [auth.tenantId, auth.role ?? ''],
  );
  if (r.rowCount && r.rowCount > 0) {
    const set = new Set(r.rows.map((x: { perm: string }) => x.perm));
    // 与 hasPerm 同口径：全局命中优先，否则查 `perm@entityType`
    return perms.some((p) => set.has(p) || (entityType ? set.has(`${p}@${entityType}`) : false));
  }
  return perms.some((p) => hasPermDefault(auth.role, p));
}

export async function requireAnyPermission(
  auth: AuthLocals,
  client: PoolClient,
  perms: readonly Perm[],
  entityType?: string,
): Promise<void> {
  if (!(await hasPermAny(auth, client, perms, entityType))) {
    throw new AppError('FORBIDDEN', `permission denied: ${perms.join('|')}`, 403);
  }
}

/**
 * 旧守卫（同步、throw）：admin/operator 可管理配置类资源。保持兼容。
 * 审查修复（架构🟡12）：白名单改引 CONFIG_ROLES 单一事实源（不再内联 role !== 'admin' && ...）。
 */
export function requireConfigRole(_req: unknown, res: any): void {
  const role = res.locals.auth.role;
  if (!isConfigRole(role)) {
    throw new AppError('FORBIDDEN', 'only admin/operator can manage', 403);
  }
}

/**
 * #583 归属守卫（异步，需在 withTenantClient 内调用）：
 * 巡检/运送执行端点（checkin/records/complete/exception/tracks/transition）权限模型：
 *  - admin / operator：恒放行（管理不受限，保持原语义）
 *  - worker：仅当任务归属本人（owner 字段 == 当前 worker.id）放行，否则 403
 *  - 孤儿任务（owner 为空）：仅 admin/operator 可操作，worker 无权（防卡死也防越权）
 * dev 模式放行（维持本地联调/测试兼容）。
 */
export async function requireAssigneeOrConfig(
  client: PoolClient,
  auth: AuthLocals,
  owner: string | null | undefined,
  label = 'task',
): Promise<void> {
  if (auth.authMode === 'dev') return;
  if (auth.role === 'admin' || auth.role === 'operator') return;
  if (auth.role !== 'worker') {
    throw new AppError('FORBIDDEN', `only admin/operator or assigned worker can operate ${label}`, 403);
  }
  const wid = auth.userId;
  if (!wid) throw new AppError('UNAUTHORIZED', 'missing identity', 401);
  if (!owner || String(owner).trim() === '') {
    // 孤儿任务：未指派，仅管理角色可操作
    throw new AppError('FORBIDDEN', `unassigned ${label}, only admin/operator can operate`, 403);
  }
  // JWT sub=account_user.id → 经 worker.account_id 反查真实 worker.id（业务编码），再比对 owner
  const r = await client.query(
    'SELECT id FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1) LIMIT 1',
    [wid, auth.tenantId],
  );
  if (r.rowCount === 0) throw new AppError('FORBIDDEN', 'worker profile not found', 403);
  const myWorkerId: string = r.rows[0].id;
  if (myWorkerId !== String(owner)) {
    throw new AppError('FORBIDDEN', `${label} is assigned to another worker`, 403);
  }
}
