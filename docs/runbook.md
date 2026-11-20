# 优服家试点运行手册（Runbook）

> 适用：资兴市人民医院单租户试点（维修 / 运送陪检 / 巡检 / 设备资产 / 志愿者）
> 版本：2026-11-07（P0 第二轮收口后）
> 定位：部署、迁移、备份、回滚、健康检查的**可执行步骤**。与代码冲突时以代码与测试为准，并立即回写本文件。

---

## 0. 一页速查

| 事项 | 命令 / 位置 |
| --- | --- |
| 构建 | `npm ci && npm run build`（产物 `dist/`） |
| 类型检查 | `npm run typecheck` |
| 全量测试 | `npm test` |
| 发布闸门 | `npm run release-gate` |
| 迁移（属主） | `sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f <文件>` 或 `scripts/migrate-as-owner.sh` |
| 迁移（应用账号，已应用则 no-op） | `npm run migrate` |
| 试点自检（只读） | `npm run preflight -- --tenant=<tenant_id>` |
| 服务单元 | `deploy/youfu-backend.service` |
| 存活探针 | `GET /health`（进程活着即 200，不代表 DB 可用） |
| 就绪探针 | `GET /health/ready`（DB 可用才 200，否则 503） |
| 日志 | `journalctl -u youfu-backend -f`（单行 JSON 访问日志） |
| 请求关联 | 响应头 `X-Request-Id`；500 日志含同一 `request_id` |
| 云上真实基线 | `docs/cloud-current-state-20261107.md`（只读核验，部署前必读） |
| 隔离预演（已完成） | `youfu-pilot.service` @ 4101，库 `youfu_pilot`；已应用 110~115，发布记录见 `docs/pilot-release-20261108.md`；PC 管理端：`https://youfu.banerz.cn/pilot/` |

---

## 1. 环境前置

> 🔴 **2026-11-07 云上实测（只读）**：现有 ECS 为 **CentOS 7 / glibc 2.17**，
> 只有 **Node 16.20.2（`/opt/node16`）**，**没有 `/opt/node22`**；Node 22 官方二进制
> 无法在 glibc 2.17 上运行。现网 systemd unit 也是 `/opt/node16/bin/node dist/server.js`。
> 详见 `docs/cloud-current-state-20261107.md`。

1. **Node 运行时（必须按实际环境选）**：
   - **现有 ECS（短期试点）**：用 `/opt/node16/bin/node`。已验证当前 `dist` 的 132 个
     `.js` 在该 Node16 下 `--check` 全部通过，源码非测试部分未使用 `fetch` /
     `structuredClone` 等 Node18+ 运行时 API。
   - **新环境（正式上线）**：使用 Alibaba Cloud Linux 3 / Ubuntu 22 + Node 22，
     再套用 `deploy/youfu-backend.service`（`/opt/node22`）。
   - ⚠️ **不要**把本地 `deploy/youfu-backend.service`（Node22）直接复制到现有 CentOS7；
     按主机改 `PATH` 与 `ExecStart`。
   - Node16 已 EOL，只能作为试点期过渡；医院正式上线前必须完成 OS/Node22 迁移。
2. **PostgreSQL**：应用连接角色 `youfu_app`（受 RLS 约束，非表属主）；
   DDL/迁移必须用属主（ECS 上为 `postgres`）执行。
3. **目录**：`/opt/youfu/backend` 为发布目录；`UPLOAD_DIR` 指向持久化目录（不要放在 `dist/` 内）。
4. **时区/时钟**：服务器启用 NTP；SLA、巡更、志愿者截止时间都按服务端时间计算。
5. **端口**：默认 `PORT=4001`；Nginx 反代到本端口，`trust proxy` 固定只信最近 1 跳。

---

## 2. 环境变量（`.env`）

以仓库 `.env.example` 为模板，至少确认：

```dotenv
NODE_ENV=production
AUTH_MODE=prod
ENV_FILE=/opt/youfu/backend/.env
PORT=4001
JWT_SECRET=<openssl rand -hex 32>
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=youfu
PGUSER=youfu_app
PGPASSWORD=<真实密码>
INVITE_SALT=<随机值>
APP_SECRET_SALT=<随机值>
DEFAULT_LOGIN_TENANT=<资兴市人民医院租户 id>
```

启动期断言（`src/server.ts`）：

- `AUTH_MODE=prod` 但缺 `JWT_SECRET` → **拒绝启动**；
- `NODE_ENV=production` 但 `AUTH_MODE!==prod` → **拒绝启动**；
- 启动日志出现 `AUTH_MODE=dev` 警告 → 立即停机排查。

> 🔴 **`INVITE_SALT` / `APP_SECRET_SALT` 仍是“缺失则回退硬编码常量”**，不是启动断言。
> 2026-11-07 云上实测：`INVITE_SALT` 已补配并重启旧服务；`APP_SECRET_SALT` 仍未设置，
> `dist/routes/platform.js` / `dist/middleware/openApiAuth.js` 仍含 `youfu-app-secret-salt` 字面量。
> 现网有 8 个 `open_api_app`，直接改 `APP_SECRET_SALT` 会让这些应用的签名全部失效，
> 必须连同 app secret 一起轮换；开放 API 不在首批试点范围。
> 新环境部署前必须显式配置两个随机盐；建议把 prod 缺失盐改成 fail-closed（启动即退出）。

> 🔴 试点环境禁止 `AUTH_MODE=dev`：dev 下 `X-Tenant-Id` / `X-Role` 可由客户端任意指定，
> 所有权限门恒放行。

---

## 3. 发布前门禁（每次发布必做）

```bash
npm ci
npm run typecheck
npm test
npm run release-gate
npm run build
```

通过标准（2026-11-07 基线）：

- `tsc --noEmit` exit 0；
- 后端全量 **199 文件 / 2442 用例**全绿（以当次实际输出为准）；
- `releaseGate` 通过：116 个迁移命名规范、80 张租户表 RLS、SQL 列引用全部命中 DDL；
- `dist/server.js` 生成。

> 只更新 `src/` 不重建 `dist/` 会继续跑旧代码——这是原部署链最隐蔽的坑。

---

## 4. 数据库迁移

### 4.1 纪律

- **加法迁移**（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / 新索引等）可自动执行。
- **破坏性迁移**（`DROP` / 删列 / 收窄类型 / 数据删除）**不得自动执行**：
  必须放在 `pending-migrations/`，经人工审批 + 备份 + 演练后再手工应用。
  当前挂起：`105_drop_service_desk_agent.sql`、`108_drop_open_api_app_secret.sql`。
- 根目录出现不符合 `NNN_name.sql` 命名的 `.sql` 时，迁移脚本 **fail-closed**（拒绝执行）。
  - ⚠️ 云上现状：`/opt/youfu/backend/a1_dispatch_rules.sql` 曾是这种文件（已移入 `seeds/`）（`t-verification` 的
    幂等派单规则种子，非 DDL）。部署当前迁移器前必须先把它移到 `seeds/`，否则迁移直接拒绝执行。
- 已部署迁移**不得重命名**：`_migrations` 按文件名追踪，重命名会重复执行。
- **云上迁移账实差异（2026-11-07 实测）**：`_migrations` 117 条，含已执行的破坏性 `105`；
  本地根目录 116 条；差集为：
  - 云上有、本地无：`033_asset_material_enhance`、`053b`、`053c`、`105`；
  - 本地有、云上无：`106`、`107`、`109`（其中 `106/107` 的列效果已由 `053b/053c` 存在，
    仅 `109` 的 `slots` 默认值确实仍为 0）。
  - 云上源码目录缺 `090`~`096` 文件但 `_migrations` 有记账；部署本地代码后这些会 `skip`，无损。

### 4.2 执行顺序

```bash
# 1) 先备份（见 §5）
# 2) 在 staging 克隆上完整演练（见 §4.3）
# 3) 生产以属主身份应用
sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f <迁移文件>
#    或使用仓库脚本（自动跳过 _migrations 已记录项）
sudo -u postgres bash scripts/migrate-as-owner.sh
# 4) 核对记账
sudo -u postgres psql -d youfu -c "SELECT count(*) FROM _migrations;"
```

### 4.3 迁移演练（G1 必做）

1. 新建空库（或从最近备份恢复的克隆库）。
2. 记录迁移前 `_migrations` 数量。
3. 按文件名顺序执行全部迁移；要求 **116/116 成功**、无手工跳过。
4. 抽查关键列/默认值：
   - `volunteer_activity.slots` 默认值 = 1；
   - `worker.account_id` 存在且 `account_user.id` 为 uuid（比较时 `au.id::text`）；
   - `business_flow_tasks.def_version`、`work_orders.def_version` 存在。
5. 复跑一次迁移脚本：应输出 `nothing to do`（幂等）。
6. 在克隆库上跑一轮关键读接口与 RLS 跨租户验证（见 `scripts/rls-cross-tenant-verify.sh`）。

---

## 5. 备份与恢复

### 5.1 备份

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
pg_dump -h 127.0.0.1 -U postgres -d youfu -Fc -f /opt/youfu/backup/youfu-$STAMP.dump
pg_restore --list /opt/youfu/backup/youfu-$STAMP.dump | head
```

- 迁移前、发布前、批量数据修正前必须备份。
- 保留策略：试点期至少保留 7 个日备 + 4 个周备；备份文件与数据库**不同磁盘**。
- 备份后必须验证：`pg_restore --list` 能读完；抽一个表 `pg_restore -t <table> -f -` 查看。

### 5.2 恢复

```bash
# 停应用，避免恢复期间继续写入
systemctl stop youfu-backend
# 重建目标库（示例；生产操作前确认库名）
sudo -u postgres createdb -T template0 youfu_restore
sudo -u postgres pg_restore -d youfu_restore -Fc /opt/youfu/backup/youfu-<stamp>.dump
# 校验行数/关键租户/RLS 策略后，再切换连接或改名
```

恢复后检查：

1. `_migrations` 记录与迁移文件一致；
2. 关键表行数（租户、账号、工单、巡检、巡更、志愿者）与备份时点一致；
3. `/health/ready` 200；
4. 用试点租户 admin 登录，打开工单/巡检/志愿者列表。

> RTO < 2h、RPO ≤ 24h 是试点目标；每次演练记录实际耗时。

---

## 6. 发布与回滚

### 6.1 发布

```bash
# 1) 本机/CI 构建并验证（§3）
# 2) 备份当前版本
mv /opt/youfu/backend/dist /opt/youfu/backend/dist.prev
# 3) 上传新 dist/、package.json、package-lock.json
# 4) 安装生产依赖（不含 devDependencies）
cd /opt/youfu/backend && npm ci --omit=dev
# 5) 迁移（如有新增加法迁移，§4）
# 6) 重启
systemctl restart youfu-backend
# 7) 探针与冒烟
curl -fsS http://127.0.0.1:4001/health
curl -fsS http://127.0.0.1:4001/health/ready
```

> **现有 CentOS7 / Node16 主机**：
> - 构建用 `/opt/node16/bin/node node_modules/typescript/bin/tsc -p tsconfig.build.json`；
>   本地构建的 `dist` 已用该 Node16 做过 `--check`，也可直接上传。
> - 新库迁移不要直接用 `scripts/migrate-as-owner.sh`（硬编码 `-d youfu`）；
>   用 `dist/db/migrate.js` 以 `postgres` + unix socket 执行，或复制脚本改库名。
> - `a1_dispatch_rules.sql` 已移入 `/opt/youfu/backend/seeds/`；若新环境根目录再出现同类文件，仍会 fail-closed。
> - Nginx 必须为 `/health/ready` 增加精确 `location`，否则外网会命中静态 `try_files` 返回
>   index.html 200（**假健康**）。改完先 `nginx -t`，通过再 reload。

冒烟最小集：

- admin 登录 `/api/v1/auth/login`；
- 工单列表 + 详情；
- 巡检任务列表（worker 仅本人）；
- 巡更任务列表 / 签到（worker 仅本人）；
- 志愿者活动列表 + 报名（试点租户）；
- 通知列表（不回落全租户）。

### 6.2 回滚

**代码回滚**（迁移是加法的，通常无需回库）：

```bash
systemctl stop youfu-backend
rm -rf /opt/youfu/backend/dist
mv /opt/youfu/backend/dist.prev /opt/youfu/backend/dist
systemctl start youfu-backend
curl -fsS http://127.0.0.1:4001/health/ready
```

**数据库回滚**：

- 本项目**没有 down migration**；破坏性变更必须走 `pending-migrations/` 审批。
- 一旦执行了破坏性迁移，唯一可靠回滚是**从迁移前备份恢复**（§5.2）。
- 因此：任何 `DROP`/删列/数据删除前，必须先备份 + 演练恢复 + 书面审批。

### 6.3 优雅停机

- systemd：`KillSignal=SIGTERM`、`TimeoutStopSec=15`；
- 服务端收到 SIGTERM 后停止接收新请求，最多等待 10s 排空，再关闭连接池；
- 发布窗口避免在 SLA 扫描/巡更调度执行中重启（或接受任务下次重跑）。

---

## 7. 健康检查与可观测性

| 端点/日志 | 语义 | 处置 |
| --- | --- | --- |
| `GET /health` | 进程存活 | 200 但 `/health/ready` 503 → 查 DB/连接池 |
| `GET /health/ready` | DB 可执行 `SELECT 1` | 503 → 查 PG、连接数、网络、密码 |
| `https://<域名>/health/ready` | **必须经 Nginx 精确代理** | 若返回 index.html 200 = 假健康；补 `location = /health/ready` 后再测 |
| 访问日志 | 单行 JSON：`request_id/method/path/status/duration_ms/tenant_id/user_id/role` | 按 request_id 追踪慢请求/5xx |
| `[unhandled]` 日志 | 500 根因 + request_id + method/path | 先看 request_id 对应访问日志，再看堆栈 |
| `journalctl -u youfu-backend` | systemd 聚合 | 发布后持续观察 5~10 分钟 |

日志安全边界：

- 访问日志**不记录** query string、body、Authorization；
- 手机号、令牌、报修内容不会因访问日志落盘；排障需按 request_id 回业务表核对；
- 前端/小程序报障时先提供响应头 `X-Request-Id`。

当前**没有** `/metrics`、APM、错误追踪平台；单租户试点用「日志 + 健康探针 + 业务表核对」。
接入真实监控前，不要声称具备秒级指标告警能力。

---

## 8. 试点初始化（租户上线当天）

1. **建租户**：确认 `tenant` 与租户 registry 状态为 active；记录 `tenant_id`。
2. **首号 admin**：用种子脚本或平台层创建第一个 admin（`scripts/seed-accounts.ts` / 平台开通流程）。
3. **业务账号**：
   - 工人必须走 `POST /api/v1/workers/with-account`（单事务建 `account_user` + `worker` + `worker.account_id`）；
   - 或使用邀请码，但兑换后仍需确认 `worker.account_id` 已绑定；
   - 只建账号、不建 worker 档案 → 「我的工单 / 巡检 / 巡更 / 通知」按 `resolveWorkerIds` 解析不到本人。
4. **权限**：用权限页提交**完整集合**；`role_permission` 是整角色覆盖，不是追加。
   只补一条 `role.manage` 会让该角色默认矩阵全部失效。
5. **通知**：`in_app` 落库即可达；sms/push/wechat 当前是 stub，不要把投递凭证当成真实触达。
6. **验收**：按《endpoint-permission-matrix.md》逐角色抽查 403/200，再交给用户做 G1 真机 UAT。

---

## 9. 常见故障速查

| 现象 | 首查 | 常见根因 |
| --- | --- | --- |
| 服务起不来，日志 `JWT_SECRET not configured` | `.env` / systemd `ENV_FILE` | 生产缺密钥或加载了错误 env 文件 |
| 服务起不来，日志 `AUTH_MODE!==prod` | `.env` | 生产误配 dev |
| `/health` 200 但业务全 500 | `/health/ready`、PG 连接数 | DB 不可达 / 连接池耗尽 |
| 某角色突然大量 403 | `role_permission` 该角色行 | 只写了部分权限，覆盖掉默认矩阵 |
| worker 看不到自己的工单/巡检/巡更 | `worker.account_id`、`account_user.id` | 档案未绑定 / 绑到了错误 id |
| 运送派单通知收不到 | `notification.payload->>'entity_type'`、孤儿过滤 | 旧逻辑只查 `work_orders`；当前应按 `transport_order` 分支 |
| 设备搜索 500 | 搜索列类型 | uuid/date/numeric 未 `::text` 直接 ILIKE |
| 应急列表按 level 500 | SQL 别名 | `alert` 与 `emergency_plan` 同名列未加 `a.` |
| 迁移报「must be owner」 | 执行角色 | 用 `youfu_app` 跑了 DDL，应使用 `postgres` |
| 迁移什么都不执行 | `_migrations` | 迁移已被记录；新增文件要确认命名与放置目录 |

---

## 10. 发布记录（每次填写）

| 日期 | 版本/提交 | 迁移数 | 备份文件 | 执行人 | 结果 | 回滚 |
| --- | --- | ---: | --- | --- | --- | --- |
|  |  |  |  |  |  |  |

---

## 11. 诚实边界

- 本手册基于**当前工作区代码与本地验证**编写；真实 PG、Docker 构建、POSIX SIGTERM、
  小程序真机均需在 G1 环境实测。
- 当前目录不是 git 仓库（本机无 git 命令）；回滚依赖文件级基线
  `D:\WorkBuddy\outputs\.youfu_p0_baseline_20261104` + `MANIFEST.*.sha256`。
- 本手册不替代医院侧的等保/数据安全/备份留存制度；相关要求需法务与运维共同确认。
