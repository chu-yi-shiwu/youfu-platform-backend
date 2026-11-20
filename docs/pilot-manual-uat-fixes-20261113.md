# 手动 UAT 反馈修复报告（2026-11-13）

本轮修复用户手动走查发现的 8 个问题，全部为根因修复，并补了对应测试。

## 1. 首页巡检计划显示 UUID

- 现象：工作台「巡检计划」栏显示 `00000000-0000-4000-8000-...`。
- 根因：`/inspection/plans` 返回字段是 `name`，前端只取了 `title / plan_name / id`。
- 修复：`Dashboard.tsx` 增加 `name`，并统一深链关键词。
- 测试：`Dashboard.test.tsx` mock 改为 `{ name: '巡检计划A' }`，仍通过。

## 2. 工单详情「处理详情」英文表头 + 暴露原始代码

- 现象：`inferred`、`retention`、`department_resolution` 英文；最后一行 JSON 暴露 id/code。
- 根因：
  - `EXT_LABEL` 缺这三个键；
  - `formatExtValue` 对 `department_resolution` 走通用对象分支，`JSON.stringify` 嵌套对象。
- 修复：
  - `EXT_LABEL` 增加「AI 识别结果 / 留存策略 / 责任部门解析」；
  - `formatExtValue` 增加 `department_resolution` 专用格式化：来源/分类/位置/业务类型；
  - 通用嵌套对象优先取 `name/label`，过滤 `id/code/tenant_id`，不再 JSON dump。
- 测试：`labels.test.ts` 断言不包含 `hosp_ac`、不包含 `{`。

## 3. 审计轨迹节点英文

- 现象：`transition`、`system`、`admin`、`auto_dispatch`、`assign` 裸英文。
- 根因：
  - `EVENT_LABEL` 缺 `transition`；
  - `TO_LABEL` 缺 `assign`；
  - `actor` 直接渲染，没有中文映射。
- 修复：
  - 增加 `transition: 状态流转`、`assign: 派单`；
  - 新增 `ACTOR_LABEL / actorLabel()`：system→系统、admin→管理员、worker→师傅、auto_dispatch→自动派单等；
  - 详情时间线与打印视图统一走 `actorLabel`。
- 测试：`labels.test.ts` 锁定三个映射。

## 4. 小程序志愿者报名后无签到/签退

- 现象：报名后按钮仅显示「已报名」，没有签到/签退。
- 根因：
  - 小程序没有「我的报名记录」数据源；
  - 后端 checkin/checkout 一律要求 `volunteer.audit`，工人无此权限；
  - 页面只有报名按钮。
- 修复：
  - 后端新增 `GET /volunteer/my-records`（只查本人 worker.name）；
  - checkin/checkout 增加本人放行：`record.user_name == worker.name`，非本人仍要求 `volunteer.audit`；
  - 小程序新增 `getMyVolunteerRecords`，按记录状态显示「签到 / 签退 / 已签退待认定 / 已认定」；
  - 增加签到/签退确认与失败提示。
- 测试：
  - 新增 `volunteerSelfService.http.test.ts`（本人 200、非本人 403、my-records 只返回本人）；
  - C7 业务链增加师傅自助签到/签退。

## 5. PC 志愿者：结束活动 / 活动详情 / 人员签到签退

- 现象：只有「关闭活动」和报名记录表，没有活动详情、没有现场签到/签退操作。
- 修复：
  - 按钮改为「结束活动」；
  - 「详情 / 签到」打开活动详情：标题、批次、地点、时间、名额、状态 + 报名记录；
  - 记录表增加现场操作：签到 / 签退 / 认定；
  - 发布活动表单补充字段标题。
- 测试：`VolunteerPage.test.tsx` 更新按钮文案后 241 用例全绿。

## 6/8. 资产、设备购置日期格式

- 现象：`2025-05-31T16:00:00.000Z`。
- 根因：表格/详情直接渲染原始字段。
- 修复：
  - 新增共享 `fmtDate()`（只输出本地日期）；
  - 资产列表、资产详情、维保记录、设备列表统一使用。
- 测试：`labels.test.ts` 新增 `fmtDate` 用例（不含 `T`）。

## 7. 资产新增维保等输入框缺标题

- 现象：维保弹窗只有 placeholder，没有字段标题。
- 修复：
  - `AssetPage` 新增 `FieldLabel`；
  - 新建/编辑资产、调拨、故障报修、新增/编辑维保全部改为「标题 + 输入框」；
  - 日期输入改为 `type=date`；
  - 志愿者发布活动表单同步补标题。
- 设备管理新建/编辑原本已有标题，未重复改。

## 8. 部署与验证

```text
后端：204 文件 / 2456 用例 PASS
前端：30 文件 / 241 用例 PASS
PC Playwright：9/9 PASS
后端：youfu-pilot active，/health/ready 200
PC：frontend-dist-path 已更新（assets/index-EjJynb_i.js）
小程序：v5.9.20 预览码已生成
真实接口：GET /volunteer/my-records 返回 liu- 的 2 条报名记录
数据：4 工单 / 14 通知 / 3 账号 / 16 师傅；临时租户 0
```

## 9. 复测入口

```text
PC：https://youfu.banerz.cn/pilot/
小程序：预览码（v5.9.20）
账号：17773639019 / HQ016
```

建议重点复测：

1. 工作台巡检计划显示名称；
2. 工单详情处理详情/审计轨迹全中文；
3. 资产详情购置日期、维保弹窗标题；
4. 设备列表购置日期；
5. 小程序志愿者报名后签到/签退；
6. PC 志愿者「详情 / 签到」「结束活动」。
