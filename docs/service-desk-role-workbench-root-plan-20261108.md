# 服务台 / 角色 / 工作台：根治方案复核（2026-11-08）

## 实施进度（2026-11-08 本轮）

已完成（代码 + 测试 + pilot 部署）：

- `110_principal_rls.sql`：请求级 RLS（work_orders / ticket_event / transport_order），
  `app.scope / app.user_id / app.worker_ids / app.claim_hall`，`created_by`；
- `authMiddleware` + AsyncLocalStorage + `withTenantClient` fail-closed（系统/公开显式 system）；
- 删除 `MASTER_ROLES`；列表/详情不再按端点写可见性；抢单大厅/认领使用 claim_hall 能力；
  自动派单/退回重派在赋值语句内临时 system（`withTenantScope`）；
- `111_department_model.sql`：`dept.is_default`、`department_route_rule`、
  `work_orders/worker.department_id` 复合外键、存量回填默认部门；
- `repo/departmentResolver.ts`：显式 > 路由规则 > 默认部门；规则支持
  business_type/catalog/location/asset/reporter/source/description；
- `createWithIdem` 建单统一自动归属部门；`transition` 在默认部门单派/抢后
  late-bind 到处理人部门；
- `GET /stats/workbench` + `bucket` 下钻 + `engine/workbenchBuckets.ts`；
- `112_drop_service_desk.sql`：`department_id` 收紧 NOT NULL；删除
  `work_orders.service_desk/department`、`worker.department`、`service_desk` 表、
  建单强制服务台开关、`servicedesk.manage` 权限覆盖；
- 后端删除 `/service-desks`、`/config/ticket-require-service-desk`、`/transpond`；
  新增 `POST /open/work_order/:id/change-department`；
- PC 管理端：工作台接 `/stats/workbench`，列表接 `department_id/bucket/offset`，
  详情“转台”改“改部门”，删除服务台管理 Tab 与建单开关；
- PC 登录阻断 worker；小程序阻断 operator（运营仅 PC，师傅仅小程序）；
- `113_evaluated_score_check.sql`：评价态必须有分数；
- 新增 `principalRls` / `departmentResolver` / `workbenchStats` 真库测试；
- 后端全量测试、`tsc`、build、releaseGate 通过；前端 231 用例、`tsc`、Vite build 通过；
- pilot 已应用 110/111/112/113，部署新后端与 PC 管理端；`zixing-hospital` 工单已清零，
  默认部门 `总务科`、`W0001.department_id` 已就位；小程序 v5.9.14 已上传。

未完成（下一步）：

- 主站 `youfu` 仍是 10-30 旧后端/旧前端，需按“先部署新后端、再应用 112”的顺序切换；
- 主站 6 个 `w_*` operator 账号需改为 worker 并强制重新登录；
- `department_route_rule` 已有管理入口（基础数据 → 部门路由规则），但试点租户尚未配业务规则，当前靠默认部门兜底；
- 主站历史演示数据清理与最终验收。

> 结论先行：**服务台（service_desk）作为工单字段应删除；保留“部门（二级机构）”并把它做成真正的派单/可见性维度。**
> 自动派单后不需要“服务台”这个概念来派单，但需要“部门”来确定这是谁的事。
> 如果医院确实有“总服务台/呼叫中心”，那是运营岗位或工作地点，不是每张工单的归属字段。
>
> **部门必填，但不靠运营手工补。** 后端在建单时自动识别部门（资产 → 故障分类 → 位置 → 报修人 → 业务类型 → 默认部门），
> 运营端只在识别错时修改；公开报修端完全不出现“选部门”。

---

## 一、已核实的事实（代码 + 主站库）

### 1. 服务台目前只是一个“标签”，没有派单能力

- `018_service_desk.sql` 的 `service_desk` 只有 `id / tenant_id / name / template`；
- `template` 字段全仓没有读取点，写了也不生效；
- 坐席表 `service_desk_agent` 已下线；
- `notification` 里 `recipient_kind='desk'` 的记录为 **0 条**；
- 转台端点 `workOrder.ts:1096` 只更新 `work_orders.service_desk`，不改处理人、不改状态；
- 转台时给“服务台”发的通知（`workOrder.ts:1119`）没有坐席表可投递，属于死信；
- `serviceDesk.ts` 只有 GET/POST/PUT，**没有 DELETE**，但 PC `AdminPage.tsx:122` 在调用 DELETE；
- 角色 `service_desk` 已退场，但主站仍有 `desk_tai` 账号。

### 2. 自动派单完全不看服务台，也不看部门

- `engine/dispatch/needResolver.ts` 只解析 `business_type` 和 `skill_tags`；
- `engine/dispatch.ts` 的 `matchRule` 只匹配 `business_type / priority / skill_tags`；
- `pickWorker` 只按 `active + skill_tags + load` 选人；
- 主站 9 条派单规则全部按 `business_type` 配置，没有一条按服务台或部门；
- 所以“服务台决定这单归谁”在当前代码里**不成立**。

### 3. 部门模型已经存在，但只做了一半

- `dept` 表已存在（043 迁移），主站有 `后勤科(001)`、`设备科(002)`；
- `work_orders.department` 是 `VARCHAR(64)`，建单页 `Intake.tsx` 写入的是 `dept.id`；
- 但 `worker.department` 全空，人员表单和 `/workers` API 都没有部门字段；
- `work_orders.department` 全空（52 张单全部 NULL）；
- `dept` 与 `work_orders/worker` 之间没有外键；
- 列表/详情多处直接把 `department` 的 UUID 显示出来，没有统一映射成部门名；
- 抢单大厅有部门过滤和跨部门拦截（`claimWorkOrder.ts:62-72`），但没有数据、没有自动推导、没有前端入口。

### 4. 主站数据证明“服务台”和“部门”是重复模型

- `service_desk`：`志愿者服务台`、`设备科`；
- `dept`：`后勤科`、`设备科`；
- `设备科` 在两个表里各有一份，说明服务台和部门在业务上就是同一层组织；
- 主站 52 张工单：`service_desk` 全 NULL、`department` 全 NULL；
- 主站租户开关 `ticket_require_service_desk = true`，但历史单全为空，配置与数据自相矛盾。

### 5. 角色模型与用户口径冲突

- `workOrder.ts:82`：`MASTER_ROLES = ['worker','operator']`；
- 这意味着 `operator` 在工单列表/详情里被当成“师傅”，只看本人单；
- 但主站 6 个 `w_*` 账号（w_hvac、w_electric、w_network…）角色是 `operator`，实际却是师傅；
- 用户口径：`worker` = 师傅，只在小程序、只看本人；`operator` = 运营，在 PC、看全局；
- 小程序 `roleHome.js` 把 `operator` 映射到 `pages/operator/accept/accept`，与“运营只用 PC”冲突；
- 主站 `role_permission` 没有租户覆盖，走默认矩阵；`dashboard.view` 默认不含 `worker`，这点与“师傅不看全局看板”一致。

### 6. 工作台确实存在“两套口径”

- `Dashboard.tsx:191` 拉 `limit=200` 的工单列表；
- `Dashboard.tsx:231` 用前端 `items/filtered` 自己算卡片；
- `TicketList.tsx:180` 只读取一次全局服务台，之后顶部切换不再跟随；
- `MainLayout.tsx:307-309` 在用户没选服务台时**自动选第一个**；
- `GlobalFilters.tsx:16` 的 localStorage key 不带租户，切租户会带旧 ID；
- `Dashboard.tsx:516` 的部门筛选还是硬编码 `A/B/C`，不是真实部门字典；
- `TicketList.tsx:269/274` 发 `cursor`，但后端只支持 `limit/offset`、不返回 cursor ⇒ “加载更多”永远不出现；
- `repo/stats.ts:52` 的 `/stats` 缓存 key 只有 `tenantId`，不接受筛选，写操作也不主动失效。

### 7. 本轮新发现的安全缺口

- `GET /open/work_order/:id/events`（`workOrder.ts:700`）没有任何归属校验；
- `POST /open/work_order/:id/photos`（`workOrder.ts:785`）没有归属校验；
- `POST /open/work_order/:id/voice`（`workOrder.ts:810`）没有归属校验；
- 也就是说，即使列表和详情把 worker 限制为“只看本人”，worker 只要知道 ID，仍可读别人事件、往别人工单里加照片/语音；
- 根因不是少一个 if，而是“工单可见性”没有下沉到数据层，各处直接查表。

---

## 二、服务台研判：删除，不保留

### 为什么不是“保留但改造”

1. **它没有路由能力**：自动派单不看它，转台也不改处理人/状态；
2. **它没有成员**：坐席表已删除，desk 通知 0 条，没人能接收；
3. **它没有模板效果**：`template` 字段无读取点；
4. **它和部门重复**：`设备科` 同时存在于 `service_desk` 和 `dept`；
5. **它制造了两套组织模型**：用户选服务台、部门又是另一套，筛选、统计、权限都会分叉；
6. **它让默认筛选变成隐藏陷阱**：自动选第一个服务台，52 张 NULL 单直接消失；
7. **它增加建单摩擦**：`ticket_require_service_desk=true`，但服务台没有实际作用。

### “二级服务台 = 部门”应该怎么落

- 一级机构 = `tenant`（现有租户）；
- 二级机构 = `dept`（现有部门表，建议补 `parent_id` 仅在未来多院区时使用）；
- 工单归属 = `work_orders.department_id`（**必填**）；
- 人员归属 = `worker.department_id`（可空；空 = 机动/共享人员，可服务任意部门）；
- 自动派单：有部门时只在本部门选人；无部门时按现有 `business_type + skill + load`；
- 本部门无人：进“本部门抢单大厅”，通知运营，**不静默派给别的部门**；
- 运营可手工跨部门派单（`dispatch.override`），留痕；
- “服务台”如果指接待窗口/呼叫中心，建模为 `location` 或岗位权限，不再挂在工单上。

### 推荐的数据迁移

```sql
-- 概念示意，正式迁移按仓库迁移规范写
ALTER TABLE dept ADD CONSTRAINT dept_tenant_id_uq UNIQUE (tenant_id, id);
ALTER TABLE dept ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX dept_one_default_per_tenant
  ON dept(tenant_id) WHERE is_default;

ALTER TABLE work_orders ADD COLUMN department_id uuid;
ALTER TABLE work_orders ADD COLUMN department_source text;
ALTER TABLE work_orders ADD COLUMN created_by text; -- account_user.id，RLS 创建人可见
ALTER TABLE worker ADD COLUMN department_id uuid;

-- 注意：department_id 是 NOT NULL，所以外键不能 ON DELETE SET NULL。
-- 用 RESTRICT：部门还有工单/人员时禁止删除，先转移再删，避免悬空和“删部门把单变无主”。
ALTER TABLE work_orders
  ADD CONSTRAINT work_orders_department_fk
  FOREIGN KEY (tenant_id, department_id) REFERENCES dept(tenant_id, id)
  ON DELETE RESTRICT;

ALTER TABLE worker
  ADD CONSTRAINT worker_department_fk
  FOREIGN KEY (tenant_id, department_id) REFERENCES dept(tenant_id, id)
  ON DELETE RESTRICT;

-- 两阶段上线（主站尤其重要）：
--   A. 先加 nullable 列 + 新后端开始写 department_id；
--   B. 新后端稳定、旧数据清空/回填后，再 SET NOT NULL。
-- 不能先 SET NOT NULL 再让旧后端继续插入，否则旧进程建单会 500。
-- ALTER TABLE work_orders ALTER COLUMN department_id SET NOT NULL;

-- RLS 性能索引（策略里会用到）
CREATE INDEX IF NOT EXISTS idx_wo_tenant_assignee ON work_orders(tenant_id, assignee_id);
CREATE INDEX IF NOT EXISTS idx_wo_tenant_created_by ON work_orders(tenant_id, created_by);
CREATE INDEX IF NOT EXISTS idx_transport_tenant_carrier ON transport_order(tenant_id, carrier);

-- 迁移 service_desk 主数据到 dept（按 name 去重合并，如“设备科”只保留一条）
-- “志愿者服务台”先确认它是部门还是团队/地点：是部门才进 dept，否则删除。
-- 历史数据可删，直接停止使用旧列；确认新后端上线后再 DROP
-- ALTER TABLE work_orders DROP COLUMN service_desk;
-- ALTER TABLE work_orders DROP COLUMN department;
-- ALTER TABLE worker DROP COLUMN department;
-- DROP TABLE service_desk;
```

> 主站目前还是 10-30 旧后端，**不能先删列**；必须在当前代码部署到主站时一起做，或只先在 pilot 4101 做。
> pilot 没有工单，历史数据可清，适合先落。

---

## 二·补、部门必填但不增加运营负担：自动识别设计

### 原则

**“必填”是数据结果，不是让运营每单选一次。**
工单落库时必须带 `department_id`，但这个值由后端自动解析，运营端只在识别错时修改。

### 为什么不用“给 91 个分类逐一加部门”

实测主站：

- `fault_category` 有 **91 条**；
- `fault_category.business_type` **全部为 NULL**；
- 如果要求运营逐条给 91 个分类配部门，就是直接增加门槛，和你的要求相反。

所以不用“每个字典表各加一个 department_id”的散点方案，
改成**一张部门路由规则表 + 自动推导**。

### 部门路由规则表 `department_route_rule`

```sql
id uuid
tenant_id text
name text
priority int              -- 越大越先匹配
enabled boolean
match_json jsonb          -- 匹配条件
department_id uuid        -- 命中后归属部门
created_at / updated_at
```

`match_json` 支持（全部可选，AND 语义）：

```json
{
  "business_type": "hvac",
  "catalog_id": "uuid",
  "catalog_code": "HVAC",
  "catalog_name_contains": "空调",
  "location_name_contains": "门诊",
  "asset_code": "ASSET-xxx",
  "reporter_id": "uuid",
  "source": "public_report",
  "description_contains": ["漏水", "爆管"]
}
```

### 解析顺序

```text
1. 运营显式指定 department_id（人工覆盖，最高优先）
2. 按 priority 从高到低匹配 department_route_rule，第一条命中生效
3. 都不命中 → 租户默认部门 dept.is_default = true
```

规则内部可以表达“故障分类优先于位置”：

- 电梯故障规则 priority=200，匹配 `business_type=elevator` → 设备科；
- 门诊区域规则 priority=100，匹配 `location_name_contains=门诊` → 后勤科；
- 门诊电梯单同时命中两条，取 priority 高的设备科，符合“专业条线优先”。

### business_type 怎么来

- 后端建单若传了具体 `business_type`（hvac/elevator/...），直接用；
- 公开报修落库是 `repair`，但分类名/描述可经现有
  `businessTypeForCategory(categoryName, description)` 推导出 hvac/elevator/...；
- 推导不中 → `repair`；
- 规则可以只写 9 条业务类型规则（hvac/water/plumbing/lighting/electric/
  elevator/network/security/repair），再加少量特殊分类规则（陪检、送氧、保洁等）。

这样运营只需要维护 **9~15 条规则**，不是 91 条分类。

### 默认部门

每个租户必须有一个 `dept.is_default = true` 的默认部门：

- 新租户开通时自动创建/指定；
- 现有租户迁移时指定一个（建议叫“调度中心”或“总务科”）；
- 识别不到任何规则时落到默认部门，`department_source='default'`；
- 运营不需要逐单补，系统只在工作台显示“默认归属单”数量，供抽查。

#### 关键：默认部门不能当“派单部门”用

如果默认部门是“调度中心”，而调度中心没有一线师傅，
自动派单若按 `department_id=默认部门` 过滤候选人，会把所有默认单都堵进抢单大厅。

正确处理：**默认部门是“待定归属”，不是“派单范围”**。

```text
department_source='default'
  → 自动派单不按部门过滤，仍按 business_type + skill + load 选人
  → 选中后把工单 department_id 改成该师傅的部门
  → department_source='assignee'
```

如果没人可派，进抢单大厅；认领时同样不按默认部门拦截，
认领成功后把工单部门改成认领人的部门。
运营在 PC 上手动派单时，如果原来源是 `default`，派给谁就回写谁的部门，
同样标记 `department_source='assignee'`。

只有 `source ∈ {explicit, rule, manual}` 的明确部门才作为自动派单的硬过滤条件。
这样既有“必填”，又不会让默认部门变成死队列。

### 识别结果要可解释

工单详情显示：

```text
责任部门：设备科
归属来源：规则「电梯故障 → 设备科」
```

如果是默认部门：

```text
责任部门：调度中心
归属来源：默认部门（未命中任何路由规则）
```

这样运营一眼能看出“为什么是这个部门”，只需要在明显错误时改一次，不需要每单判断。

### 运营端交互

- 建单页不再出现“必选部门”空下拉；
- 自动带出“责任部门：设备科（来源：规则「电梯故障」）”，旁边一个“修改”；
- 不修改就直接提交；
- 公开报修端完全不出现部门输入，但回执可以只读显示“已自动归到设备科”；
- 小程序师傅端也不出现部门字段；
- 运营改部门时，可勾选“以后同类自动归这个部门”，系统把这次修正
  变成一条新的 `department_route_rule`（或提高现有规则优先级）；
  这样修正一次，后面同类单不再麻烦运营。

### 防止“自动识别变成乱派”

- 规则只匹配显式配置的条件，不做模糊猜测；
- 多条规则命中时按 priority 取第一条，并把全部命中规则写入
  `ext.department_resolution` 审计；
- 默认部门单不阻断流程，但会在工作台显示数量；
- 运营改部门只改归属，不改派单历史；改归属写 `ticket_event`。

---

## 三、角色模型：worker = 师傅，operator = 运营

### 目标

| 角色 | 端 | 数据范围 | 说明 |
|---|---|---|---|
| `worker` | 仅小程序 | 本人 | 师傅；只看分派给自己的任务；抢单大厅是唯一“池”入口，且按部门过滤 |
| `operator` | 仅 PC | 全租户 | 运营；看全局、派单、改派、跨部门协调 |
| `admin` | PC | 全租户 | 租户管理 |
| `reviewer` | PC | 全租户 | 审核 |
| `service_desk` / `dispatcher` | 已退场 | - | 不再新建、不再分配 |

### 为什么“每个端点加守卫”不是根治

`assertWorkOrderVisible` 放在事件、照片、语音、详情、运送单上，
虽然比每个端点各写一个 `if` 好，但它仍然是**按端点调用**的守卫：

- 新加一个 `/open/work_order/:id/xxx` 端点，忘了调用，就再次漏；
- 事件/照片/语音/运送单是四个不同模块，靠人记住，迟早漂移；
- 它只保护被记得保护的入口，不保护“直接写 SQL”的新代码。

**根治不是再加一层守卫，而是让数据层本身只返回可见行。**

本系统已经对 `work_orders / ticket_event / transport_order` 开了 RLS（租户隔离），
正确做法是把它从“租户隔离”扩展到“租户 + 本人范围”：

```text
authMiddleware 解析角色
  → resolveDataScope(role)
  → 把 scope/userId 放进 AsyncLocalStorage

withTenantClient 每个事务 SET LOCAL：
  app.scope = 'tenant' | 'self' | 'system'
  app.worker_ids = 'w1,w2'（self 时）
  app.claim_hall = '1'（仅抢单大厅/认领事务）

PostgreSQL RLS：
  work_orders SELECT tenant_id = app_tenant_id()
                  AND (scope in tenant/system
                       OR assignee_id = ANY(worker_ids)
                       OR (created_by = app_user_id()
                           AND (assignee_id IS NULL OR assignee_id = ANY(worker_ids)))
                       OR (claim_hall AND assignee_id IS NULL))

  work_orders INSERT WITH CHECK (scope in tenant/system
                                 OR (created_by = app_user_id()
                                     AND (assignee_id IS NULL
                                          OR assignee_id = ANY(worker_ids))))

  work_orders UPDATE USING (同 SELECT)
                    WITH CHECK (scope in tenant/system
                                OR assignee_id = ANY(worker_ids)
                                OR dispatch)

  ticket_event    EXISTS (可见的 work_orders 父行)
  transport_order tenant_id = app_tenant_id()
                  AND (scope in tenant/system OR carrier = ANY(worker_ids))
```

> `app.dispatch='1'` 只给自动派单/退回自动重派这类**系统动作**：
> worker 自己发起的建单/退回事务里，状态写入是 worker 身份，
> 但“派给别人”是系统动作，不能因此把整个事务升级成 system（会读全租户）。
> 用窄能力 `dispatch` 只放开“改 assignee”，不放开读全租户。
> 所有能力都只能由服务端受信代码设置，绝不从请求体读取。

> 为什么还要 `created_by`：worker 新建一张未分派工单时，`INSERT ... RETURNING`
> 受 SELECT 策略影响，如果只允许 `assignee_id=自己`，创建人反而看不到自己刚建的单。
> 加 `created_by`（account_user.id）并允许创建人可见，既解决回执，也留下审计。

这样：

- 详情、事件、照片、语音、列表、统计、运送单，**不靠端点守卫**；
- 任何新端点只要查 `work_orders`，RLS 自动过滤；
- worker 没有档案 → `worker_ids` 为空 → 看不到任何单，天然 fail-closed；
- 抢单大厅用受控的 `app.claim_hall` 能力，只对未分派单开放；
- 系统任务（scheduler/public report/AI/联动单）显式 `scope='system'`；
- 跨单只读场景（资产历史/看板/AI 查询/结算）必须明确是 `tenant` 或 `system`，
  不能靠 worker 的 `asset.scan` 权限误读全租户工单；
- 旧 token 角色问题仍然要处理，但行级隔离不再依赖路由写对。

RLS 是安全边界；路由层只保留业务校验（比如“工人不可改派”），
不再承担“这行能不能看”的职责。

### 代码根治点

1. 删除 `MASTER_ROLES` 这种“路由里写角色数组”的做法；
2. 新增唯一的 `resolveDataScope(role)`：
   - `worker` → `self`
   - `operator/admin/reviewer` → `tenant`
   - 自定义角色默认 `self`（安全默认；以后要租户级再在 `role_def` 加 `data_scope`）
3. `authMiddleware` 把 `{ scope, userId, role }` 写入 AsyncLocalStorage；
   `withTenantClient` 读取并 `SET LOCAL app.scope / app.worker_ids`；
4. 新增 RLS 策略：
   - `work_orders`：tenant + self + claim_hall 能力；
   - `ticket_event`：父工单可见才可见；
   - `transport_order`：tenant + self；
5. `work_orders.created_by` 记录创建人，RLS 允许创建人看自己刚建的单；
   `createWithIdem` 从 auth context 取 userId，系统单为 null；
6. 抢单大厅/认领使用受控 `app.claim_hall='1'`，只允许未分派单；
   自动派单/退回重派使用受控 `app.dispatch='1'`，只允许改 assignee；
   两个能力都只由受信服务端代码设置，绝不从请求体读取；
7. 系统/公开路径显式 `scope='system'`（public report / scheduler / linkedWorkOrder / AI）；
   `withTenantClient` **不得默认 system**：
   - 有 auth context → 用 auth scope；
   - 显式传 `{ system: true }` → system；
   - 两者都没有 → 抛 `MISSING_AUTH_CONTEXT`，fail-closed；
   这样“忘了设上下文”不会静默变成全租户可见；
8. 删除 `assertWorkOrderVisible` 这类按端点守卫；
   列表/详情/事件/照片/语音/运送单不再各写可见性判断；
9. `workOrder.ts` 流转里的 `role === 'worker'` 改为 `resolveDataScope(role) === 'self'`，
   只用于“工人不可改派”这类业务规则，不用于行可见性；
10. 加一条架构测试：除 repo/迁移/系统任务白名单外，
   业务路由不得直接写 `FROM work_orders` / `FROM transport_order`；
   即使有人绕过 repo，RLS 仍是最后一道闸。
11. 小程序：
   - **业务入口只给 `worker`**；`operator` 禁止进小程序业务页；
   - `reviewer` 走 PC；`admin` 管理页先保留为配置备用入口，
     等 PC 管理端确认可用后再下线，避免试点配置被卡住；
   - `roleHome` 删除 `operator/dispatcher/reviewer` 业务映射；
   - 删除/下线 `pages/operator/accept` 与 dispatcher 页面入口；
   - `app.js` 的 `EMPLOYEE_ROLES` 不再把 `operator` 当小程序员工；
   - operator 登录小程序直接提示“请使用 PC 管理端”，不进入受理台。
12. PC：
   - worker 登录 PC 显示“师傅请使用小程序”，不渲染业务菜单；
   - operator 正常进入全局工作台。
13. 防止“非师傅被派单”：
   - `/workers` 绑定 `account_id` 时校验该账号角色必须是 `worker`；
   - 迁移时删除/停用 operator/admin/reviewer 名下的 worker 档案；
   - 自动派单候选人只来自 `worker` 档案，且档案必须属于 `worker` 角色账号
     （无账号的历史档案先清洗，不长期保留例外）。
14. 数据：
   - 主站 6 个 `w_*` operator 账号改为 `worker`，或删掉重建；
   - `chuyi_ops`、`operator_zhao`、`review_qian` 保留为运营/审核；
   - **operator/admin/reviewer 不应保留可派单的 worker 档案**；
     否则自动派单会把这些“非师傅”选成候选人；
   - `desk_tai` 删除或停用；
   - **角色变更后必须强制重新登录**：JWT 里带的是旧 `role`，
     改数据库角色不会让旧 token 立刻变成 worker；
     试点直接让相关账号重新登录/清 token，正式环境加 `token_version` 或角色版本校验；
   - 试点环境直接清空重建，不背历史账号包袱。

> 注意：小程序/PC 只是入口，不是安全边界。真正的安全边界是
> **数据库 RLS + 请求级 auth scope**，不是路由里的 `if`。

---

## 四、工作台统计：一条口径、一个数据源

### 新接口

```http
GET /api/v1/stats/workbench
  ?department_id=
  &bucket=
  &status=
  &priority=
  &source=
  &business_type=
  &timeout=1
  &today=1
```

> `department_unassigned=1` 只保留为迁移期/数据质量诊断参数，不进入正常运营筛选。
> 数据清理并加 `NOT NULL` 后，正常工单不应再有空部门。
> `bucket` 与 `status` 互斥；`department_id` 与 `department_unassigned` 互斥；
> 同时传返回 400，不做“谁赢谁”的隐式行为。

返回：

```json
{
  "ok": true,
  "total": 52,
  "buckets": {
    "pending": 8,
    "hall": 0,
    "active": 4,
    "done": 24,
    "cancelled": 16,
    "other": 0
  },
  "timeout": 12,
  "today_new": 0,
  "rates": {
    "auto_dispatch": 0.712,
    "cancellation": 0.308,
    "auto_close": 0.442,
    "satisfaction_avg": 0,
    "satisfaction_count": 0
  },
  "data_quality": {
    "evaluated_missing_score": 0
  }
}
```

### 关键设计

1. **列表和统计共用 `buildWorkOrderFilter`**（部门/状态/超时等业务筛选，不承担安全），
   安全由 RLS 兜底；
2. **列表新增 `bucket` 参数**：卡片点“待处理”传 `bucket=pending`，后端用同一个桶映射转成状态集合；
3. **桶映射唯一来源**：
   - 优先 `workflow_def.config.workbenchBuckets`，显式声明
     `pending/hall/active/done/cancelled` 各自包含哪些状态；
   - **不能只用 `activeStates` 推导 pending/active**：`activeStates` 的定义是
     “非完成、非终态、非挂起”，它会把 `draft/assigned/pending_review` 都算进 active，
     推不出业务想要的“待处理/进行中”语义；
   - 未配置时用一份内置默认桶（见下），并把认不出的状态进 `other`；
   - 保存流程定义时校验：一个状态最多进一个桶；所有状态必须被覆盖或显式落 `other`；
   - 返回 `bucket -> statuses` 或保证 `sum(buckets) = total`；
   - `bucket=other` 的列表必须由同一 scope 的 distinct status 减去所有桶状态得出，
     不能前端自己猜，否则“其他”卡片和列表又会对不上；
4. **不再前端自己算**：Dashboard 删除 `items` 聚合，不再依赖 `limit=200`；
5. **不缓存或缓存 key 包含 `tenant + data_scope + 全部筛选`**；pilot 建议直接不缓存；
6. **timeout 口径必须一条**：`sla_due_at < now() AND status NOT IN (done ∪ cancelled)`，
   所有未闭环单（含 `draft/pending_dispatch/claim_hall/assigned/active`）都算；
   旧 Dashboard 只算 pending+active、旧列表却含 claim_hall，是另一个隐藏分叉；
7. **rate 的分母就是同一 scope 的 total**；如果加了状态筛选，前端标注“筛选后口径”；
8. **时间边界统一用数据库时区**：`today` 用 `created_at::date = CURRENT_DATE`，
   超时用 `sla_due_at < now()`；不要用 Node/浏览器本地时间算“今天/超时”；
9. **data_quality 也按同一 scope 统计**，不是永远全租户；
10. **分页统一 `limit/offset + total`**：当前 `cursor` 是假契约，删掉；如果以后要 keyset，再单独做。

### 内置默认桶（RICH 13 态）

```json
{
  "pending": ["draft", "created", "pending_dispatch", "assigned"],
  "hall": ["claim_hall"],
  "active": ["arrived", "processing", "paused", "suspended",
             "pending_review", "review_passed", "transporting",
             "accompanying", "auditing", "review"],
  "done": ["completed", "closed", "evaluated"],
  "cancelled": ["cancelled"]
}
```

- 不在以上集合里的状态 → `other`；
- 自定义流程可以在 `workflow_def.config.workbenchBuckets` 覆盖；
- `done/cancelled` 仍以 `doneStates/cancelledStates` 做兜底校验，避免配置漏掉真实终态；
- 当前生产 `workflow_def` 没有 `workbenchBuckets`，迁移时补一份；
- 老状态名不在当前 def 的，仍可通过 `other` 下钻，不静默丢单。

### 默认筛选

- 默认“全部部门”，**不再自动选第一个**；
- 正常筛选只有两态：`全部 / 具体部门`；
- 部门必填后，不再需要“未指定”这个常态筛选项；
- 顶部筛选和页面筛选统一放 URL，页面不再各存一份；
- localStorage 只做“上次选择”的辅助，key 必须带 `tenantId + userId`，加载时校验部门仍存在，不存在自动回全部。

---

## 五、本轮发现的缺陷清单（按严重度）

| # | 缺陷 | 位置 | 处理 |
|---|---|---|---|
| 0 | 全仓 275 处直接 SQL 查 `work_orders`，无统一可见性边界；新端点必然漏 | 全局 | RLS + 请求级 auth scope，不按端点加守卫 |
| 1 | worker 可读别人事件流 | `workOrder.ts:700` | `ticket_event` RLS 父行可见 |
| 2 | worker 可往别人工单加照片 | `workOrder.ts:785` | `work_orders` RLS UPDATE |
| 3 | worker 可往别人工单加语音 | `workOrder.ts:810` | 同上 |
| 3b | worker 可读全部运送单（列表/详情无 self scope） | `transport.ts:441/455` | `transport_order` RLS |
| 4 | `operator` 被当师傅只看本人 | `workOrder.ts:82` | 改中央 `data_scope`，operator 全租户 |
| 4b | worker 无档案时列表/详情**降级放行全租户** | `workOrder.ts:634/731` | RLS 的 `worker_ids` 为空 ⇒ 0 行，天然 fail-closed |
| 5 | 6 个 w_* operator 账号实际是师傅 | 主站数据 | 改 worker / 重建 |
| 6 | 服务台自动选第一个导致列表 0 | `MainLayout.tsx:307` | 删除自动选择 |
| 7 | 全局服务台不按租户隔离 | `GlobalFilters.tsx:16` | 删服务台；部门按租户 |
| 8 | 工单列表不跟随顶部筛选 | `TicketList.tsx:180` | URL 单一事实源 |
| 9 | Dashboard 部门筛选是假 A/B/C | `Dashboard.tsx:516` | 接真实 `/basic-data/dept` |
| 10 | Dashboard 用 200 条前端算全量 | `Dashboard.tsx:191/231` | 服务端 `/stats/workbench` |
| 10b | Dashboard 超时不算 claim_hall，列表 timeout 却算 | `Dashboard.tsx:241` / `repo/ticket.ts:580` | 统一 open 状态口径 |
| 11 | `/stats` 只按租户缓存、不吃筛选 | `repo/stats.ts:52` | 新端点不缓存/全 key |
| 12 | 列表 cursor 是假契约 | `TicketList.tsx:269` | 改 offset + total |
| 13 | 服务台 DELETE 端点不存在 | `serviceDesk.ts` / `AdminPage.tsx:122` | 随服务台模块删除 |
| 14 | 服务台 template 无读取点 | `018_service_desk.sql` | 随服务台删除 |
| 15 | desk 通知无接收人 | `workOrder.ts:1119` | 随转台删除 |
| 16 | 部门以 UUID 原样显示 | TicketList/Dashboard/TicketDetail/Intake | API 返回 `department_name` |
| 17 | worker.department 无 API/UI | `worker.ts:23` / `FoundationPage.tsx:165` | 增加 `department_id` |
| 18 | 部门无外键、可能悬空 | `028_phase_a.sql` | `(tenant_id, department_id)` 复合 FK |
| 19 | `ticket_require_service_desk=true` 与数据矛盾 | 主站 system_config | 随服务台删除 |
| 20 | 4 张 evaluated 无分数 | 主站数据 | 清历史 + DB CHECK + 流转守卫 |

---

## 六、实施顺序（一步到位，不打补丁）

### 阶段 1：模型与安全地基（后端）

1. `dept` 复合唯一键 + `work_orders/worker.department_id` 复合 FK；
2. `/workers`、`/workers/with-account`、人员表单增加 `department_id`；
3. 新增 `resolveDataScope`，`authMiddleware` 写 AsyncLocalStorage；
4. `withTenantClient` 注入 `app.scope / app.worker_ids / app.claim_hall`，
   并加 `created_by` 写入；
5. 新增 `work_orders / ticket_event / transport_order` 的 RLS 策略；
6. 抢单大厅/认领增加受控 `app.claim_hall` 能力；
7. 审计 340 处 `withTenantClient`：系统/公开路径显式 `scope='system'`，
   没有 auth context 也没有 system 标记的直接报错（fail-closed）；
8. 删除 `MASTER_ROLES` + `assertWorkOrderVisible`，不再按端点写可见性；
9. 列表/统计保留 scope 过滤只为性能/语义，安全由 RLS 兜底；
10. 真 PG 上验证：直接 SQL 也绕不过 RLS。

### 阶段 2：服务台退场

1. 删除 `serviceDesk.ts` 路由与 `servicedesk.manage` 权限；
2. 删除 `work_orders.service_desk` 的读写、筛选、转台、通知；
3. **用“改部门”替代“转台”**：
   - `POST /open/work_order/:id/change-department`，权限 `dispatch.override`；
   - 只改 `department_id` + `department_source='manual'`，写 `ticket_event`；
   - 若当前 assignee 不属于新部门：返回 409，要求先改派；
     不自动清空 assignee/改状态，避免出现“已派单但无处理人”的悬空态；
   - 无 assignee 的单可直接改部门，抢单大厅/待派队列随新部门生效；
4. 删除 PC 顶部服务台筛选、AdminPage/BasicData 服务台 Tab、Intake/TicketDetail 服务台字段；
5. 删除 `ticket_require_service_desk` 配置与开关；
6. 迁移删除 `service_desk` 表与旧列（pilot 先做，主站随新后端）；
7. 清理 `apiGuard` 的 `service-desks` 白名单、AI 查询参数、`AiAssistant` 提示；
8. 清理 `notification.recipient_kind='desk'` 的转台通知路径；
9. 清理 `service_desk` 相关测试与旧前端构建。

### 阶段 3：部门成为真实派单维度（必填 + 自动识别）

1. `dept` 补 `is_default`；新增 `department_route_rule`，基础数据加“部门路由”页；
2. 把 `businessTypeForCategory` 抽到 `engine/businessType.ts`（repo 层可复用，不反向依赖 service）；
3. 新增 `repo/departmentResolver.ts`：
   - 显式 > 路由规则（priority）> 默认部门；
   - 规则匹配 business_type / catalog / location / asset / reporter / source / description；
   - 显式 `department_id` 必须校验存在且属于当前租户，非法直接 422；
4. `createWithIdem` 内统一调用 `resolveDepartment()`，所有建单入口一个闸门；
5. 建单写 `department_id` + `department_source`，DB 加 `NOT NULL`；
6. 运营端展示“自动归属 + 来源 + 修改”，不做必选空下拉；
7. 公开报修/小程序端不出现部门字段；
8. 明确部门（explicit/rule/manual）→ 自动派单按 `department_id` 过滤候选人；
9. 默认部门（default）→ 自动派单**不按部门过滤**，选中后把部门改成师傅部门，
   `department_source='assignee'`；
   - late-bind 放在 `repo/ticket.transition` 内核（唯一写 assignee 的主通道），
     不散落在 autoDispatch/claim/manual/autoRedispatch 各写一遍；
   - `linkedWorkOrder` 目前是唯一旁路直写，必须改成走 transition/统一 assignment service；
   - 明确部门的单，人工改派也必须校验新 assignee 属于该部门；
     跨部门必须显式走“改部门 + 改派”两步/专用端点，不能静默跨；
10. 明确部门且本部门无人 → `claim_hall`，reason=`no_department_worker`，通知运营；
11. 默认部门单进大厅后，认领不按默认部门拦截；认领成功同样回写认领人部门；
12. 抢单大厅对明确部门单按 worker 部门过滤；跨部门认领仍 403；
13. 列表/详情/导出返回 `department_name`，不再裸 UUID；
14. 默认部门单只做工作台计数抽查，不阻断、不强制运营逐单补。

### 阶段 4：工作台统计与筛选

1. 给现有 `workflow_def` 补 `config.workbenchBuckets`（或走内置默认桶并显式记录）；
2. 保存流程定义时校验桶覆盖/互斥；
3. `GET /stats/workbench`；
4. `GET /open/work_orders?bucket=`；
5. Dashboard 删除客户端聚合，卡片走接口；
6. 卡片下钻带 `bucket/timeout/today + 当前部门筛选`；
7. 筛选统一 URL；删除自动选服务台/部门；
8. 分页改 `offset + total`。

### 阶段 5：数据清理与约束

1. 迁移/开通校验：每个 active 租户必须有且只有一个 `dept.is_default=true`；
   没有就补一个“调度中心/总务科”，不能让建单时才发现；
2. pilot 基础数据清洗：
   - 主站 `fault_category` 有 91 条，含重复、`--`、NULL 名称，需去重/清理；
   - `fault_category.business_type` 全 NULL，`business_type_dict` 为空 ⇒
     `GET /intake-options` 实际为空，前端一直走内置 TEMPLATES 兜底；
   - 要补一份干净的 business_type + catalog + 部门路由规则，否则“后端是事实源”名不副实；
3. pilot：清空工单域，重新种干净数据；
   - 实测 pilot 4101（目标租户 `zixing-hospital`）：
     部门只有 `总务科` 1 条；账号 `admin/operator/w001` 3 个；
     worker 只有 `W0001` 且 `department` 为空；工单 1 条；无 service_desk；
   - UAT 前必须补：默认部门（可把总务科设默认）、部门路由规则、
     师傅 `W0001.department_id`、至少一个覆盖本部门派单/抢单的工单场景；
     否则“部门必填 + 按部门派单”无法验证；
4. 主站：确认当前后端可部署后，清空演示工单域；
5. `CHECK (status <> 'evaluated' OR satisfaction_score IS NOT NULL)`；
6. 流转到 `evaluated` 时服务端强制 `score`（自定义评价态也要管，DB CHECK 只覆盖内置 `evaluated`）；
7. `data_quality.evaluated_missing_score` 归零后再 `VALIDATE`。

### 测试影响（必须一起改，否则会大面积红）

- 现有多处测试直接 `INSERT INTO work_orders`，`department_id NOT NULL` 后会失败；
  需要统一测试夹具补 `department_id`；
- `createWithIdem` 的 mock client 需要响应 `department_route_rule/dept` 查询；
- 所有系统/公开路径要显式 `{ system: true }`；
  测试里直接 `withTenantClient` 的地方要加 auth context helper 或 `{ system: true }`；
- 新增 resolver 单测：显式、规则命中、规则优先级、无规则走默认、
  规则冲突取高优先级、未知状态；
- 新增 RLS 测试（真 PG/PGlite）：
  - worker 直接 SQL 也查不到/改不了别人工单；
  - worker 查事件、照片、语音、运送单同样被 RLS 挡住；
  - worker 无档案 → 0 行；
  - operator/admin/system 能看到全租户；
  - 抢单大厅能力只对未分派单、只在该事务生效；
- 新增 stats/list 同口径测试：`bucket`、部门、超时、今日、超 200 条。

---

## 七、验收不变量

```text
sum(buckets) = total
stats.timeout = list(timeout=1).total
stats.today_new = list(today=1).total
stats 每个 bucket = list(bucket=该 bucket).total
相同 department_id / 未指定 / 全部 下，卡片与列表完全一致
worker 登录：列表、详情、事件、照片、语音都只能碰本人单
worker 直接用 SQL / 新端点查别人工单，也被 RLS 挡住
worker 无 worker 档案：0 行，不能降级看全租户
worker 不能通过 /transport/orders?carrier=别人 枚举全租户运送单
operator 登录：能看到全租户，不再被 self scope
角色从 operator 改为 worker 后，旧 token 不能继续按 operator 看全局（强制重新登录/版本校验）
worker 打开 PC：被引导到小程序；operator 打开小程序：被引导到 PC
服务台相关接口/菜单/字段全部消失，前端无 404/空下拉
```

按当前主站数据（清空服务台筛选后）：

```text
pending=8, active=4, done=24, cancelled=16, total=52, timeout=12, today_new=0
```

部门必填后的新增验收：

```text
任何新建工单 department_id 均非空
department_source 分布可解释（explicit / rule:<规则名> / manual / default / assignee）
运营端建单不需要先选部门也能提交
公开报修端没有部门输入框
默认部门单数量可见，但不阻塞任何流程
默认部门单被派/被抢后，department_id 回写为处理人部门，source=assignee
默认部门单不会因为“默认部门没有师傅”而全部堵在抢单大厅
明确部门单仍严格在本部门内派/抢
```

选具体部门且该部门无单：卡片 0、列表 0；
清历史后：全部为 0，属预期。

---

## 八、已定：部门必填，但运营不手工补

已确认口径：

- **部门必填**，所有工单最终都必须有 `department_id`；
- **不增加运营逐单选择成本**：后端自动识别，运营只在识别错时修改；
- **公开报修/小程序端不出现部门输入**；
- 识别不到时落租户默认部门（`dept.is_default`），并标记 `department_source='default'`；
- 默认部门单只做工作台数量提示/抽查，不做强制逐单补录。

这条口径下，“必填”解决的是数据完整性，“自动识别”解决的是运营成本，两者不冲突。

---

## 九、审查边界说明

这次不是“全仓 300 个文件逐行通读”，而是：

- 逐个读了服务台、部门、角色、工单列表/详情、派单、抢单、工作台、统计、小程序角色分流、PC 菜单/筛选的相关源码；
- 用主站 `youfu` 库核对了 52 张工单、服务台/部门表、worker/account 角色、dispatch_rule、dept 字典、notification；
- 用 API 实测了 `/stats`、`/open/work_orders?timeout=1`；
- 没有把无关模块（如能耗、资产、结算的全部实现）逐行读完。

结论只对上述链路负责，不冒充“全仓 100% 通读”。
