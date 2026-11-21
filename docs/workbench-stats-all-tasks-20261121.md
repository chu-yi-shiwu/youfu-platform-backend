# 工作台统计四类任务全覆盖 · 2026-11-21

## 1. 根因

`GET /api/v1/open/me/summary` 是移动端工作台和“我的任务”共用的个人统计端点，但原实现只查 `work_orders`：

- 巡检 `inspection_task`
- 运送 `transport_order`
- 能耗 `business_flow_tasks(entity_type='energy_collection')`

这三类任务虽然已经进入“我的任务”列表，却没有进入工作台统计。结果是同一名工人的任务清单与工作台数字对不上。

同时，前端“我的任务”用一个全局终态集合判断所有类型，缺少能耗的 `submitted/reviewed/archived`，会把已提交的能耗任务错误留在“在办”。

## 2. 统一口径

### 2.1 状态集合

| 类型 | 活跃 | 成功完成 | 全部终态 |
| --- | --- | --- | --- |
| 维修 `work_orders` | `workflow_def.activeStates`，剔除抢单池和终态 | `workflow_def.doneStates` | `doneStates ∪ terminalStates` |
| 巡检 `inspection_task` | `pending`、`in_progress` | `done` | `done`、`exception`、`cancelled` |
| 运送 `transport_order` | `pending`、`assigned`、`transporting` | `done` | `done`、`exception`、`cancelled` |
| 能耗 `business_flow_tasks` | `created`、`dispatched`、`in_progress` | `submitted`、`reviewed`、`archived` | `submitted`、`reviewed`、`archived`、`cancelled` |

统一由 `src/repo/meTaskStats.ts` 维护，不再在路由或页面里各写一份。

### 2.2 四个数字

- `active_count`：四类任务活跃数之和；
- `done_count`：四类任务全部终态之和，包含取消和异常；
- `today_done`：只统计成功完成态，且按业务完成时间的 Asia/Shanghai 本地日；
- `today_new`：四类任务按 `created_at` 的 Asia/Shanghai 本地日新增。

`today_done` 不能拿 `done_count` 冒充，也不能用 `updated_at` 代替完成时间。

### 2.3 完成时间字段

| 类型 | 完成时间 |
| --- | --- |
| 维修 | `COALESCE(completed_at, rated_at, updated_at)` |
| 巡检 | `done_at` |
| 运送 | `COALESCE(sign_at, arrive_at, updated_at)` |
| 能耗 | `COALESCE(data->>'submitted_at', updated_at)` |

能耗状态回流时，`submitted_at` 缺失会由后端补 `now()`；非法时间直接 422，避免把一个不可解析的值写进完成时间。

### 2.4 日期边界

所有“今日”条件都显式使用：

```sql
(时间字段 AT TIME ZONE 'Asia/Shanghai')::date
  = (now() AT TIME ZONE 'Asia/Shanghai')::date
```

不依赖数据库默认时区，也不使用 `CURRENT_DATE`。

## 3. 接口变化

`GET /api/v1/open/me/summary` 保持原有 `worker`、`stats` 字段，并新增按类型拆分：

```json
{
  "worker": { "id": "w-1" },
  "stats": {
    "active_count": 4,
    "done_count": 12,
    "today_done": 4,
    "today_new": 8
  },
  "stats_by_type": {
    "work_order": { "active_count": 1, "done_count": 3, "today_done": 1, "today_new": 2 },
    "inspection_task": { "active_count": 1, "done_count": 3, "today_done": 1, "today_new": 2 },
    "transport_task": { "active_count": 1, "done_count": 3, "today_done": 1, "today_new": 2 },
    "energy_task": { "active_count": 1, "done_count": 3, "today_done": 1, "today_new": 2 }
  }
}
```

旧版小程序只读 `stats`，不需要同步升级即可正确显示总数；新版可按类型做下钻。

## 4. 前端修复

### 4.1 我的任务

`pages/worker/todo/todo.js`：

- 按任务类型判断终态，不再用一个全局集合；
- 能耗 `submitted/reviewed/archived` 归入已完成，`dispatched` 归入在办；
- 完成时间按类型取业务字段：
  - 维修 `completed_at`
  - 巡检 `done_at`
  - 运送 `sign_at/arrive_at`
  - 能耗 `data.submitted_at`
- 已完成按完成时间倒序，日期筛选使用同一时间字段。

### 4.2 工作台

- 工作台三格统计直接消费后端统一结果；
- `onShow` 每次刷新，完成/提交返回后立即更新；
- “我的任务”入口文案明确为“四类任务”。

## 5. 验证

### 5.1 单元 / HTTP 契约

- 新增 `src/test/meSummaryAllTasks.test.ts`：
  - 四张表都参与查询；
  - 四类状态集合固定；
  - `stats_by_type` 汇总正确；
  - 今日边界为 `Asia/Shanghai`，不使用 `CURRENT_DATE`；
  - 完成时间字段按类型固定。
- 扩展 `statusVocabDerived.test.ts`：`done_count` 使用终态集合，`today_done` 使用成功完成集合。
- 扩展 `energyStatusUpdate.http.test.ts`：`submitted_at` 必须可解析，合法值原样落库。

### 5.2 全量

| 项 | 结果 |
| --- | --- |
| 后端全量 | **220 文件 / 2613 用例通过** |
| 小程序 pilot | **40 / 40 通过** + 绑定自检 |
| 小程序主站 | **39 / 39 通过** + 绑定自检 |

### 5.3 live 隔离租户

`scripts/live-today-done-audit.mjs` 在 `uat-stats-*` 隔离租户造四类任务，每类 4 条：

- 1 条在办；
- 1 条今天成功完成；
- 1 条 3 天前成功完成，但 `updated_at` 改成今天；
- 1 条 3 天前取消/异常，`updated_at` 也改成今天。

预期与实测：

```text
API total {"active_count":4,"done_count":12,"today_done":4,"today_new":8}
API work_order {"active_count":1,"done_count":3,"today_done":1,"today_new":2}
API inspection_task {"active_count":1,"done_count":3,"today_done":1,"today_new":2}
API transport_task {"active_count":1,"done_count":3,"today_done":1,"today_new":2}
API energy_task {"active_count":1,"done_count":3,"today_done":1,"today_new":2}
PASS 四类任务 active=4 done=12 today_done=4 today_new=8
```

这条 live 审计专门验证：**3 天前完成、今天只改了 `updated_at` 的任务不会重新计入今日完成**。

审计结束自动清理 `uat-stats-*`，不触碰真实 pilot 租户。

## 6. 发布

- 后端已部署主站 / pilot，readiness 均 `ready`、`db=up`；
- pilot 小程序 **5.9.30** 已上传开发版本，预览码 `preview_qr_v5930.png`；
- pilot release manifest digest：`3d40b2b0a13ef608807decda7a89d9bfc1d04787ccd7eabc461a6b3271a111d6`；
- 主站小程序代码同步，生产上传需产品确认后执行。
