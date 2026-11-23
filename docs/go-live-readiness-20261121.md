# 正式上线就绪清单（2026-11-21）

## 1. 当前已完成

| 项 | 状态 |
| --- | --- |
| 后端发布 | r11.8，当前 `/opt/youfu/releases/20261123T034529-fc99b6726f9e` |
| 后端 CI | run `45107645347`，success |
| 主站前端 | 已部署，index asset `assets/index-zx6sjUbH.js`；commit `b053a73` |
| PC pilot 前端 | 已部署，index asset `assets/index-CJoZdUDz.js` |
| H5 | 已部署，index asset `assets/index-CWohyopO.js`；commit `130bb2b`；worker/admin 双契约 |
| pilot 小程序 | 5.9.35 开发版；manifest digest `da6a309a0572...`；44 / 44 |
| 主站小程序 | 5.9.38 开发版；manifest digest `446680a5240f...`；42 / 42 |
| live 边界烟测 | uat 租户 PASS，测后清理；真实租户只读复核 PASS |
| live 角色边界 | worker admin/events/dispatch-recommend 均 403；worker open 200；admin 200 |
| 数据大屏 | r11.8；部门筛选、今日/超时/积压 KPI、需要关注 Top5、SLA 老化、师傅负载 Top5、阶段时长 P50/P90、电视墙三屏轮播、部门过程挖掘、下钻；timeout 与 overdue 已统一为 1 |
| 生产租户迁移 | `zixing-hospital` 已迁移到主库（75 表 / 463 行，媒体 6 文件） |
| 主库生产租户口径 | workbench audit PASS：active=1 done=6 today_done=1 today_new=0；重复 worker PASS |
| 工作台统计/重复 worker | 主站 + pilot PASS |

## 2. 上线阻塞项

### 2.1 正式生产租户已迁移并完成切换

产品已确定采用“迁移到主库正式租户”。2026-11-21 已完成一次受控迁移：

- 源：`youfu_pilot` / `zixing-hospital`（资兴市人民医院）
- 目标：`youfu` / `zixing-hospital`
- 搬迁 75 张业务表、463 行；跳过 AI/推理日志/幂等缓存 10 张表
- 关键校验：tenant=1、dept=1、accounts=3、workers=16、workOrders=6
- 业务外键校验 10 项全部 0 异常
- 6 个媒体文件已复制到 `/opt/youfu/uploads/zixing-hospital`，sha256 一致
- 处理了 `t-verification` 与生产租户重复 openid：清除测试租户重复绑定，回滚 SQL 存在迁移备份目录
- 主库 API 烟测：admin 列表 200（total=6）、`/stats/workbench` 200、worker 列表 200、`/open/me/summary` 200
- 发现并修复陪检单 `escort-*` 非 UUID 详情 400：资产关联查询改为 text 比较，r11.2 已部署，详情 200

最终切换已于 2026-11-21 23:10 完成：

1. `youfu-pilot.service` 已停止，pilot 写入冻结；
2. 使用 `--replace` 对主库做最后一次重放：75 表 / 463 行，校验 tenant=1、dept=1、accounts=3、workers=16、workOrders=6；
3. 主库 API 复核：admin total=6、stats total=6、worker total=5、me/summary active=1 done=6；
4. 陪检单 `escort-*` 详情 200；
5. 工作台统计对账 PASS；重复 worker PASS；
6. 主库为唯一写入源，`youfu-pilot.service` 已停；主域名 `/pilot/api` 已改由主后端 `127.0.0.1:4001` 处理，5.9.35 正式小程序链路恢复读取主库，避免双写；隔离域名 `pilot.banerz.cn` 仍停。

切换回滚：主库备份 `/opt/youfu/backups/cutover-20261121T231057/youfu.dump`；如需回退，恢复主库并重启 `youfu-pilot.service`。

### 2.2 主站小程序仍是旧生产包

- 线上生产包仍为 5.9.10，不包含本次 `/admin/work-orders` 契约。
- 主站 5.9.38 已上传开发版；`wx.getLocation` 接口权限已于 2026-11-23 显示“已开通”，仅用于巡检签到/运送轨迹。
- 主站 5.9.38 尚未发布；但主域名 `/pilot/api` 已恢复到主后端，5.9.35 正式链路可继续使用主库（live 复核 200，total=6、timeout=1）。5.9.38 仍需尽快过审。
- 实际工作单建单页没有地图选点，`wx.chooseLocation` 只存在于未走到的通用表单组件；5.9.38 已删除该调用和 `app.json` 声明，地点字段改为手输/字典，不再申请 `chooseLocation` 接口权限。
- 5.9.36 / 5.9.37 不再提交；5.9.38 的 `requiredPrivateInfos` 仅保留 `getLocation`，审核不应再弹 `wx.chooseLocation` 无权限。
- 审核提交需在微信后台页面操作（普通小程序不能调用 `wxa/submit_audit`，接口返回 `86000 should be called only from third party`）；提交材料与说明见 `docs/mp-5.9.38-review-20261123.md`。
- 若正式环境已有 5.9.10 用户，后端升级后旧包管理端会 403；必须尽快发布 5.9.38 或确认无旧版在线用户。
- pilot 与主站共用 appid `wxb99197ac59cfa519`，同一 app 的体验版/正式版互斥；当前应把 5.9.38 提交审核并发布，不再回到 pilot 包。

### 2.3 真实员工绑定与订阅不足

绑定审计（`account_user.wx_openid`）：

| 租户 | 账号数 | 已绑定微信 | 师傅档案 |
| --- | --- | --- | --- |
| `t-verification` | 24 | 1 | 12 |
| `zixing-hospital`（主库） | 3 | 1 | 16 |
| `t-phasea` | 6 | 0 | 4 |

主库生产租户关键角色绑定：admin 0/1、operator 0/1、worker 1/1。管理员/运营未绑定，管理侧通知无法真实送达。`t-verification` 原 2 个绑定中 1 个与生产 worker 是同一 openid，迁移时已清除测试租户重复绑定。

注意：operator 渠道收口为“仅 PC”，当前小程序 operator 绑定入口不可达；若运营角色必须接微信通知，需要补 PC 扫码绑定或绑定专用页。admin 可通过小程序「我的」页绑定。

通知投递审计（`notification`）：

| 租户 | 渠道 | 成功 | 失败 | 最近失败 |
| --- | --- | --- | --- | --- |
| `t-verification` | wechat | 0 | 117 | 2026-10-29 |
| `zixing-hospital` | wechat | 1 | 10 | 2026-11-21 12:39 |

需要完成：关键角色绑定、订阅模板授权、一次真实发送回执验证。

配置侧已确认：主站与 pilot 的 `MP_APPID`、`MP_APPSECRET`、`WX_MP_TEMPLATE_ID` 均已设置；pilot 存在 1 条真实 delivered=true 记录，说明微信发送链路本身可用。当前失败主要是接收人未绑定 openid 或未订阅模板，不是网关配置缺失。

### 2.4 管理面角色边界

r11.3 已补：`/admin/work-orders/*` 除模块门禁外增加管理角色门禁。worker 访问管理列表/事件/派单推荐均 403；worker 建单人催办保留在 `/open/work_order/:id/urge`。H5 代报修/详情按角色选择 `/open` 或 `/admin`，避免 worker 被管理门禁误伤。

### 2.5 发布流程闭环

- 前端 CI 在线状态无法匿名确认（私有仓库 API 404）；本地 36 文件 / 269 用例、typecheck、lint、build 均通过。
- 本次后端部署使用同 commit 本地构建；CI artifact 已生成并记录 digest，但未直接下载 artifact 部署。若制度要求“artifact 即部署物”，需补下载/重放。
- 主站小程序 release manifest 已补；pilot/main 上传记录、二维码、digest 已归档到 release 目录。
- 迁移前已备份 `youfu` / `youfu_pilot`（`/opt/youfu/backups/migration-20261121T224914`）。
- 正式上线前做一次回滚演练：切 `releases/current`、恢复备份 dist、重启、健康检查；数据回滚优先恢复迁移前数据库备份。
- Live 边界复跑：`ENV_FILE=.env AUDIT_TENANT=zixing-hospital npm run smoke:workorder-boundary`（只读，验证 admin/worker open/admin/events/dispatch 边界）。

## 3. 上线顺序建议

1. ✅ 已冻结 pilot 写入，完成最后一次 `--replace` 重放并复核。
2. `wx.getLocation` 已开通；5.9.38 已移除未使用的 `chooseLocation`，直接在「版本管理 → 开发版本 → 5.9.38 → 提交审核」，不再申请接口权限。
3. 完成关键角色微信绑定/订阅，验证真实通知回执。
4. 5.9.38 审核通过后发布正式版。
5. 前端 CI/artifact/回滚确认。
6. 生产烟测：admin 200、worker 200、模块关闭 403、通知真实回执。
7. 灰度/正式放量。

## 4. 可上线后跟进

- 通知模板文案优化、更多事件订阅。
- 历史 probe/demo 租户清理。
- 性能压测与容量评估。
- 统计报表细化。
