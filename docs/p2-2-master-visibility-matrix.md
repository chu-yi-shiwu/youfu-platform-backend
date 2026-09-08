# P2-2 师傅分派机制：派了才可见 —— 可见性矩阵与实现口径

> 立项依据：初一拍板「师傅分派机制 = 派了才可见」，兼容 8 operator 试点。
> 实现落点：`src/routes/workOrder.ts`（MASTER_ROLES + 列表/详情双端点 scope）。
> 回归护栏：`src/test/workOrderMasterVisibility.http.test.ts`（M1~M9）。
> 状态：代码+测试全绿（typecheck 0 错，vitest 85/85 文件通过），待 QA 增量复验。

## 1. 核心口径

- **师傅角色集合**：`MASTER_ROLES = ['worker', 'operator']`。
  判定依据：operator 即生产 8 试点的小程序师傅身份，与 worker 同属「一线接单人」，
  分派机制的可见性约束必须同等覆盖，否则 operator 视角会看到全量未分派单，口径破洞。
- **派了才可见**：师傅角色的工单列表/详情一律按 `assignee = 本人` 过滤；
  未分派单（`assignee_id IS NULL`）对师傅不可见。
- **唯一例外面**：抢单大厅 `/open/claim-hall` 保持原状——8 operator 试点的抢单行为
  是有意保留的产品面，未分派工单对师傅的唯一可见入口就是抢单大厅。
- **降级纪律**：师傅档案查不到（`resolveWorkerId` 返回 null）→ `console.warn` + 放行全量，
  不拒绝、不过滤。一线可用性优先于收口；降级路径自身不得 500（本次顺带加了
  `rows.length === 0` / `rows[0]?.id` 防御）。

## 2. 可见性矩阵

### 2.1 列表（GET /open/work_orders）

| 角色 | 分派状态 | 可见性 | 说明 |
| --- | --- | --- | --- |
| worker | assignee=本人 | ✅ 可见 | scope 强制注入 |
| worker | assignee=他人 | ❌ 不可见 | 显式传 assignee=他人 被覆盖（防越权） |
| worker/operator | assignee_id=NULL（未分派） | ❌ 不可见 | 唯一入口=抢单大厅 |
| operator | 任意 | 同 worker | P2-2 新行为（此前不过滤） |
| admin / dispatcher / service_desk 等 | 任意 | 不变 | 非师傅角色零变化 |

### 2.2 详情（GET /open/work_order/:id）

| 角色 | 单据 assignee | 状态码 | 说明 |
| --- | --- | --- | --- |
| worker / operator | 本人 | 200 | 正常作业 |
| worker / operator | 他人 | 403 | 既有行为回归（worker 原有） |
| worker / operator | NULL（未分派） | 403 | 派了才可见；文案指向抢单大厅 |
| admin 等 | 任意 | 不变 | 非师傅角色零变化 |

### 2.3 抢单大厅（GET /open/claim-hall）

| 角色 | 行为 | 说明 |
| --- | --- | --- |
| operator（及其他 claim 白名单角色） | 不变 | 未分派单照常可见可抢，8 试点兼容 |

注：claim-hall 的角色白名单单一事实源为本租户 workflow_def 的 claim 转移
allowedRoles（架构🟡12 既定口径），P2-2 未触碰该端点。

## 3. 实现细节

- 列表端点：原 `role === 'worker'` 分支扩展为 `MASTER_ROLES.includes(role)`，
  scope 注入逻辑不变（`resolveWorkerId` 解析本人 worker.id → 覆盖显式 assignee 参数）。
- 详情端点：同扩展；403 文案改「仅可查看分派给本人名下的工单（未分派工单请到抢单大厅）」。
- `resolveWorkerId` 防御加固：`rowCount===0 || rows.length===0 → null`、
  `rows[0]?.id ?? null`——保证降级路径自身永不 500。

## 4. 回归护栏（M1~M11）

| 用例 | 断言 |
| --- | --- |
| M1 | worker 列表：显式 assignee=他人被覆盖为本人（防越权） |
| M2 | operator 列表：scope 注入本人（P2-2 新行为） |
| M3 | admin 列表：不注入过滤，零变化 |
| M4 | 档案查不到 → 放行全量（降级纪律，列表侧） |
| M5/M6 | worker 详情：本人 200 / 他人 403 |
| M7 | operator 详情：未分派 NULL → 403 |
| M8 | operator 详情：本人单 200 |
| M9 | claim-hall 未分派单照常可见（试点兼容回归） |
| M10 | 详情侧降级：operator 档案查不到 → 放行 200（QA 复验缺口①补齐） |
| M11 | operator 列表：显式 assignee=他人被覆盖（QA 复验缺口②补齐） |

> M10/M11 为 QA 增量复验（三单全 PASS）提出的两条信息级缺口，已当场补齐。

## 5. 生效与风险

- 本次仅代码落库（commit + REST 回灌远端），**生产生效随下次发布窗口**，与 P2-7/P3 同批。
- 上线后观察点：operator 列表为空的单量（若有 operator 报「看不到单」，先区分
  未分派（预期）vs 已分派但档案未关联（走降级 warn 日志排查））。
