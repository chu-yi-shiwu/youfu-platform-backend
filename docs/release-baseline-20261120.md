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

## 14. r10 analytics 模块机制隔离

| 项 | 值 |
| --- | --- |
| 后端代码 commit | `bcd54d11f142fcd4e7248455415045404a4cae37` |
| tag | `release-20261121-r10` |
| backend CI | run `44900395965`，success |
| artifact | `youfu-release-bcd54d11f142fcd4e7248455415045404a4cae37`，638,792 bytes |
| artifact sha256 | `0d250d3dfc307545f1da13a9bf4b4091c72913cd2e4bc80c6b8434c3a27a845f` |
| migrations | 135 |
| release ID | `20261121T114245-bcd54d11f142` |
| 服务器 current | `/opt/youfu/releases/20261121T114245-bcd54d11f142` |
| 后端全量 | 221 文件 / 2621 用例 |
| 小程序 pilot | 5.9.33；manifest digest `dc793a2a47d3...` |
| 小程序主站 | commit `aaaa8b0`；42 / 42 通过 |
| live analytics 烟测 | 主站/pilot `/stats`、`/stats/by-catalog` 均 200 |

r10 机制修复：
- `/stats` 从共享 `workOrderRouter` 移出，归并到 `statsRouter`；
- `statsRouter` 自身挂 `requireModule('analytics')`；
- 模块关闭时管理面 403 `MODULE_DISABLED`，开启时 200；
- 移动端工单执行端点不受影响；
- 新增路由边界静态回归，防止 `/stats` 回到共享路由。

## 15. r11 work_order 管理面/执行面拆分

| 项 | 值 |
| --- | --- |
| 后端代码 commit | `94c4872f4be068cc998f4719765f12a37a6e1dc8` |
| tag | `release-20261121-r11` |
| backend CI | run `44906562140`，success |
| artifact | `youfu-release-94c4872f4be068cc998f4719765f12a37a6e1dc8`，639,451 bytes |
| artifact zip sha256 | `bac963783fa07f132c221638d5b6b670dee077ffc90c8b6423ba4b7bfaf331ac` |
| 本地构建 dist | 153 文件；sha256 `1819ec8c333d45ad93fc95c49511a16e7d36b3a54fd9fc4a50970054159d3dec` |
| migrations | 135 |
| release ID | `20261121T130550-94c4872f4be0` |
| 服务器 current | `/opt/youfu/releases/20261121T130550-94c4872f4be0` |
| 后端全量 | 222 文件 / 2632 用例 |
| 前端代码 commit | `824bee8`；H5 构建 commit `d6d3aae`，tag `release-20261121-r11`；36 文件 / 269 用例 |
| 小程序 pilot | 5.9.34；manifest digest `73e9e8bede17...`；44 / 44 通过 |
| 小程序主站 | commit `a8ecad4` + `777f9ec`；42 / 42 通过 |
| live 边界烟测 | `uat-r11-boundary` 临时租户，测后删除，行数归零 |

r11 机制修复：
- 管理端点统一迁到 `/admin/work-orders/*`，由 `requireModule('work_order')` 单点门禁；
- 执行端点继续走 `/open/*`，统一挂 `requireWorkerExecution`，非 worker 不能借共享路由绕过模块；
- 管理/执行共用同一份 handler，不复制实现；管理端补照片/语音新增 admin 契约；
- `/sla/scan` 归入 admin 后，删除 `apiGuard` 中失效的 `sla` 首段白名单；
- OpenAPI 新增 14 个 admin 路径，移除 7 个旧 open 管理路径；路由边界新增静态与 HTTP 负控制。

r11 live 边界证据（模块只在 uat 开关，真实 pilot 只读）：
- 模块关闭：admin `/admin/work-orders` 403 `MODULE_DISABLED`；
- 模块关闭：worker `/open/work_orders` 200，`/open/me/summary` 不被模块门禁拦截；
- admin 访问 `/open/work_orders` 始终 403 `worker execution endpoint`；
- 模块开启：admin 列表 200、claim-hall 200、补照片进入 handler（无单 404，不是 403）。
- 真实租户只读复核：主站 `t-verification`、pilot `zixing-hospital` 均为 admin 列表 200 / admin 走 open 403 / worker open 200；未切换真实租户模块开关。

### 15.1 r11.1 修正：worker 执行建单保留 /open

r11 初版把 `POST /open/work_order` 一并迁走，worker 陪检/代报修建单会 404。r11.1 修正为双契约：
worker 执行建单走 `/open/work_order` 且仅 worker；管理建单走 `/admin/work-orders` 且受模块门禁；两者共用同一 handler。

| 项 | 值 |
| --- | --- |
| 后端代码 commit | `6dc7b234adf64f9b157f7c6326e048b8436458c9` |
| 发布 commit（含文档） | `0a22c9f75682e9246d093128de38653d02d35a36` |
| tag | `release-20261121-r11.1` |
| backend CI | run `44908319483`，success |
| artifact | `youfu-release-0a22c9f75682e9246d093128de38653d02d35a36`，639,571 bytes |
| artifact zip sha256 | `6bbfbdfd8e1f496760655cb31343c5398265b5bfb05a38f96689c9a8e1db539c` |
| 本地构建 dist | 153 文件；sha256 `eacc0b71b8f4d09e8a6b4265dbca1fb5d69b713ce244c2b5633b051773cf7bdb` |
| release ID | `20261121T132002-0a22c9f75682` |
| 服务器 current | `/opt/youfu/releases/20261121T132002-0a22c9f75682` |
| 小程序 pilot | 5.9.35；manifest digest `da6a309a0572...`；44 / 44 通过 |
| 小程序主站 | 5.9.36 开发版已上传；manifest digest `2b86ca7366b8...`；源码 commit `f4a6d92`；42 / 42 通过 |
| live 边界烟测 | worker 在模块关闭的 uat 租户建单 201；admin open 仍 403；真实租户只读复核 PASS |

r11.1 live 证据（uat 租户测后删除，行数归零）：
- 模块关闭：admin `/admin/work-orders` 403 `MODULE_DISABLED`；
- 模块关闭：worker `POST /open/work_order` 201（陪检/代报修不被模块误伤）；
- 模块关闭：worker `GET /open/work_orders` 200；
- admin 访问 `/open/work_orders` 403 `worker execution endpoint`；
- 模块开启：admin 列表 200、claim-hall 200、补照片 404（进入 handler，不是 403）。

## 15.2 r11.2：生产租户迁移 + 非 UUID 工单详情修复

| 项 | 值 |
| --- | --- |
| 后端代码 commit | `369ed77327a8629934fddcba5c05b350b252c98b` |
| tag | `release-20261121-r11.2` |
| backend CI | run `44916642257`，success |
| artifact | `youfu-release-369ed77327a8629934fddcba5c05b350b252c98b`，639,651 bytes |
| artifact zip sha256 | `3f72f32a78da59e5309524cc05d08f4b1d56616d264889362deb56d09ef7406f` |
| 本地构建 dist | 153 文件；sha256 `b74614cc0b1d4413dc84e273fad07bf543cfec03d75b8540075b80c13abf3df7` |
| migrations | 135 |
| release ID | `20261121T145813-369ed77327a8` |
| 服务器 current | `/opt/youfu/releases/20261121T145813-369ed77327a8` |
| 后端全量 | 223 文件 / 2635 用例 |
| 前端 | commit `1e683af`，dist 未变 |
| 小程序主站 | 5.9.36 开发版；manifest digest `2b86ca7366b8...` |
| 小程序 pilot | 5.9.35 开发版；manifest digest `da6a309a0572...` |

r11.2 修复：
- 工单 ID 是 text（陪检单存在 `escort-*` 非 UUID），`asset.linked_order_ids` 是 `uuid[]`；
- 详情关联资产、完成/取消时恢复资产状态两处 SQL 不再 `$2::uuid` 强转，统一按 text 比较；
- 新增 PGlite 负控制：`escort-*` 按 uuid 强转必报错，按 text 比较安全返回空；
- live 验证：主库 `zixing-hospital` 的 `escort-mwp7t1tm-o6gun4` 详情 200。

生产租户迁移（同一发布窗口完成）：
- `youfu_pilot.zixing-hospital` → `youfu.zixing-hospital`；
- 75 张业务表、463 行；跳过 AI/推理日志/幂等缓存 10 张表；
- 校验 tenant=1、dept=1、accounts=3、workers=16、workOrders=6；业务外键 10 项全 0 异常；
- 6 个媒体文件复制到主库 uploads，sha256 一致；
- 主库 API 烟测：admin 列表 200 total=6、stats/workbench 200、worker 列表 200、me/summary 200；
- pilot 仍是当前写入源；最终切换前需冻结写入并用 `--replace` 重放一次。

## 15.3 r11.3：管理面角色边界与 worker 催办

| 项 | 值 |
| --- | --- |
| 后端代码 commit | `0188b3516f62fff584d50ffdc76b406f64f44ab8` |
| tag | `release-20261121-r11.3` |
| backend CI | run `44927019738`，success |
| artifact | `youfu-release-0188b3516f62fff584d50ffdc76b406f64f44ab8`，639,865 bytes |
| artifact zip sha256 | `13db7669697914346bbd1f5cd22c60e604633929dc00de2842701fdc48a847c0` |
| 本地构建 dist | 153 文件；sha256 `c80099ffd967b4d5dae8432d7354b63337f87c7ea4448fd3a40528b862ee1170` |
| migrations | 135 |
| release ID | `20261121T165348-0188b3516f62` |
| 服务器 current | `/opt/youfu/releases/20261121T165348-0188b3516f62` |
| 后端全量 | 223 文件 / 2637 用例 |
| 前端 H5 | commit `130bb2b`，tag `release-20261122-h5-routing`；asset `assets/index-CWohyopO.js` |
| 小程序主站 | 5.9.36 开发版不变 |
| live 角色边界 | admin 200 / admin 走 open 403 / worker open 200 / worker admin 403 / worker events 403 / worker dispatch-recommend 403 / escort detail 200 |

r11.3 修复：
- `/admin/work-orders/*` 在模块门禁之外新增管理角色门禁，worker 不能读取管理事件流、派单推荐或触发管理动作；
- worker 建单人催办保留在 `/open/work_order/:id/urge`，管理催办仍在 `/admin/work-orders/:id/urge`；
- H5 代报修/任务详情按角色选择 `/open` 或 `/admin`，worker 不再被管理门禁误伤；
- OpenAPI 恢复 worker urge 路径，静态/HTTP 边界测试与 live 烟测同步更新。

## 15.4 r11.4 / r11.5：数据大屏运营化

| 项 | 值 |
| --- | --- |
| r11.4 后端 commit | `081cea020e8c2c2a12aa7693b92934e968fb246f` |
| r11.5 后端 commit | `4e8178dc9579c682f5630f0229e40e2c0bca93fe` |
| tag | `release-20261123-r11.5` |
| backend CI | run `45098893607`，success |
| artifact | `youfu-release-4e8178dc9579c682f5630f0229e40e2c0bca93fe`，640,694 bytes |
| artifact zip sha256 | `bdb1bc398ffee9876fac9e2d0063d1c1db4e61cb5d05665c92c52fb48e8c4425` |
| 本地构建 dist | 154 文件；sha256 `07fe78b3ed652db2e1fbf369e18f1d9b3e102916be2e7fdffa9318cba5fea758` |
| release ID | `20261123T021257-4e8178dc9579` |
| 服务器 current | `/opt/youfu/releases/20261123T021257-4e8178dc9579` |
| 前端 commit | `70f624b`（follow-up `07c2a66`），tag `release-20261123-dashboard` |
| 主站 PC asset | `assets/index-D4drDnbx.js` |
| PC pilot asset | `assets/index-D6aQBlE7.js` |
| 后端全量 | 223 文件 / 2637 用例 |
| 前端全量 | 38 文件 / 273 用例 |

数据大屏从“统计展示”改为“运营指挥”：
- 接入全局部门筛选；工单 KPI/超时按部门口径，满意度/趋势/过程挖掘明确标注全租户；
- 首屏改为今日新增、待处理、处理中、超时、今日完成、工单总量；
- 状态分布改为实时流转桶（待处理/待接单/处理中/已完成/已取消/其他），可点击下钻工单列表；
- 新增超时预警（数量、最早到期、平均超时、分类 Top），可下钻超时列表；
- 满意度无评价时显示“暂无评价”，星级分布分母改为已评价数，不再显示误导性的 0.0/100% 未评价；
- 实时轮询 30s，过程挖掘 5min；增加上次更新时间、局部刷新失败提示；
- 后端新增 `today_done`、超时部门过滤，并把工作台/超时预警统一到 `appendTimeoutExclusion` 同一按版本终态口径；`earliest_due` 修正为 MIN。

live 复核：`timeout=1` 与 `overdue_total=1` 一致；`today_new=0`、`today_done=0`、buckets 与主库一致。

## 15.5 r11.6：数据大屏「需要关注」与 SLA 老化

| 项 | 值 |
| --- | --- |
| 后端 commit | `c9b971e8afc2df349986098a12dca954744ddbc6` |
| tag | `release-20261123-r11.6` |
| backend CI | run `45101020247`，success |
| artifact | `youfu-release-c9b971e8afc2df349986098a12dca954744ddbc6`，640,834 bytes |
| artifact zip sha256 | `6e70cd834d0d8ec679258bb8eaa83c28321d3c607a484132eb593548d90af47f` |
| 本地构建 dist | 154 文件；sha256 `c2deb9f9bb6765653e66b55cc2d6b9fa0e8d249ebe644d1026118c4dc0d510dc` |
| release ID | `20261123T024540-c9b971e8afc2` |
| 服务器 current | `/opt/youfu/releases/20261123T024540-c9b971e8afc2` |
| 前端 commit | `f2e6368`，tag `release-20261123-dashboard-r2` |
| 主站 PC asset | `assets/index-DSABYt5p.js` |
| PC pilot asset | `assets/index-DtpTLBz2.js` |
| 后端全量 | 223 文件 / 2637 用例 |
| 前端全量 | 38 文件 / 273 用例 |

r11.6 增补：
- 数据大屏新增「需要关注」Top5：超时 + 待派，点击直达工单详情；
- 超时预警新增 SLA 老化分段：≤1h / 1–4h / 4–24h / >24h；
- live 复核：`timeout=1`、`overdue_total=1`、`age_buckets.gt_24h=1`、attention=`WO_20261121_3525015335`。

## 15.6 r11.7：师傅负载 Top5

| 项 | 值 |
| --- | --- |
| 后端 commit | `6054ccca999b2c01b2ec5c8ade9b5603144f97e9` |
| tag | `release-20261123-r11.7` |
| backend CI | run `45103675638`，success |
| artifact | `youfu-release-6054ccca999b2c01b2ec5c8ade9b5603144f97e9`，640,952 bytes |
| artifact zip sha256 | `42b7e04e222922d1fe95e77a0ce77fecc6199fa251d4919416eabe8328515674` |
| 本地构建 dist | 154 文件；sha256 `b4dfb0772b321179d6aa61f7d7b86b9aa006ea4eabb49f4ad68a1d99c25da228` |
| release ID | `20261123T030534-6054ccca999b` |
| 服务器 current | `/opt/youfu/releases/20261123T030534-6054ccca999b` |
| 前端 commit | `5fc9b06`，tag `release-20261123-dashboard-r3` |
| 主站 PC asset | `assets/index-zHNN3cL1.js` |
| PC pilot asset | `assets/index-BvoxXvec.js` |
| 后端全量 | 223 文件 / 2637 用例 |
| 前端全量 | 38 文件 / 273 用例 |

r11.7 增补：
- `/stats/worker-load-drift` 支持 `department_id` / `department_unassigned`；
- 数据大屏把「模数共振」替换为「师傅负载 Top5」，显示在办单数与系统 load；
- live 复核：worker-load 200，Top5 返回；超时/attention 口径不变。

## 15.7 r11.8：阶段时长、部门过程挖掘、到期前预警

| 项 | 值 |
| --- | --- |
| 后端 commit | `fc99b6726f9e805667eaf382d5462548be16a242` |
| tag | `release-20261123-r11.8` |
| backend CI | run `45107645347`，success |
| artifact | `youfu-release-fc99b6726f9e805667eaf382d5462548be16a242`，645,091 bytes |
| artifact zip sha256 | `51be12b45e4429c26d45231978d1d197442810706140f45a31cebd0731f54f2d` |
| 本地构建 dist | 155 文件；sha256 `e70434d084876758c0b7dff7751d7605bc8712c4bab93ce81176fabe1738b6eb` |
| release ID | `20261123T034529-fc99b6726f9e` |
| 前端 commit | `b053a73`，tag `release-20261123-dashboard-r4` |
| 主站 PC asset | `assets/index-zx6sjUbH.js` |
| PC pilot asset | `assets/index-CJoZdUDz.js` |
| 后端全量 | 226 文件 / 2653 用例 |
| 前端全量 | 38 文件 / 275 用例 |

r11.8 增补：
- `/stats/work-order-durations`：派单响应、到场、到场→开工、处理、端到端的 P50/P90；只统计两个端点都存在的单，空部门返回 `null` 而非 0；
- 过程挖掘 `department_id` / `department_unassigned` 同时作用于事件主查询、学习命中数和自动派发数；
- `department_id` / `department_unassigned` 参数解析收口到 `routes/departmentScope.ts`，统计与挖掘共用互斥契约；
- SLA 到期前 30 分钟预警：`ticket_event(type='sla_warning')` 幂等去重，通知 assignee + admin/operator/dispatcher；
- 超时升级收件人从 admin 扩展到 admin/operator/dispatcher，统一走 `activeSlaStaff`；
- 数据大屏新增阶段时长面板与电视墙模式（总览/风险/人员三屏，20s 轮播，可手动切屏）；
- 主域名 `/pilot/api`、`/pilot/uploads`、`/pilot/health*` 由 `127.0.0.1:4101`（隔离 pilot 库）切到 `127.0.0.1:4001`（主库），nginx 变更前备份随 release 目录归档为 `nginx-youfu.banerz.cn.conf.bak`；
- 主站小程序 5.9.37：`wx.getLocation` 已开通，补齐 `wx.chooseLocation` 的 `requiredPrivateInfos` 声明；审核提交单见 `docs/mp-5.9.37-review-20261123.md`。

live 复核（2026-11-23）：
- `/stats/work-order-durations` 200；`sample.total=6`、`total.p50=19min`、`total.p90=68min`；
- `/process-mining` 全租户 9 case；按部门 6 case，`scope.department_id` 正确回显；
- `/pilot/api/v1/stats/workbench` 经主域名返回 200（total=6、timeout=1），证明 5.9.35 正式链路已接回主后端；
- 后端 scheduler 启动无报错。

## 16. 约束

- `release-manifest.json` / `release-baseline.json` 是可复现发布 artifact，不进入源码库；
- `release-baseline.mjs` 默认 fail-closed：commit 缺失或工作树不干净直接退出 1；
- 发布目录保留 manifest、baseline、CI 元数据，`/opt/youfu/releases/current` 指向当前发布。
