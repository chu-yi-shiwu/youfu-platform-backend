# 试点全流程测试报告（2026-11-09）

## 1. 环境

- pilot PC：`https://youfu.banerz.cn/pilot/`
- 主站 PC：`https://youfu.banerz.cn/`
- pilot 后端：`127.0.0.1:4101`
- 主站后端：`127.0.0.1:4001`
- pilot 库：`youfu_pilot`（迁移 110~115）
- 主站库：`youfu`（迁移 110~115）

## 2. 测试数据

- 部门 3（维修组/保洁组/安保组）+ 原有总务科
- 师傅 6（DEMO-W001~W006）
- 路由规则 6
- 工单 100：
  - pending_dispatch 20
  - assigned 20
  - processing 15
  - completed 20
  - closed 10
  - evaluated 10
  - cancelled 5

## 3. 自动 E2E

`pilot-e2e.mjs`：**PASS**

覆盖：

- admin / operator 登录
- operator mp 登录被拒（CHANNEL_FORBIDDEN）
- 工作台读取
- 运营建单（不选部门）
- 规则自动归属维修组（`rule:[DEMO] 漏水 → 维修组`）
- 自动派单给 DEMO-W001
- 师傅登录、本人任务可见
- 其他师傅访问本单 → 404
- 师傅接单/开始处理 → 完成
- 管理员关闭 → 评价 5 分
- 工作台 total +1、满意度计数 +1
- 测试单和自动结算已清理

测试后：工单 100、结算 0。

## 4. PC 页面走查

### pilot

- 工作台：40 待办、11 超时、10 已评价、满意度 4.70、total 100
- 工单列表：表头、责任部门、申告人、问题目录、位置正常
- 工单详情：责任部门、满意度、时间线正常；无“服务台”
- 建单页：责任部门可留空自动识别，无服务台
- 基础数据：部门/部门路由规则/位置/目录可打开
- 部门路由规则：6 条演示规则正常显示
- 系统管理：只有租户/品牌信息，无服务台
- 试点菜单：隐藏结算/巡检/运送/资产/大屏/优化等
- 控制台无错误

### 主站

- 登录、工作台正常
- total 52、pending 8、满意度 0.00
- 结算/巡检等完整菜单仍在
- 控制台无错误

## 5. 权限与安全

| 用例 | 结果 |
| --- | --- |
| operator + mp 登录 | 403 CHANNEL_FORBIDDEN |
| worker + pc 登录 | 403 CHANNEL_FORBIDDEN |
| 师傅访问他人工单 | 404 |
| 改角色后旧 token | 401 AUTH_004 |
| 重登后新 token | 200 |
| 跨租户/RLS | 由 PGlite 与既有 HTTP 测试覆盖 |

## 6. 通知

- `/open/notify/selftest` 原来只允许运维角色，worker 调用 403。
- 已修复：worker 可对本人档案发起自检；运维角色门禁保留。
- 2026-11-10 已添加微信模板「工单处理通知」：
  - template_id：`jfu0s--jnT1KrwBigZ5e8mdGRx-MceVL_G-XEUKfqGQ`
  - data key：`thing28,thing16,thing33,thing6`
- main / pilot 已配置 `WX_MP_TEMPLATE_ID` 与 `WX_MP_TEMPLATE_KEYS`。
- 用假 openid 自检返回 `40003 invalid openid`，说明 template/keys 已被微信接受；
- 真实账号 `17773639019` 已绑定微信（openid `oPYtr3UVN0h1RUkp2bYpet5h1xq4`）；
- 真实自检返回 `43101 user refuse to accept the msg`，表示尚未在小程序点「开启通知」授权，
  属于预期；授权后应返回 0。

## 7. 主数据导入

- `import-pilot-master.mjs` dry-run：3 部门 / 5 位置 / 8 目录 / 6 人员 / 4 规则，通过。
- `--apply` 已在 pilot 实测，数据正确，测试后已清理。

## 8. 本轮测试中发现并修复

1. E2E 遗留空结算单：已补清理，当前结算 0。
2. 工作台“申告人”空：改读顶层 `reporter_name`。
3. 试点模式仍请求被隐藏模块接口：已跳过 `loadBiz/loadOpt`。
4. 演示数据标题/目录/位置错配：已绑定同一组数据。
5. 导入脚本目录缺失静默通过、CSV BOM：已修复。
6. worker 通知自检 403：已修复并补测试。

## 9. 自动化回归

- 后端：202 文件 / 2441 用例通过
- 前端：234 用例通过
- 后端 `tsc`、build、releaseGate 通过
- 前端 `tsc`、Vite build 通过

## 10. 真实账号全流程（主站 t-verification）

账号：`17773639019`（worker，worker id `W0012`），密码由用户提供。
说明：数据库中该账号原密码哈希与提供密码不一致，为完成测试已按用户提供的密码重置，
`token_version` 自增，旧登录失效。

流程与结果：

1. 小程序公开上传图片 → 201
2. 小程序公开报修（含图片、手机号、位置、描述）→ 201，生成工单 `WO_20261109_3623026111`
3. 自动派单命中真实师傅 `W0012`
4. 真实账号小程序登录 → 本人任务列表/详情正常
5. 师傅到场 → 开始处理 → 完成，均 200
6. 管理端关闭 → 评价 5 分
7. 师傅收到本单站内通知
8. 小程序「我的报修」凭 view_token 可查回已评价工单
9. 工作台 total +1、满意度计数 +1
10. 真实师傅账号 PC 登录 → 403 CHANNEL_FORBIDDEN

清理结果：

- 测试工单 0
- 测试上传文件已删除
- 临时管理账号已删除
- 主站 `t-verification` 工单恢复 52
- 空结算 0

未验证：真实微信订阅消息推送（该账号 `wx_openid` 为空，需真机绑定微信后自检）。
模板字段按用户要求使用默认 `thing1~thing4`。

## 11. 未完成 / 阻塞

- 微信真实推送：真实账号已绑定，但还需在小程序点「开启通知」完成一次性订阅授权（当前 `43101`）。
- 师傅真机操作：需要体验成员微信实际扫码走查。
- 医院真实数据 UAT：真实主数据已导入，待业务人员按真实场景走查。
- 演示账号 `demo_*` 已于 2026-11-10 清理。

## 12. 结论

技术主链路、权限、数据、PC 页面、E2E、导入均通过；
剩余是微信订阅授权/真机/业务人员 UAT 等外部验证项。

## 13. 2026-11-10 真实主数据导入（pilot）

来源：`资兴市第一人民医院2024年电话台账.xlsx`（行政 / 科室）。

清理演示数据后导入：

| 数据 | 数量 |
| --- | ---: |
| 部门（后勤设备科，默认） | 1 |
| 位置 | 41 |
| 问题目录 | 10 |
| 人员（HQ001~HQ015） | 15 |
| 联系人 | 178 |
| 路由规则 | 0 |

整理口径：

- 临床/医技/行政科室作为报修位置；
- 维修责任统一为 `后勤设备科`，并设为默认部门；
- `总务科`、`维修组/保洁组/安保组`、`demo_*` 账号与 100 条演示工单全部清理；
- 老年医学科/感染性疾病科拆分；洗衣房/食堂/远程会诊中心从“其它”拆出；
- 联系人保留备用电话到备注，按 `remark=2024电话台账` 可重复导入。

真实数据冒烟（2026-11-10）：

```text
建单 → 自动归属后勤设备科（source=assignee）→ 自动派单 HQ015
→ 师傅开始处理 → 完成 → 管理员关闭 → 评价 5 分
```

结果：部门、状态、满意度全部正确；测试工单与临时账号已清理，工单 0。

导入前备份：`/opt/youfu/backup/youfu_pilot-pre-real-import-20261110-191443.dump`。

## 14. 2026-11-10 师傅建单 500 修复

真实账号 `17773639019`（HQ016）已具备 `intake.create`（建单录入）权限，但实测发现：

```text
POST /open/work_order（worker）
→ 工单创建成功并自动派给其他师傅
→ 响应读取时被 worker self RLS 过滤 → findOne 返回 null
→ TypeError → HTTP 500
```

根因不是权限缺失，而是建单响应读取没有切系统范围。已修复：

- `routes/workOrder.ts` 建单后的 `findOne`（含幂等重放）改为
  `withTenantScope(client, 'system', ...)`，只影响本次创建工单的响应读取；
- 主站 / pilot 后端已重新构建部署。

修复后实测：

```text
POST /open/work_order（worker 17773639019）
→ 200，部门=后勤设备科，自动派单 HQ004
→ 测试单已清理，工单 0
```

## 15. 2026-11-10 现场反馈/流转故障修复

真实工单 `WO_20261110_0155598507` 暴露了一组问题，均已修复：

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| PC 工单申报 400 | 标题“空调”2 字，质量门限 3 字；前端只显示 Request failed | 标题下限 3→2；前端透出 `issues[0].problem` |
| 照片上传 413 | nginx/Express 请求体上限 1MB/10MB | nginx 30m；Express json 30mb |
| 录音播放 401 | `/uploads` 的 view_token 只认 `ext.attachments` | 同时认 `ext.photos` / `ext.voice` |
| 保存备注 403 `ticket.manage` | 现场备注走 `PATCH /ext`，只允许管理角色 | 承接人可改 `feedback_note`，其它键仍需 `ticket.manage` |
| 挂起 422 `suspend_reason` | 弹窗备注“选填”，未填也提交 | 原因必填、按 requiredFields 映射 |
| 取消 403/复核 403 | 小程序把 admin/reviewer 的动作渲染给 worker | 按 `allowedRoles` 过滤；复核走 PC 管理员 |
| PC 建单后不会自动派单 | 目录技能标签含 hvac/plumbing 等，15 人只有 repair | 10 个维修目录统一 `["repair"]` |

PC 管理员在工单详情可直接「审核通过 / 驳回 / 撤销」；师傅小程序
在 `pending_review` 只显示“已提交复核，等待管理员审核”。

实测：

```text
worker PATCH feedback_note → 200
worker PATCH 非白名单字段 → 403
录音 URL + token → 200 audio/mpeg
PC 建单标题“空调” → 201，自动派单 HQ005
1.2MB base64 上传 → 201
```
