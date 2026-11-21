# 发布基线（P0-2）· 2026-11-20

## 1. 结论

P0-2 已闭环：后端/前端都有真实 commit、tag、干净工作树、可复现发布清单，并由 GitHub Actions 生成成功 artifact。

| 项 | 值 |
| --- | --- |
| 后端 release commit | `3dbcf119fb781ff122b28a27e58efcfbde8c004a` |
| 后端 tag | `release-20261120-module-auth` |
| 前端 release commit | `9e3e728a30d4e8d6c909aebcf5563bf62de5d3c3` |
| 前端 tag | `release-20261120-module-auth` |
| 发布清单 | `release-manifest.json` |
| 双仓库基线 | `release-baseline.json` |
| 发布 ID | `20261120T142638-3dbcf119fb78` |
| 服务器发布目录 | `/opt/youfu/releases/20261120T142638-3dbcf119fb78` |
| `current` 软链 | `/opt/youfu/releases/current` |

## 2. CI 与 artifact

- 工作流：GitHub Actions `CI`
- 成功运行：<https://github.com/chu-yi-shiwu/youfu-platform-backend/actions/runs/44752715741>
- 结论：`success`
- artifact：`youfu-release-3dbcf119fb781ff122b28a27e58efcfbde8c004a`
- 大小：634,656 bytes
- 保留：30 天
- artifact 内容：`dist/` + `release-manifest.json`

CI 步骤全部通过：Install、Typecheck、Build、Release manifest、Upload artifact、C3 发布闸门（全量 vitest + SQL 注入扫描 + 迁移幂等 + RLS 策略 + SQL 列契约）。

## 3. 发布清单关键字段

`release-manifest.json`：

- `commit = 3dbcf119fb781ff122b28a27e58efcfbde8c004a`
- `cleanTree = true`
- `migrations = 134`
- `distFileCount = 152`
- `distSha256 = f891e94f0ef1...`（完整值见文件）

`release-baseline.json`：

- backend commit `3dbcf11...`，clean `true`
- frontend commit `9e3e728...`，clean `true`
- backend dist sha256 `25e1bbcb8268...`
- frontend dist sha256 `5be4407fbf91...`
- frontend pilot dist sha256 `1b9bd1db9593...`
- OpenAPI sha256 `b7248ebca499...`

## 4. 本次修复的发布阻断

### 4.1 CI 缺失 seed

`src/test/migrationManifest.test.ts` 读取 `seeds/a1_dispatch_rules.sql`，但 `.gitignore` 的 `a1_dispatch_rules.sql` 模式把整个仓库内同名文件都忽略了，CI 检出后文件不存在。

修复：忽略规则收窄为根目录 `/a1_dispatch_rules.sql`，并把 `seeds/a1_dispatch_rules.sql` 纳入版本库。

### 4.2 CI 慢 runner 超时

`vitest.config.ts` 使用默认 5s 测试超时，PGlite/真库穿透用例在 CI 共享 runner 上会因机器慢被误判为断言失败。调整为 `testTimeout/hookTimeout = 30s`，不改变断言。

### 4.3 迁移账本漂移

两库 `_migrations` 修复：

- `127_module_authorization.sql` 登记名误带前后空格 → `btrim` 修正；
- `116_volunteer_enhancements.sql`、`117_pilot_closure_gaps.sql`、`118_patrol_point_qr.sql` 结构已存在但未登记 → 补登记。

修复后两库 `_migrations` 均无前后空格脏登记；试点库 134 条与仓库 134 个迁移文件对齐。

### 4.4 真实院方 PII 不入库

`docs/pilot-master-hospital-real-20261110/` 含 58 个联系人手机号、15 个员工手机号。已加入 `.gitignore`，不进入 commit/artifact；保留脱敏模板目录。

## 5. 复现命令

```bash
# 后端（Node 22 + git 在 PATH）
npm ci
npm run typecheck
npm run build
npm run manifest
npx tsx scripts/releaseGate.ts --force-vitest

# 双仓库基线
node scripts/release-baseline.mjs --frontend ../youfu_frontend_dev
```

Windows 本地无 PATH git 时：

```powershell
$env:GIT_BIN = "C:\Users\Administrator\AppData\Local\Programs\WorkBuddyAI\resources\vendor\PortableGit\cmd\git.exe"
node scripts/release-baseline.mjs --frontend ..\youfu_frontend_dev
```

## 6. r2 补强：设置中心写门禁

在 r1 基础上增加 `configuration` / `foundation` / `system` / `feedback` 写端点模块门禁，并修复 guard 路径越界。

| 项 | 值 |
| --- | --- |
| 后端 r2 commit | `a53138911f96cbea03acb35c0298802b754497c0` |
| 后端 r2 tag | `release-20261120-module-auth-r2` |
| CI run | `44760794418`，success |
| artifact | `youfu-release-a53138911f96cbea03acb35c0298802b754497c0`，635,510 bytes |
| release ID | `20261120T151744-a53138911f96` |
| 服务器 current | `/opt/youfu/releases/20261120T151744-a53138911f96` |
| live 模块审计 | 17 / 17 PASS |
| 主站/pilot 资产审计 | 38 / 38 PASS |

r2 额外修复：`router.use(guard)` 未限定路径会把后续所有请求一起拦截（例如关闭 configuration 误伤 `/departments`、`/inventory/consume`）。现所有 guard 已限定到自身 router 前缀，并有跨 router 回归测试。

## 7. r3 公共报修本人评价

| 项 | 值 |
| --- | --- |
| 后端 r3 commit | `cae38ef1aa431426ace80c6f8e2b4381a5b27471` |
| 后端 r3 tag | `release-20261120-public-eval` |
| CI run | `44766744187`，success |
| artifact | `youfu-release-cae38ef1aa431426ace80c6f8e2b4381a5b27471`，635,872 bytes |
| release ID | `20261120T160604-cae38ef1aa43` |
| 服务器 current | `/opt/youfu/releases/20261120T160604-cae38ef1aa43` |
| 公共评价 live 审计 | 5 / 5 PASS |
| 主站/pilot 资产审计 | 38 / 38 PASS |
| 模块审计 | 17 / 17 PASS |

公共报修评价复用 `view_token`，不新增表；流转副作用与通用端点共用 `finalizeTransitionSideEffects()`。小程序代码已改，需按微信开发者工具流程上传发布。

## 8. r4 工程闭环

| 项 | 值 |
| --- | --- |
| 后端 commit | `235598f15884539d1fdcc0d2bd0e465eb2c08a05` |
| 前端 commit | `00519766fec0f5e7425f5b2ce219a1e0189113ca` |
| tag | 两端均 `release-20261121-r4` |
| backend CI | run `44770156839`，success |
| frontend CI | workflow 已加入；仓库 API 返回 404，无法在线核验，本地等价门禁全绿 |
| release ID | `20261120T164124-235598f15884` |
| 服务器 current | `/opt/youfu/releases/20261120T164124-235598f15884` |
| 前端 lint | 0 warning |
| 前端测试 | 269 / 269 |
| 小程序 pilot | 5.9.28 已上传开发版本；manifest digest `66ce6192f766...` |

r4 前端改动为 lint 清理与 CI 接入，无运行时行为变化；前端 dist 已重新部署并验证主站/ pilot 页面 200。小程序 5.9.28 需在微信后台手动点「设为体验版」后再由体验成员验收。

## 9. r5 巡检/任务列表修复

| 项 | 值 |
| --- | --- |
| 代码 commit | `e666ee4ec95e78d70e113adaa19c8132f89789af` |
| 文档 commit | `bcc4af52d137aa40921a0ad24b7608fa0fcbacc7` |
| tag | `release-20261121-r5` |
| backend CI | run `44781023814`（代码）、`44782728675`（文档），success |
| release ID | `20261120T172304-bcc4af52d137` |
| 服务器 current | `/opt/youfu/releases/20261120T172304-bcc4af52d137` |
| 巡检终态写记录 | 409 `TASK_CLOSED`，负控制通过 |
| live 今日完成 | `done_count=2`、`today_done=1` PASS |
| 小程序 pilot | 5.9.29 已上传开发版本；manifest digest `6bbbc51ef6fb...` |

## 10. r6 工作台四类任务统计

| 项 | 值 |
| --- | --- |
| 后端代码 commit | `cb4e583f8f620150b9c5c23376c4b580d5e4c435` |
| tag | `release-20261121-r6` |
| backend CI | run `44868458546`，success |
| artifact | `youfu-release-cb4e583f8f620150b9c5c23376c4b580d5e4c435`，638,070 bytes |
| release ID | `20261121T045626-cb4e583f8f62` |
| 服务器 current | `/opt/youfu/releases/20261121T045626-cb4e583f8f62` |
| 后端全量 | 220 文件 / 2613 用例 |
| 小程序 pilot | 5.9.30 已上传开发版本；manifest digest `3d40b2b0a13e...` |
| 小程序主站 | commit `4822eef`；39 / 39 通过 |
| live 四类统计 | `active=4`、`done=12`、`today_done=4`、`today_new=8` PASS |

r6 把工作台统计从仅 `work_orders` 扩展到维修/巡检/运送/能耗四表，并新增 `stats_by_type`；`today_done` 只认成功完成态且按业务完成字段的 Asia/Shanghai 本地日计算。live 审计专门把三天前完成任务的 `updated_at` 改成今天，确认不会重新计入今日完成。

## 11. r7 复审补强

| 项 | 值 |
| --- | --- |
| 后端代码 commit | `6fc099900538c894f9e90ed1aac1973e74f8ebf1` |
| tag | `release-20261121-r7` |
| backend CI | run `44870201468`，success |
| artifact | `youfu-release-6fc099900538c894f9e90ed1aac1973e74f8ebf1`，638,212 bytes |
| release ID | `20261121T051753-6fc099900538` |
| 服务器 current | `/opt/youfu/releases/20261121T051753-6fc099900538` |
| 后端全量 | 220 文件 / 2614 用例 |
| 小程序 pilot | 5.9.31 已上传开发版本；manifest digest `61efecc6c8ae...` |
| 小程序主站 | commit `e8ea961`；39 / 39 通过 |
| live 四类统计 | 复跑 PASS，`active=4`、`done=12`、`today_done=4`、`today_new=8` |

r7 复审修复：巡检通用 `/transition` 进入 `done` 时强制写 `done_at`；补齐能耗/运送状态中文标签；工作台“累计完成”改为“累计完成/结束”，明确 `done_count` 包含取消/异常终态。

## 12. r8 统计索引与完成时间加固

| 项 | 值 |
| --- | --- |
| 后端代码 commit | `b0e02820008566b307819f1647e564c1320c36d0` |
| tag | `release-20261121-r8` |
| backend CI | run `44871608101`，success |
| artifact | `youfu-release-b0e02820008566b307819f1647e564c1320c36d0`，624 KB |
| artifact sha256 | `6d172516589871ca015df7767263734bda97ece86c747c2ce99adfda1e6c34ad` |
| migrations | 135（新增 128） |
| release ID | `20261121T053546-b0e028200085` |
| 服务器 current | `/opt/youfu/releases/20261121T053546-b0e028200085` |
| 后端全量 | 220 文件 / 2616 用例 |
| 小程序 pilot | 5.9.32；manifest digest `7d089ba7fd05...` |
| 小程序主站 | commit `b9e14a0`；40 / 40 通过 |
| live 四类统计 | 复跑 PASS，`active=4`、`done=12`、`today_done=4`、`today_new=8` |

r8 优化：
- 工作台统计查询补巡检/能耗 worker 索引；
- 能耗 `submitted_at` 增加安全时间转换、历史清洗与 CHECK 约束；
- 自定义工单完成态补 `completed_at`，避免今日完成回退 `updated_at`；
- 工作台增加四类任务拆分，并支持点分类进入对应筛选。

## 13. r9 运送完成时间收口与多档案审计

| 项 | 值 |
| --- | --- |
| 后端代码 commit | `799eef5bc541fed337ff2a60d0e2d650f6bcd0a8` |
| tag | `release-20261121-r9` |
| backend CI | run `44875433421`，success |
| artifact | `youfu-release-799eef5bc541fed337ff2a60d0e2d650f6bcd0a8`，624 KB |
| artifact sha256 | `fae5d97e90f4acccea86044e82b22aaf7dbd76398e908db0857e654910ecc040` |
| migrations | 135 |
| release ID | `20261121T062503-799eef5bc541` |
| 服务器 current | `/opt/youfu/releases/20261121T062503-799eef5bc541` |
| 后端全量 | 220 文件 / 2617 用例 |
| 小程序 pilot | 5.9.33；manifest digest `dc793a2a47d3...` |
| 小程序主站 | commit `aaaa8b0`；42 / 42 通过 |
| live 四类统计 | 复跑 PASS，`active=4`、`done=12`、`today_done=4`、`today_new=8` |
| 重复 worker 档案审计 | 主站 PASS、pilot PASS |

r9 收口：
- 运送完成时间从 HTTP 路由分支移入 `transitionOrder` 内核，任何路径进入 `done` 都写 `sign_at/arrive_at`；
- 新增 `scripts/audit-duplicate-workers.mjs` 只读审计，先监测同一账号多条 worker 档案，不在统计层做半套对齐。

## 14. 约束

- `release-manifest.json` / `release-baseline.json` 是可复现发布 artifact，不进入源码库；
- `release-baseline.mjs` 默认 fail-closed：commit 缺失或工作树不干净直接退出 1；
- 发布目录保留 manifest、baseline、CI 元数据，`/opt/youfu/releases/current` 指向当前发布。
