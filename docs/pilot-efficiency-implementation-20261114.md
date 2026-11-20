# 方向 C「效率与提醒」实施记录（2026-11-14）

> 依据：用户选择继续方向 C。范围：通知深链/已读、催办、低库存预警、统计口径、建单幂等。
> 其中「建单幂等」核对后发现前端 Intake 已带 `Idempotency-Key`，本轮只做验证，不重复造轮子。

## 1. PC 通知可点击 + 单条已读

- 通知列表项可点击：按 `payload.entity_type` 映射到工单详情 / 巡检 / 巡更 / 志愿者页；
- 点击未读通知先调 `POST /open/notifications/read { ids: [id] }`，再跳转；
- 无关联页面的通知只置已读，不跳转；
- 映射逻辑抽到 `src/utils/notificationLink.ts`，单测覆盖工单/巡检/巡更/志愿者/未知实体。

## 2. 工单催办

- 新增 `POST /open/work_order/:id/urge`：
  - 仅活跃态可催办，完成/取消等终态 409；
  - 建单人本人或持 `ticket.manage` 的管理角色可发起；
  - 同人同单 30 分钟内只能一次（`ticket_event` 结构性防重），重复 429；
  - 处理人在身 → 站内信通知处理人；无处理人 → 通知租户管理员；
  - 写 `ticket_event(type='urge')` + domain_event。
- PC 工单详情新增「催办」按钮，429/403 给明确文案。

> SLA 超时升级与通知原本已由 `slaScheduler` 覆盖；本轮**未新增**“到期前 30 分钟提醒”，
> 避免在既有调度器上叠加未经验证的二次通知逻辑。如需要，可在下一批单独做。

## 3. 低库存预警

- 新增 `GET /inventory/summary → { low_count }`（阈值 > 0 且 qty < min_qty）。
- 新增 `PUT /inventory/threshold { material_id, warehouse?, min_qty }`：
  - `material.manage`；
  - 库存行不存在时以 qty=0 建档，避免“有阈值没台账”无处设置。
- PC 库存台账：
  - 库存数量低于阈值时标红并显示「低库存」；
  - 新增「预警阈值」列与设置弹窗；
  - 顶部低库存数量 Badge + 「只看低库存」开关（`?low=1`）。

## 4. 统计口径

- `GET /stats` 增加后端聚合：
  - `catalog_distribution: [{ key, count }]`
  - `source_distribution: [{ key, count }]`
- PC 统计分析页不再请求 `/open/work_orders?limit=1000`，占比分母改为 `total`，避免超过 1000 单后被截断。

## 5. 建单幂等（核对结论）

- `Intake.tsx` 已在提交时生成 `uuidv4()` 并发送 `Idempotency-Key`；
- 后端 `authMiddleware` 读取该头，`createWithIdem` 以唯一键防重；
- 本轮未改动，已由现有测试与线上链路覆盖。

## 6. 验证

```text
后端全量        204 文件 / 2486 用例 PASS
前端全量        35 文件 / 264 用例 PASS
PC Playwright   10/10 PASS
线上隔离审计    10/10 PASS（uat-eff-<run>，审计后清理）
```

线上审计 `scripts/pilot-efficiency-audit-e2e.mjs`：

```text
催办：管理员 200
催办：30 分钟内重复 429
催办：处理人收到站内信
通知：ids 单条已读 marked=1
催办：终态工单 409
低库存：设置阈值 200
低库存：低于阈值进入 low=1 列表
低库存：汇总 low_count ≥ 1
统计：catalog_distribution 后端返回
统计：分布总数不超过 total
```

PC 实测：耗材库存页已显示低库存/阈值/只看低库存；统计页按业务目录占比正常；通知中心项可点击。

## 7. 部署

```text
后端  active，/health/ready 200
PC    assets/index-DW5oY6gh.js
小程序 本轮无小程序改动（仍为 v5.9.26）
```

## 8. 残余风险

1. 催办只覆盖登录用户建单；公开报修（无账号）没有催办入口，仍需电话。
2. 催办限频按“同人同单 30 分钟”，不同人连续催办仍会给处理人多条通知（业务上可接受）。
3. 低库存阈值需人工设置（默认 0 = 不预警）；未设置阈值的材料不会进入预警。
4. 统计分布按 `catalog/source` 原值分组；存量 UUID 目录会显示为原始 key（数据治理问题，不是口径问题）。
5. SLA 到期前提醒未新增，目前仍是“超时后升级 + 通知”。
