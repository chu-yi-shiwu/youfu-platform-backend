# 资兴市人民医院单租户试点初始化清单

> 目标：在**全新环境**把优服家从零初始化到「可交给用户做 G1 真机 UAT」。
> 适用版本：2026-11-07（P0 第二轮收口后）
> 配套文档：`docs/runbook.md`（部署/迁移/备份/回滚）、`docs/endpoint-permission-matrix.md`（权限与可见性）

---

## 0. 范围冻结

首批上线模块：

- 维修工单
- 运送 / 陪检
- 巡检
- 设备 / 资产
- 志愿者

**不在首批**：结算、应急、开放 API / Webhook、平台模板市场、跨租户运营。
首批验收不要因为这些模块未启用而判失败；也不要临时开启未验收模块。

---

## 1. 资源与凭证清单（执行前填满）

| 项 | 值 | 状态 |
| --- | --- | --- |
| 试点域名 / HTTPS 证书 |  |  |
| 应用服务器（ECS） |  |  |
| Node 运行时 | 现网 CentOS7：`/opt/node16/bin/node`；新环境目标：`/opt/node22/bin/node` |  |
| PostgreSQL 地址 / 库名 |  |  |
| 应用账号 `youfu_app` 密码 |  |  |
| DB 属主 `postgres` 密码 |  |  |
| `JWT_SECRET`（32+ 字节） | `openssl rand -hex 32` |  |
| `INVITE_SALT` / `APP_SECRET_SALT` | 随机值 |  |
| 备份目录（独立磁盘） |  |  |
| 租户 id | 建议 `zixing-hospital` |  |
| 微信小程序 AppID / Secret | 可选；没有则先用 H5/PC |  |
| 短信 / 推送通道 | 可选；未接入保持 stub |  |

> 密钥只放服务器 `.env`，不写进仓库、不贴聊天记录。
> 云上现状（只读核验）：见 `docs/cloud-current-state-20261107.md`。现有 ECS 为 CentOS7/Node16，
> 且当前跑的是 10-30 旧 dist；试点前必须决定「现机 Node16 隔离试点」还是「新 OS/Node22 环境」。
>
> **2026-11-07 进展**：已在现机完成隔离预演（`youfu_pilot` 库 / 4101 / `youfu-pilot.service`）：
> 116 迁移、slots 默认 1、preflight 全 PASS、RLS 跨租户、备份恢复、角色/巡更读侧冒烟均通过。
> 该预演仅用于验证，**正式医院试点仍需按本清单在新 OS/Node22 环境重做**（或明确接受 Node16 过渡）。

---

## 2. 数据库初始化（推荐路径）

### 2.1 建库与角色

以属主 `postgres` 执行：

```sql
CREATE DATABASE youfu WITH OWNER postgres;
CREATE ROLE youfu_app LOGIN PASSWORD '<强密码>' NOSUPERUSER;
GRANT CONNECT ON DATABASE youfu TO youfu_app;
```

### 2.2 执行全部加法迁移（属主身份）

```bash
cd /opt/youfu/backend
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=youfu PGUSER=postgres PGPASSWORD='<属主密码>' \
  npm run migrate
```

要求：

- 输出 116 个 `migration ok`，末尾 `migrate: 116 migration(s) applied`；
- `SELECT count(*) FROM _migrations;` = **116**；
- 若中途失败：停止，按报错修复后重跑；不要手工跳文件。

### 2.3 补授权

```bash
sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f scripts/grant-youfu_app.sql
```

验证应用账号可用：

```bash
PGUSER=youfu_app PGPASSWORD='<应用密码>' psql -h 127.0.0.1 -d youfu -c 'SELECT 1;'
```

> `scripts/init-db.ts` 适合本地/演示环境（它会灌 `t-verification` 演示 worker），
> **不建议**直接用于试点生产库，避免把演示租户数据带进来。

---

## 3. 平台层开通租户

### 3.1 建平台管理员（首次）

```bash
cd /opt/youfu/backend
npm run seed:platform
```

记录输出的平台管理员账号与一次性密码（只打印一次）。

> 该脚本会顺带幂等登记 `t-verification` / `t-phasea` / `demo_tenant` 三个演示租户，
> 仅用于平台层展示，不影响 `zixing-hospital` 的数据隔离；如不需要可在开通后停用。

### 3.2 平台登录

```bash
curl -sS -X POST https://<试点域名>/api/v1/platform/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"platform_admin","password":"<一次性密码>"}'
```

响应中的 `token` 用于后续平台接口（`Authorization: Bearer <token>`）。

### 3.3 开通资兴市人民医院租户

```bash
curl -sS -X POST https://<试点域名>/api/v1/platform/tenants \
  -H "Authorization: Bearer <平台 token>" \
  -H 'Content-Type: application/json' \
  -d '{
    "tenant_id": "zixing-hospital",
    "name": "资兴市人民医院",
    "category": "hospital",
    "admin_username": "admin",
    "admin_password": "<机构管理员密码，至少 8 位>",
    "status": "active"
  }'
```

要点：

- 响应里的机构管理员账号密码只返回一次，立即妥善保存；
- `status` 必须为 `active`，`pending` 会导致登录 403 `TENANT_PENDING`；
- 开通会复制行业分类/流程模板；`reporter_dict`（报修人）与 `location_dict`（位置）
  属机构私有 PII，**不会**跨租户复制，后续必须在本租户内自建。

验证：

```bash
curl -sS -X POST https://<试点域名>/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Id: zixing-hospital' \
  -d '{"username":"admin","password":"<机构管理员密码>"}'
```

> 试点环境 `AUTH_MODE=prod` 时租户由 JWT 决定；`X-Tenant-Id` 只用于登录前定位租户。

---

## 4. 账号、worker 档案与绑定

### 4.1 铁律

- 一线人员必须同时有 `account_user` 与 `worker` 档案，且 `worker.account_id` 指向账号；
- **不要只建账号不建档案**：工单/巡检/巡更/通知都靠 `resolveWorkerIds` 反查本人；
- 推荐统一走 `POST /api/v1/workers/with-account`（单事务建账号 + 档案 + 绑定）。

### 4.2 一键开通工人

```bash
curl -sS -X POST https://<试点域名>/api/v1/workers/with-account \
  -H "Authorization: Bearer <admin token>" \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "w001",
    "display_name": "张三",
    "phone": "13800000000",
    "skill_tags": ["水电", "维修"]
  }'
```

响应含 `account`、`worker` 与 `one_time_password`；一次性密码只返回一次。
如已有档案，可用 `PUT /api/v1/workers/:id` 补 `account_id`（需 `worker.manage`）。

### 4.3 绑定自检（上线前必做）

以属主连接执行：

```sql
-- 1) 所有工人是否都有账号绑定
SELECT count(*) AS total,
       count(*) FILTER (WHERE account_id IS NULL OR btrim(account_id) = '') AS unbound
FROM worker WHERE tenant_id = 'zixing-hospital';

-- 2) account_id 是否能对上账号（注意类型：worker.account_id 是 text，account_user.id 是 uuid）
SELECT w.id AS worker_id, w.name, w.account_id
FROM worker w
LEFT JOIN account_user au ON au.id::text = w.account_id AND au.tenant_id = w.tenant_id
WHERE w.tenant_id = 'zixing-hospital' AND au.id IS NULL;
```

两条查询都应为 **0 个未绑定/0 个错绑**；否则相关工人登录后看不到自己的单。

### 4.4 一键自检（推荐）

```bash
cd /opt/youfu/backend
PILOT_TENANT=zixing-hospital npm run preflight
```

脚本只读检查：`AUTH_MODE=prod`、`JWT_SECRET` 长度、PG 参数、`_migrations` 是否等于迁移文件数、
租户是否 active、是否有启用 admin、worker 绑定/错绑、RLS 开启表数。任一 `[FAIL]` 即退出码 1，
不得进入验收；`[WARN]`（如尚未建 worker 档案）不阻断但需记录。

---

## 5. 角色与权限

### 5.1 默认矩阵（试点够用）

| 角色 | 试点职责 | 默认关键权限 |
| --- | --- | --- |
| `admin` | 机构管理员 | 全集（含 `role.manage`） |
| `operator` | 调度/运维主管 | 工单、巡检配置/查看、设备维护、巡更管理、应急（未启用）等 |
| `worker` | 一线维修/运送/巡检/巡更 | 执行面；读侧按本人档案过滤 |
| `reviewer` | 审核（如启用） | 审批类；默认无 `patrol.manage` |

### 5.2 授权红线

- `role_permission` 是**整角色覆盖**，不是追加。提交时必须给完整权限集合；
- 只补一条 `role.manage` 会使该角色默认矩阵全部失效；
- `role.manage` 只有 admin 能授予；非 admin 不能创建/分配 admin；
- 试点环境禁止 `AUTH_MODE=dev`。

配置后用不同角色各抽 1 个端点验证 200/403，详见 `docs/endpoint-permission-matrix.md`。

---

## 6. 业务基础数据（按模块）

### 6.1 维修 / 工单

- [ ] 部门字典（`dept_dictionary`）
- [ ] 位置字典（`location_dict`）：楼栋/楼层/房间，建议编码规则 `楼栋-楼层-房间`
- [ ] 报修人字典（`reporter_dict`）：试点期可先只录关键科室联系人
- [ ] 故障分类（`fault_category`）
- [ ] 派单规则（至少 1 条；无规则时按默认路径）
- [ ] 工单流程定义（开通时已复制；改动走流程配置页，不要在库里直接改）

### 6.2 运送 / 陪检

- [ ] 运送类型/起点终点字典（按现有基础数据配置）
- [ ] 运送 SLA（如启用）
- [ ] 试点先用 1~2 条线路跑通，再扩量

### 6.3 巡检

- [ ] 巡检点位（`inspection_point`）
- [ ] 巡检计划（`inspection_plan`）与任务生成
- [ ] 巡检项模板（如启用）
- [ ] 确认 worker 能在小程序看到「本人任务」，非 worker 角色能看到「全部/按权限」

### 6.4 巡更

- [ ] 巡更点位（`patrol_point`，按 seq 排序）
- [ ] 巡更任务（`patrol_task`，指派到具体 worker）
- [ ] 确认未指派任务对 worker 不可见（无抢单大厅）
- [ ] 签到/漏签由本人或 `patrol.manage` 角色操作

### 6.5 设备 / 资产

- [ ] 设备类型（`equipment_type`）
- [ ] 设备档案（`equipment`）：名称、类型、位置、供应商、购入日期、价格
- [ ] 资产台账（按需）
- [ ] 验证设备搜索：文本、UUID、日期、价格字段均不 500

### 6.6 志愿者

- [ ] 志愿者活动（`volunteer_activity`）：标题、时间、地点、名额（默认 1）
- [ ] 报名截止时间（早于活动开始）
- [ ] 至少 1 个活动完成报名 → 签到 → 结束的闭环
- [ ] 注意：`user_id` 身份绑定、取消报名、我的报名不在本轮范围

---

## 7. 上线验证（按顺序打勾）

### 7.1 基础设施

- [ ] `GET /health` 200
- [ ] `GET /health/ready` 200
- [ ] 启动日志无 `AUTH_MODE=dev` 警告
- [ ] 访问日志出现单行 JSON，含 `request_id/status/duration_ms`
- [ ] 响应头有 `X-Request-Id`

### 7.2 账号与权限

- [ ] admin 登录成功，`/auth/me` 返回权限全集
- [ ] operator 登录成功，菜单/端点符合矩阵
- [ ] worker 登录成功，`resolveWorkerIds` 能解析到本人档案
- [ ] worker 访问他人巡检/巡更详情 → 403
- [ ] 非授权角色访问 `patrol.manage` 端点 → 403
- [ ] 租户 `role_permission` 覆盖后，默认矩阵行为符合预期（无「突然全 403」）

### 7.3 业务闭环

- [ ] 维修：报修 → 派单 → 接单 → 完成 → 评价（按试点流程）
- [ ] 运送：下单 → 派单 → 接单 → 到达/完成 → 拍照（如启用）
- [ ] 巡检：任务生成 → worker 执行 → 完成/异常
- [ ] 巡更：任务指派 → 签到 → 全部签到完成 / 漏签
- [ ] 设备：列表 → 搜索（含 UUID/日期/价格）→ 详情 → 维护记录
- [ ] 志愿者：活动列表 → 报名 → 签到 → 结束
- [ ] 通知：工单/运送/巡检相关站内信能按本人身份收到，且不串租户

### 7.4 数据与安全

- [ ] 用租户 A 的 token 读取租户 B 数据 → 空/403（RLS 实证）
- [ ] 免登录报修日配额生效（超过配额拒绝）
- [ ] 错误响应不泄露堆栈/SQL/密钥
- [ ] 备份文件可在另一目录恢复（演练一次）

---

## 8. 回滚触发条件

出现以下任一情况，立即停止上线并按 `docs/runbook.md` §6 回滚：

- 迁移失败或 `_migrations` 数量不符；
- `/health/ready` 持续 503；
- 任意角色出现「全量 403」且确认是权限覆盖导致；
- 跨租户数据可见；
- 核心业务闭环（维修/巡检/志愿者）无法完成；
- 备份不可恢复。

---

## 9. 验收签字

| 角色 | 姓名 | 结论 | 日期 |
| --- | --- | --- | --- |
| 业务负责人（医院） |  |  |  |
| 平台执行人 |  |  |  |
| 技术负责人 |  |  |  |

> G1 通过标准：P0 清零（本机已达成，真实环境项除外）+ 真机 UAT + RLS 实证 + 备份恢复演练。
> 本清单未完成项不得对外宣称「已上线」。
