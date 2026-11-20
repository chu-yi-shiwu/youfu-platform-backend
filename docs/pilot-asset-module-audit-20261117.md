# 资产管理模块功能测试与缺失修复报告（2026-11-17，2026-11-20 增补）

> 范围：pilot `zixing-hospital` 真实租户只读 + `uat-asset-*` 隔离租户写测试；主站 `demo_tenant` 同口径复测。
> 原则：真实 pilot 数据不被修改；所有写操作落隔离租户，测试结束清理；不物理删除资产。

## 1. 结论

- 资产模块已形成 **部署 → 建档 → 业务（调拨/报障/维保）→ 回写 → 运营（时间线/提醒/统计/批量/附件）** 的完整闭环。
- **pilot 38/38 项 live 功能检查全部通过**；**主站 38/38 全部通过**。
- 后端全量测试 **2565/2565 通过**；前端单测 **265/265 通过**；小程序单测 **38/38 通过**；资产专项契约测试 **33 项**通过。
- 本轮不包含真机小程序验证；小程序端仅确认复用既有 API 契约。

## 2. 本轮根治的关键问题

### 2.1 二维码/扫码不是同一事实源（P1）

- 根因：建档写入 `ASSET:<uuid>`，扫码只解析 `AST-` 且查已废弃的 `asset_registry`；pilot 的 `asset_registry` 为 0 行，资产必然扫不出来。
- 修复：二维码统一为 `AST-<asset_no>`；`/scan` 改查 `asset` 表；兼容旧 `ASSET-<asset_no>`、`ASSET:<uuid>` 与直接扫资产编号。
- 额外根因：资产号本身以 `ASSET-` 开头，旧兼容分支错误截断前缀。现按完整 token 查询，并允许剥离一层 `ASSET-` 兼容旧码。
- 证据：pilot/主站 `扫码解析资产二维码`、`扫码解析资产编号` 均 PASS；UI 资产详情二维码为 `AST-ZX-ASSET-001`。

### 2.2 资产无法退出、只能停用（P1）

- 根因：只有 `disabled`，没有处置语义和处置留痕，物理 DELETE 也不存在。
- 修复：新增 `POST /assets/:id/dispose`，记录原因/方式/残值/操作人/时间；状态机增加 `disposed`；重复处置 409；维修中禁止报废。
- 产品口径：**不做物理删除**，`DELETE /assets/:id` 保持 404，由处置替代，保留审计链。
- 证据：`资产报废处置`、`重复报废被拒`、`资产不物理删除（处置替代）` 均 PASS。

### 2.3 维修完成/取消后资产永久停在维修中（P1）

- 根因：报障把资产置 `repairing`，工单侧没有任何反向联动。
- 修复：工单完成、取消、关闭时恢复资产为 `in_use`；并增加“无其它活跃关联工单”条件，避免并行维修被误恢复。
- 额外修复：`text = uuid` 类型错误改为显式 `::uuid` / `::text[]`。
- 证据：pilot/主站 `取消报障工单后资产状态回写`、`完成维修工单后资产恢复 in_use` 均 PASS。

### 2.4 导入回执成功但数据未落库（P1/P2，隐藏严重缺陷）

- 根因：逐行 `try/catch` 与整批共用一个事务；某行唯一键冲突后 PostgreSQL 事务进入 aborted 状态，最后 `COMMIT` 实际变为 `ROLLBACK`，接口却返回 `inserted > 0`。
- 修复：新增共享 `withRowSavepoint`，资产/设备/耗材导入逐行 SAVEPOINT，失败只回滚该行，成功行照常提交。
- 证据：新增负控制测试“单行冲突只回滚该行，成功行仍提交”；live `导入 CSV（含重复资产编号）` 后同编号可查到 1 条，`导入资产自动生成二维码` PASS。

### 2.5 资产历史只有工单，没有运营时间线（P2）

- 根因：历史接口只读 `linked_order_ids`，调拨/状态变更/维保/报废事件没有出口。
- 修复：复用 `domain_event` 作为唯一事实源，补齐建档/编辑/状态变更/维保/附件/导入事件；历史接口合并“工单 + 事件”并按时间倒序返回，保留 `id` 与 `order_id` 双字段兼容。
- 证据：`资产历史包含调拨/状态变更事件` 返回 9 条（报障、调拨、状态变更等）；UI 新增「动态时间线」页签。

### 2.6 维保无计划、无保修、无提醒（P2）

- 根因：`asset_maintenance` 只有已发生记录，资产表没有保修字段。
- 修复：资产增加 `responsible_user/department/warranty_until/warranty_vendor/useful_life_months`；维保增加 `next_due`；新增 `GET /assets/reminders` 返回 30 天保修/维保到期项。
- 证据：`责任人/部门/保修/折旧字段回读`、`维保计划/到期提醒/保修期` 均 PASS；UI 顶部展示到期提醒。

### 2.7 导出缺运营字段、导入缺二维码（P2）

- 修复：导出增加责任人、部门、保修截止、保修方、折旧年限；导入自动生成 `AST-<asset_no>`。
- 证据：`导出含责任人/部门/保修期`、`导入资产自动生成二维码` 均 PASS。

### 2.8 日期契约被序列化成时间戳（P2）

- 根因：pg 默认把 DATE 解析为 Date 对象，JSON 输出成带时区的 ISO 时间，日期字段出现“前一天/偏移”。
- 修复：进程级 `DATE(OID=1082) → YYYY-MM-DD` 字符串，统一资产/维保/导出日期口径。
- 证据：`warranty_until` live 返回 `2026-11-22`；导出与前端日期展示无偏移。

### 2.9 P3 运营能力补齐

- 附件：`asset_attachment` 元数据表 + 租户 RLS；新增附件上传/列表/删除端点，文件本体复用 `/upload` 与鉴权 `/uploads`。
- 统计/折旧：`GET /assets/stats` 返回状态分布、部门/分类汇总、直线折旧（仅对配置了金额/购置日期/年限的资产计算，不虚构数据）。
- 批量：`POST /assets/batch` 支持批量更新字段与批量报废；已处置/维修中按规则跳过并返回原因。
- 证据：`资产统计与折旧`、`资产附件上传/列表/删除`、`资产批量操作（跳过已处置）` 均 PASS。

### 2.10 第二轮体验与运营补齐（6 项）

1. **资产维修记录与工单互通**
   - 资产详情新增「维修记录」页签，直接列出关联维修工单（工单号/状态/报障时间/完成时间），可跳转工单详情。
   - 工单详情新增「关联资产」，可反向跳回资产详情；事实源仍为 `asset.linked_order_ids`，不新增重复外键列。
2. **资产标签二维码可下载**
   - 打印标签弹窗新增「下载二维码」，导出 `AST-<asset_no>-qr.png`，与打印内容同源。
3. **重置按钮无效**
   - 根因：只重置了表单状态，没有按空条件重新请求，且 URL 上的 `keyword` 未清除。
   - 修复：重置同时清空筛选、清空 URL 查询参数并按空条件重新加载列表。
4. **30 天到期提醒可点击、可忽略**
   - 提醒项点击直达资产详情（维保提醒直达「维保记录」页签）。
   - 新增 `asset_reminder_dismissal` 表与 `POST /assets/reminders/dismiss`，忽略动作租户内持久化、保留操作人/时间；提醒查询自动排除已忽略项。
5. **单资产折旧净值**
   - 新增 `GET /assets/:id` 返回单资产折旧：月折旧、累计折旧、已计提月数、折旧后净值。
   - 折旧公式抽到共享服务 `assetDepreciation.ts`，统计接口与详情接口同口径；未配置金额/日期/年限时返回 null，不伪造 0 净值。
6. **导入模板下载**
   - 新增 `GET /assets/import-template`，服务端生成带 BOM 的 CSV 模板（表头 + 示例行），前端新增「下载导入模板」按钮，避免用户手写表头导致导入失败。

## 3. Live 功能检查结果（两环境均 38/38）

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | 创建资产（全字段） | PASS |
| 2 | 自动生成资产编号/二维码 | PASS |
| 3 | 责任人/部门/保修/折旧字段回读 | PASS |
| 4 | 按名称/拼音/位置/状态/资产号/二维码查询 | PASS |
| 5 | 编辑资产（位置/状态/金额） | PASS |
| 6 | 停用资产（disabled） | PASS |
| 7 | 资产不物理删除（处置替代） | PASS |
| 8 | 资产报废处置（原因/方式/残值） | PASS |
| 9 | 重复报废被拒 | PASS |
| 10 | 调拨资产（仅 location） | PASS |
| 11 | 资产报障生成工单 | PASS |
| 12 | 报障后资产状态=repairing | PASS |
| 13 | 资产历史返回关联工单 | PASS |
| 14 | 资产历史包含调拨/状态变更事件 | PASS |
| 15 | 取消报障工单后资产状态回写 | PASS |
| 16 | 完成维修工单后资产恢复 in_use | PASS |
| 17 | 维保记录新增/列表/编辑/删除 | PASS |
| 18 | 维保计划/到期提醒/保修期 | PASS |
| 19 | 导出 CSV | PASS |
| 20 | 导出含责任人/部门/保修期 | PASS |
| 21 | 导入 CSV（含重复资产编号） | PASS |
| 22 | 资产编号唯一性校验 | PASS |
| 23 | 导入资产自动生成二维码 | PASS |
| 24 | 资产统计与折旧 | PASS |
| 25 | 资产附件上传/列表/删除 | PASS |
| 26 | 资产批量操作（跳过已处置） | PASS |
| 27 | worker 可读资产（扫码） | PASS |
| 28 | worker 不可建档/报障/导出 | PASS |
| 29 | 扫码解析资产二维码 | PASS |
| 30 | 扫码解析资产编号 | PASS |
| 31 | 单资产折旧净值 | PASS |
| 32 | 工单详情回指关联资产 | PASS |
| 33 | 到期提醒可忽略/查询/恢复 | PASS |
| 34 | 导入模板可下载 | PASS |
| 35 | 附件拒绝跨租户外链 | PASS |
| 36 | 处置撤销审批（禁止自审） | PASS |
| 37 | 资产报障流程配置预检 | PASS |
| 38 | 小程序公开扫码路径 | PASS |

执行命令：

```bash
# pilot
cd /opt/youfu/pilot/backend && ENV_FILE=.env E2E_RUN_ID=asset15 \
  /opt/node16/bin/node scripts/pilot-asset-functional-audit.mjs

# 主站
cd /opt/youfu/backend && ENV_FILE=.env PILOT_API_BASE=http://127.0.0.1:4001/api/v1 \
  PGDATABASE=youfu SOURCE_TENANT=demo_tenant UPLOAD_DIR=/opt/youfu/uploads \
  E2E_RUN_ID=mainasset6 /opt/node16/bin/node scripts/pilot-asset-functional-audit.mjs
```

## 4. 自动化测试与部署证据

- 后端全量：`npx vitest run` → **216 文件 / 2565 用例全部通过**。
- 前端全量：`npx vitest run` → **35 文件 / 265 用例全部通过**；`tsc -b` 0 错误。
- 本轮新增/更新专项测试：
  - `src/test/assetLifecycleP2.http.test.ts`：24 项（字段、事件、时间线、提醒忽略/恢复、统计与单资产折旧、批量、附件扫描/外链拒绝、处置撤销审批、流程预检、导入 SAVEPOINT、导入模板）。
  - `src/test/assetOpsRules.test.ts`：9 项（处置撤销窗口/方式、流程可达性、上传类型策略）。
  - 小程序：`youfu_mp` / `youfu_mp_pilot` 各 **38/38** 通过。
  - `src/test/scan.test.ts`：10 项（AST-/ASSET-/ASSET: 解析、DB 命中、未命中负控制）。
  - `assetStatsAiChat` / `workOrderTransitionWorkerScope`：资产 HTTP 与回写回归共 44 项。
- 迁移：`121_asset_qr_lifecycle.sql`、`122_asset_disposed_status.sql`、`123_asset_lifecycle_p2.sql`、`124_asset_reminder_dismissal.sql`、`125_asset_reversal_and_attachment_scan.sql` 已应用并登记到 `youfu_pilot` 与 `youfu` 的 `_migrations`。
- OpenAPI：已用 `tools/generate_openapi.mjs` 重新生成 `docs/openapi.json`，覆盖新增资产端点（处置/提醒/统计/批量/附件/单资产详情/导入模板），端点总数 361，机器门通过。
- 部署：后端 pilot(4101)/主站(4001) 均 `active`，`/health/ready` 返回 `{"ok":true,"status":"ready","db":"up"}`；前端主站 `assets/index-D1PCqsbu.js`，pilot `assets/index-CAT31ApY.js`。
- 发布闸门：迁移命名/SQL 注入/迁移幂等/RLS 策略/SQL 列契约 **5/5 通过**（132 个迁移、85 张租户表）。
- UI 冒烟：pilot 资产页正常渲染统计条、责任人/部门列、维修记录/时间线/维保/附件页签、批量入口；已实测二维码下载 PNG、重置重新加载、提醒点击直达资产、详情折旧净值、导入模板下载，无控制台错误；工单详情可反向跳转资产。
- 清理：两库 `uat-%` 租户与 `uat-%` 资产均为 **0**；pilot uploads 仅有真实租户目录。

## 5. 2026-11-20 第二轮增补（已落地）

1. **提醒恢复**：新增已忽略提醒列表与恢复接口，恢复保留 `restored_at/restored_by`，不再靠删表恢复。
2. **处置撤销审批**：新增 `asset_disposal_reversal` 审批表；申请需 `asset.manage`，审批需管理员且禁止自审；仅 30 天内、未变卖/捐赠的处置可撤销；资产恢复 `in_use` 并保留撤销原因/操作人/时间。
3. **附件安全与预览**：附件 URL 必须指向本租户 `/uploads` 真实文件，拒绝外链/跨租户；服务端统一推导 MIME 与大小；图片/PDF 支持预览；扫描状态落库（unscanned/clean/infected/error），支持 `ASSET_AV_CMD` + `ASSET_AV_REQUIRED` 接入 ClamAV 兼容引擎，未配置时明确显示“未扫描”，不伪造已扫描。
4. **流程配置预检**：新增纯函数可达性分析 + `GET /assets/workflow-readiness` + `npm run preflight:asset-workflow`；检查取消/完成路径是否从初始状态可达，已对 pilot/主站全部 active 租户通过。
5. **小程序扫码路径**：`/public/scan` live 验证 `AST-<asset_no>` 可解析；小程序两套工程各 38 项单测通过。

## 6. 剩余边界与后续建议

1. **真机扫码**：本轮完成了小程序单测、后端公开扫码 live 验证，但微信开发者工具预览被“登录态过期”阻断，且没有可用真机；需人工扫码登录开发者工具后用预览二维码做一次 Android/iOS 真机回归；执行清单见 docs/asset-scan-device-checklist-20261120.md。
2. **病毒扫描引擎**：代码已支持 ClamAV 兼容命令与 fail-closed 开关，但生产服务器未安装 ClamAV；当前附件显示“未扫描”。安装引擎/云扫描后设置 `ASSET_AV_CMD`（必要时 `ASSET_AV_REQUIRED=true`）即可生效。
3. **处置撤销**：仅覆盖 30 天内、未变卖/捐赠的处置；已变卖/捐赠资产必须走线下回购/受赠并重新建档，这是有意的数据完整性约束。
4. **附件预览**：仅图片/PDF，不做 Office 全格式预览；如需在线编辑/缩略图服务，应独立立项。
5. **折旧**：直线法，且只对同时配置金额/购置日期/年限的资产计算；未配置资产不计提，避免伪造 0 净值。
6. **主站与 pilot 流程差异**：属于租户配置差异；预检已能发现取消/完成路径缺失，不再靠运行时猜。
