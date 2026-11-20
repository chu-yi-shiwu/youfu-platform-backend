# 阿里云现状核验（2026-11-07，只读）

> 核验方式：按 `liuzhao-ecs-readonly-ops` 技能文档提供的只读 SSH 通道
> （`root@8.136.107.153` + `~/.ssh/aliyun_energy`）执行 `hostname / systemctl / psql SELECT /
> curl / ls / grep`。**未改代码、未写库、未重启服务、未改 Nginx。**
> 目的：纠正“本地全绿=云上就绪”的错误假设，给 G1 提供真实基线。

---

## 1. 云资源真身

| 项 | 实测值 |
| --- | --- |
| 实例 | `i-bp14zp7qv2kdp1c3fila` |
| 地域/可用区 | `cn-hangzhou-j` |
| 公网 IP / 内网 IP | `8.136.107.153` / `172.28.203.153` |
| 镜像 | `m-bp15g4ot7snaz2hhy2ad` |
| 操作系统 | **CentOS Linux 7 (Core)**，glibc 2.17 |
| Node | **仅 Node 16.20.2（`/opt/node16`）**；**没有 `/opt/node22`** |
| PostgreSQL | **15.19**，仅监听 `127.0.0.1:5432` |
| 应用角色 | `youfu_app`：`rolsuper=f`、`rolbypassrls=f`（RLS 有效） |
| 应用端口 | `4001` |
| 域名 | `youfu.banerz.cn` → `8.136.107.153`，HTTPS 200 |
| 证书 | `*.banerz.cn`，有效期至 **2027-01-03**（还剩约 2 个月） |
| Nginx | 自定义 `/usr/local/nginx` 1.16.0，站点 `youfu.banerz.cn.conf` |

> ⚠️ 本地 `deploy/youfu-backend.service` 写的是 `/opt/node22`，但该机**根本不存在该路径**；
> Node 22 官方二进制要求 glibc ≥ 2.28，CentOS 7 的 glibc 2.17 跑不了。
> 现网实际 unit 用的是 `/opt/node16/bin/node`。

---

## 2. 应用实际运行状态

```text
youfu-backend.service  active running
ExecStart=/opt/node16/bin/node dist/server.js
WorkingDirectory=/opt/youfu/backend
AUTH_MODE=prod  NODE_ENV=production  ENV_FILE=/opt/youfu/backend/.env
```

| 项 | 实测 | 含义 |
| --- | --- | --- |
| `GET /health` | 200 `{"ok":true,"status":"up"}` | 进程活着 |
| `GET /health/ready`（本机 4001） | **404** | **当前 dist 还是 P0-8 之前的旧版本** |
| `GET https://youfu.banerz.cn/health/ready` | **200，但返回 index.html** | Nginx 只代理了 `= /health`，`/health/ready` 落到静态 `try_files`，是**假健康** |
| `dist/server.js` mtime | 2026-10-30 07:19 | 旧构建 |
| `dist/routes/patrol.js` | 无 `assertPatrolTaskActor` | 巡更守卫未上线 |
| `dist` 访问日志 | 无 `accessLogMiddleware` | P0-12 未上线 |

结论：**云上跑的是 10-30 旧代码，本轮 11-01~11-07 的 P0 修复一个都没部署。**
11-01 接手报告已指出“11-01 那次只重启、没重建 dist”，本次实测再次确认。

---

## 3. 数据库真实状态（库 `youfu`）

### 3.1 迁移

| 项 | 实测 |
| --- | --- |
| `_migrations` 条数 | **117** |
| 最大迁移名 | `105_drop_service_desk_agent.sql` |
| 本地根目录迁移文件 | **116** |
| 云上已应用但本地根目录没有 | `033_asset_material_enhance.sql`、`053b_review_fixes.sql`、`053c_ugc_contribution.sql`、`105_drop_service_desk_agent.sql` |
| 本地根目录有但云上未应用 | `106_review_fixes_additive.sql`、`107_ugc_contribution.sql`、`109_volunteer_slots_default_one.sql` |
| 云上源码目录迁移文件 | **108**（缺 `090`~`096`、`106`、`107`、`109`） |
| 根目录非规范文件 | `a1_dispatch_rules.sql`（未记账；已于 2026-11-07 移入 `seeds/`，新迁移器不再 fail-closed） |

解释：

- `105` 是破坏性迁移，本地放在 `pending-migrations/`；**云上已经执行**，`service_desk_agent` 表已不存在（`to_regclass` 为空）。
- `053b/053c` 云上已手工执行且已记账；因此 `106/107` 的列效果（`refreshed_at`、`source`、`contributor_tenant`）**已经存在**，补跑只是补记账/幂等。
- `109` **未应用**：`volunteer_activity.slots` 的数据库默认值实测为 **0**，不是 1。
- `090`~`096` 云上 `_migrations` 有记账、磁盘源码无文件；本地源码有这些文件，部署时按记账会 skip，无损。

### 3.2 租户与数据

| tenant_id | 名称 | 状态 |
| --- | --- | --- |
| `t-verification` | 优服家验证租户 | active |
| `t-phasea` | Phase A 演示租户 | active |
| `demo_tenant` | 演示租户 | suspended |
| `t-probe-9292ka3` | 探针租户 | active |
| `t-probe-9294p8k` | 探针租户 | active |

- **没有 `zixing-hospital`（资兴市人民医院）租户**，试点租户尚未创建。
- 工单：`t-verification` 52 张、`t-phasea` 13 张；最后一单创建于 **2026-10-19**。
- worker：15 个；其中 `t-verification / w-test-001 / 测试工人` 的 `account_id` 为空。
- 账号：`t-verification` 22 个账号只有 **3 个不同密码哈希**；`t-phasea` 6 个账号只有 **1 个哈希**。
  ⇒ 仍存在“多人共用同一密码”的风险（11-01 接手报告已提，未完全处置）。

### 3.3 RLS

- 实际启用 RLS 的表：**75**。
- 本地迁移文件中显式 `ENABLE ROW LEVEL SECURITY` 的表：**76**。
- 差集只有 `service_desk_agent`（已被 105 删除）。
  ⇒ **RLS 覆盖与本地迁移一致，未发现因缺迁移导致的 RLS 缺口。**
  注意：`releaseGate` 报“80 张 RLS 表”是静态口径；现网 75 = 76 − 已删除表，不是少了 5 张。

---

## 4. 备份与附件

| 项 | 实测 |
| --- | --- |
| 数据库备份 | `/opt/youfu/backup/youfu_YYYYMMDD_030701.sql.gz`，每日 03:07，保留 14 天 |
| 最近备份 | 2026-11-07 03:07，约 7.2 MB，备份日志 OK |
| 备份方式 | `pg_dump` + `gzip`，以 `postgres` 系统用户执行（绕过 RLS，全量） |
| 异地副本 | **无**；OSS 桶 `youfu-deploy-2026` 只有 2026-08-15 的旧部署包 |
| 附件 | `/opt/youfu/uploads`，7.8 MB / 43 个文件，**未纳入数据库备份** |
| 磁盘 | `/` 79G，已用 41G，可用 35G |

结论：数据库有本地日备，但**没有异地副本，也没有附件备份**；单机磁盘故障 = 数据 + 附件双失。

---

## 5. 安全现状

| 项 | 实测 |
| --- | --- |
| `INVITE_SALT` / `APP_SECRET_SALT` | `INVITE_SALT` 已于 2026-11-07 补配并重启旧服务；**`APP_SECRET_SALT` 仍未设置**（受 8 个 `open_api_app` 存量影响，贸然改会让现有开放 API 签名全部失效，需连同 app secret 一起轮换） |
| 硬编码盐 | `dist/routes/invite.js` 已不再使用兜底（INVITE_SALT 生效）；`platform.js` / `openApiAuth.js` 仍含 `youfu-app-secret-salt` 字面量，因 APP_SECRET_SALT 未配 |
| 公开访问 | `https://youfu.banerz.cn` 首页 200，API 未带 token 返回 401 |
| 默认租户 | `DEFAULT_LOGIN_TENANT=t-verification` |
| 账号密码 | 多账号共用少数哈希（见 §3.2） |
| 旧代码风险 | 本轮 P0 修复未上线，巡检/巡更/通知/账号等旧漏洞仍在线上 |

> 用户既定纪律是“阿里云生产只读，禁写/改/删/重启/压测”。本次严格遵守，未做任何变更。
> 但需要明确：**这个公网环境目前跑的是带已知漏洞的旧代码**；在正式试点前应限制访问或尽快部署新版本。

---

## 6. 部署链路缺口

1. **Node 运行时错位**：本地 unit 假设 Node22；现网只有 Node16，CentOS7 无法直接跑 Node22。
   - 已验证：本地当前 `dist` 的 132 个 `.js` 用 `/opt/node16/bin/node --check` **全部通过**；
   - 源码非测试部分未发现 `fetch` / `structuredClone` / `.at(` 等 Node18+ 运行时依赖；
   - ⇒ 当前代码**可以短期跑在 Node16**，但 Node16 已 EOL，不能作为长期生产运行时。
2. **`a1_dispatch_rules.sql` 会让新迁移器 fail-closed**：它原在云上根目录、命名不合规、未记账；已于 2026-11-07 移入 `seeds/`；
   部署当前代码前必须先移入 `seeds/`（它是 `t-verification` 的幂等派单规则种子，不是 DDL）。
3. **迁移脚本硬编码 `-d youfu`**：`scripts/migrate-as-owner.sh` 不能直接用于新库；新库需用
   `dist/db/migrate.js`（以 postgres + unix socket）或复制脚本改库名。
4. **`/health/ready` 未在 Nginx 代理**：外网访问会拿到 index.html 200，监控会假绿。
5. **证书 2027-01-03 到期**：不是当前阻断，但需在试点期内续期。
6. **无 git 部署**：`/opt/youfu/backend` 不是 git 仓库，源码与 dist 可能不同步（本次已实证：源码 10-28、dist 10-30）。

---

## 7. 对 G1 的结论

| G1 项 | 状态 |
| --- | --- |
| 代码本机测试/构建 | ✅ 199 文件 / 2442 用例、tsc、build、releaseGate 全绿 |
| 真实环境 116 迁移 | ❌ 未在全新库演练；现网是 117 条历史混合账 |
| 真实环境 RLS 实证 | 🟡 现网 RLS 75 表与本地一致；但缺跨租户实测记录 |
| 备份恢复演练 | ❌ 只有每日本地 dump，未做恢复演练；无异地/附件备份 |
| 部署当前版本 | ❌ 云上仍是 10-30 旧 dist；`/health/ready` 404 |
| 试点租户 | ❌ 未创建 `zixing-hospital` |
| 真机 UAT | ❌ 未做 |
| 可观测性 | ❌ 旧代码无访问日志；Nginx `/health/ready` 假 200 |

**一句话：本机代码已到可进 G1 的状态，但云上环境没有；当前云上是“公开可访问的旧版本演示环境”，不是试点环境。**

---

## 8. 建议的下一步（需明确授权后执行）

### 方案 A（快，推荐用于单租户试点验证）
在现有 ECS 上做**隔离试点**，不动现有 4001/`youfu` 库：

1. 新建数据库 `youfu_pilot`（属主 postgres），新目录 `/opt/youfu/pilot/backend`；
2. 上传当前代码/构建物，复制 `.env` 并改 `PGDATABASE=youfu_pilot`、`PORT=4101`；
3. 以 postgres 执行 116 个迁移 + `grant-youfu_app.sql`；
4. 新 systemd 单元 `youfu-pilot.service`（Node16），新 Nginx vhost（如 `pilot.banerz.cn`）；
5. 运行 `npm run preflight -- --tenant=zixing-hospital`、RLS 跨租户、备份恢复演练；
6. 通过后再决定是否切 `youfu.banerz.cn`。

> 优点：可立即执行，不碰现网数据；缺点：Node16 EOL，仅适合试点期。

### 方案 B（稳，推荐用于正式上线）
新建一台 Alibaba Cloud Linux 3 / Ubuntu 22 的 ECS（Node22 + PG15），全新库、全新域名，
按 `docs/pilot-initialization-checklist.md` 从零初始化。现有 ECS 保持只读/演示。

> 需要云控制台或 RAM 授权；当前只有现网 SSH 和 OSS 凭据，不能直接创建 ECS。

### 无论哪个方案，先做这三件事
1. **限制旧环境公网访问**（IP 白名单/临时停用），直到新版本部署；当前旧代码带已知漏洞。
2. **补 `INVITE_SALT` / `APP_SECRET_SALT`**，并把代码改成 prod 缺失即拒绝启动（本地待改）。
3. **手动备份 + 恢复演练**：`pg_dump` 之外，把 `/opt/youfu/uploads` 一起纳入备份/异地。

---

## 9. 隔离试点环境已建立（2026-11-07，方案 A 预演）

> 目的：在不碰现网 4001/`youfu` 的前提下，用真实 PG + 当前代码验证 G1 技术项。
> 所有写操作仅限**新库 `youfu_pilot`、新目录 `/opt/youfu/pilot`、新服务 4101**；
> 未修改现网 `youfu` 库、未重启 `youfu-backend`、未改主 Nginx 站点。

### 9.1 已完成的真实验证

| 项 | 结果 |
| --- | --- |
| 全新库 `youfu_pilot` | 116/116 迁移成功，`_migrations`=116 |
| `volunteer_activity.slots` 默认值 | **1**（109 生效） |
| RLS 表数 | **76**（含尚未被 105 删除的坐席表；与本地迁移基线一致） |
| 服务 | `youfu-pilot.service` active，`/opt/node16/bin/node dist/server.js`，端口 4101 |
| `/health` / `/health/ready` | 200 / **200 `{"db":"up"}`** |
| 访问日志 | 单行 JSON，`X-Request-Id` 贯穿；404/201 均落日志 |
| `preflight` | 9 项全 PASS（迁移/租户/admin/worker 绑定/RLS/环境） |
| RLS 跨租户 | A 租户只看到自己 1 个 worker，B 租户 0 个，总数 1 |
| 备份恢复 | `pg_dump` → `youfu_pilot_restore` 恢复成功，迁移 116、admin 1、worker 1、租户 1 |
| 角色冒烟 | admin `accounts` 200；operator `inspection` 200；worker `inspection/patrol` 200、`accounts` 403 |
| 志愿者默认名额 | API 创建未传 `slots` → 返回 `"slots":1` |
| 巡更读侧 | worker 只看到本人任务；他人任务详情 403；admin 看到全部 |

### 9.2 当前限制

- 管理员/操作员一次性密码保存在服务器 `/opt/youfu/pilot/initial-credentials.txt`（600），
  未在本文档或聊天中输出；worker 一次性密码在 `/opt/youfu/pilot/worker-create.json`（600）。
- **PC 管理端与 Nginx 已就绪**：PC 管理端已构建并上传 `/opt/youfu/pilot/frontend-dist`（不是 H5；H5 不进入试点）；主站 Nginx 已新增 `/pilot/api/` → 4101 的精确反代，`https://youfu.banerz.cn/pilot/api/v1/auth/login` 实测登录 200，无需新增 DNS/微信域名白名单。
  新增 `pilot.banerz.cn` vhost（80→443、`/api/`→4101、`/health(ready)` 精确代理），
  `nginx -t` 通过并已 reload；服务器本机用 SNI 测试 `/`、`/health`、`/health/ready` 均 200。
- **DNS 未配置**：`pilot.banerz.cn` 当前无 A 记录，外网还访问不到；需要在阿里云 DNS
  添加 A 记录指向 `8.136.107.153`（或用 hosts/SSH 隧道临时访问）。
- 仍跑在 CentOS7/Node16（试点预演），**不是正式交付环境**；
- **业务基础数据未初始化**：`zixing-hospital` 是直接插入的租户行，未走平台开通的
  行业模板/分类/流程定义复制；当前只验证了认证、权限、RLS、巡更读侧等代码路径，
  不能直接交给医院用户做完整业务 UAT。正式 UAT 前需按清单初始化部门/位置/报修人/
  故障分类/设备类型/巡检点/巡更点等基础数据。
- **小程序 pilot 已接入**：从 `youfu_mp` 复制出 `youfu_mp_pilot`，`config.js` 指向
  `https://youfu.banerz.cn/pilot`；微信开发者工具 CLI 已 preview/upload **v5.9.13** 成功
  （AppID `wxb99197ac59cfa519`，包 550.6KB）。主域名已在微信合法域名内，无需新增域名。
  H5 不进入试点；PC 管理端仅作后台配置。
- 小程序完成体验版扫码后，仍需要业务基础数据（部门/位置/报修人/分类/巡检点等）才能完整 UAT。

### 9.3 下一步

- 小程序体验版已上传：微信开发者工具 → 版本管理 → 开发版本 v5.9.13；
  真机扫码即可连到 `/pilot` API。
- 若继续用方案 A：不建议再加 `pilot.banerz.cn` DNS；直接复用主域名 `/pilot` 更省事。
- 若走方案 B：按本文件 §8 新建 Alibaba Cloud Linux 3/Ubuntu 22 + Node22，重新执行
  116 迁移/preflight/RLS/备份恢复；现有 4101 可作为对照环境保留或下线。
