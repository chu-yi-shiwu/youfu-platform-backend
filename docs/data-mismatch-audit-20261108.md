# 工作台“数据对不上”核对（2026-11-08）

## 结论

截图是**主站 `youfu` 库**的数据，不是 pilot 库（pilot 工单为 0）。
主站 `t-verification` 实际数据与截图基本吻合；列表为 0 的根因是**全局服务台筛选**
与工作台卡片统计口径不一致，不是丢数据。

## 1. 主站真实分布（t-verification）

| status | 数量 | SLA 已过期 |
| --- | ---: | ---: |
| assigned | 8 | 8 |
| processing | 4 | 4 |
| completed | 19 | 2 |
| evaluated | 4 | 4 |
| closed | 1 | 1 |
| cancelled | 16 | 2 |
| **合计** | **52** | **21** |

- 工作台“待处理 8”= assigned 8；
- “进行中 4”= processing 4；
- “已完成/闭环 24”= completed 19 + evaluated 4 + closed 1；
- “超时待办 12”= assigned 8 + processing 4（工作台只把未闭环的待办/进行中算超时）；
- “撤销率 30.8%”= cancelled 16 / 52 = 30.77%；
- “今日新增 0”正确：最后一张工单创建于 2026-10-19，今天没有新单。

## 2. 为什么列表“已超时”是 0

- 工单列表截图里 **服务台筛选 = 志愿者服务台**；
- 主站 `t-verification` 的 52 张工单 **`service_desk` 全部为 NULL**；
- 所以列表同时套 `timeout=1 + service_desk=志愿者服务台` 必然是 0；
- 直接调用后端 `GET /open/work_orders?timeout=1&limit=50`（不带服务台）
  实测返回 **12 条，total=12**，与工作台“超时待办 12”一致。

根因代码：

- `Dashboard.tsx` 的 `stats` 遍历 **未过滤的 `items`**；
- 工单列表 `TicketList.tsx` 使用 **全局筛选后的 `filtered`**（服务台/部门）；
- 两边口径不一致 ⇒ 卡片全量、列表筛选后。

已修：`Dashboard.tsx` 的统计改为遍历 `filtered`，依赖 `[filtered]`。
前端 `tsc`/build/28 文件 240 用例通过。

> 立即绕过：在主站列表把“服务台”筛选清空，再点“已超时”，就能看到 12 条。
> 主站旧前端未重新部署，所以浏览器里仍是旧行为；pilot PC 管理端已部署修复后的构建。

## 3. “已评价工单 0”与 evaluated 4

- 4 张 `evaluated` 工单的 `satisfaction_score` **全部为 NULL**；
- `/stats` 的 `satisfaction_count` 只统计有分数的工单 ⇒ 显示 0，均分 0.00；
- 这是**历史数据质量问题**（状态已评价但没写分数），不是聚合算错。

建议：对 4 张历史 `evaluated` 工单补分数，或把它们回退到可评价状态；新流程应在
`closed→evaluated` 边强制 `satisfaction_score`（本地 def 已有 requiredFields）。

## 4. 环境提醒

- 截图数据来自主站 `youfu` 库；
- pilot 库 `youfu_pilot` 目前工单为 0（只种了基础数据/巡检/巡更/志愿者）；
- 不要在 pilot 页面上用主站数字判断 pilot 是否正常；
- 主站仍是 10-30 旧后端 + 旧前端；本修复只在当前源码与 pilot PC 管理端生效。
