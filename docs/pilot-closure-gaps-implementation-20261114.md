# 方向 A「业务闭环补齐」实施记录（2026-11-14）

> 依据：`docs/pilot-usability-gap-audit-20261114.md`，用户选择方向 A，并确认：
> 基础数据删除改「停用优先」、结算作废需原因+作废人留痕；巡更在场校验选「只做扫码」（归入方向 B，未在本轮实施）。

## 1. 本轮完成项

| # | 缺口 | 修复 |
| --- | --- | --- |
| 1 | 结算确认后无法作废 | PC 列表/详情接入作废：原因必填、不可逆提示、作废人/时间/原因留痕、`voided` 筛选；作废单禁止导出 |
| 2 | 耗材无退库入口 | PC 库存台账新增「退库」：选/填工单号 + 数量，调用 `/inventory/return`（净消耗校验由后端保证）；顺带修复库存 Tab 首次进入不加载 |
| 3 | 资产维修状态不回写 | 工单进入完成态时，按 `linked_order_ids` 把关联的 `repairing` 资产恢复 `in_use`，并写 `asset_repair_done` 事件 |
| 4 | 设备保养有接口无界面 | 设备行新增「保养」：台账列表、逾期高亮、新增/编辑/删除（`equipment.manage`） |
| 5 | PC 不能把预警转工单 | 预警行新增「转工单」，回显生成的工单号（兼容后端 `orderNo` 契约） |
| 6 | 反馈只能回复不能结案 | 新增关闭端点 + PC 关闭弹窗（说明可选）；关闭后禁止再回复（409），统计/导出/筛选支持 `closed` |
| 7 | 基础数据可直接删除造成历史失真 | 7 张字典表补 `enabled`，列表默认只返回启用项；PC 增加状态列、停用/启用、「显示已停用」开关；停用不影响历史单据解析 |

## 2. 迁移

`117_pilot_closure_gaps.sql`：

```text
dept / region / contact / supplier / equipment_type / equipment_brand / priority_dict
  + enabled boolean NOT NULL DEFAULT true
feedback
  + closed_at / closed_by / close_note
```

已在 pilot 库执行并核验 10 个列存在；脚本可重复执行（IF NOT EXISTS）。

## 3. 接口变化

```text
POST /api/v1/feedback/:id/close   { note? } → { item }；重复关闭 409；关闭后 reply 409
GET  /api/v1/basic-data/:type    ?include_disabled=1 才返回停用项
PUT  /api/v1/basic-data/:type/:id { enabled } 停用/启用
```

其余为既有接口接入（settlement void / inventory return / equipment maintenances / emergency convert）。
`docs/openapi.json` 已重新生成。

## 4. 验证

```text
后端全量        204 文件 / 2474 用例 PASS
前端全量        33 文件 / 257 用例 PASS
PC Playwright   10/10 PASS
线上隔离审计    18/18 PASS（uat-closure-<run>，审计后清理）
```

线上审计脚本：`scripts/pilot-closure-audit-e2e.mjs`，覆盖：

```text
基础数据停用：默认不可见 / include_disabled 可见 / 可重新启用
反馈关闭：closed + 留痕 / 重复关闭 409 / 关闭后回复 409
设备保养：新增 201 / 列表回读
应急转工单：生成工单
资产：报障 repairing → 工单完成 in_use
耗材：入库 5 → 挂单消耗 2 → 退库 1 = 4
结算：确认 200 → 作废 voided + 原因 → 导出 409
```

审计后数据：UAT 租户/业务行全部清理；pilot 数据未新增测试数据。

## 5. 部署

```text
后端   dist 已替换并重启，/health/ready 200
PC     assets/index-CO0M_PWm.js（build:pilot）
迁移   117 已应用
```

## 6. 未纳入本轮（方向 B）

- 巡更点位扫码签到（用户已选「只做扫码」）：需要点位码生成、扫码端点、PC 打印点位码，归入方向 B。
- 巡检定位策略、巡检逾期状态/提醒：归入方向 B。
- 催办、通知深链、统计口径、低库存预警等：归入方向 C。

## 7. 残余风险

1. 结算作废不可逆，操作人需按财务制度使用；系统已强制原因与留痕，但没有二次审批。
2. 耗材退库依赖工单号准确；下拉只列已完成/关闭/已评价工单，其他状态需手工输入并由后端校验。
3. 资产回写只在工单进入完成态触发；若工单被取消，资产仍保持 `repairing`（符合“故障仍存在”的语义，需人工确认）。
4. 基础数据停用只影响选择项，不影响历史单据；如租户直接删除仍可能造成历史名称缺失，界面已把「停用」放在「删除」之前并给出提示。
