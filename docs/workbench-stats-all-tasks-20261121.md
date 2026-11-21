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
- “我的任务”入口文案明确为“四类任务”；
- 工作台增加维修/巡检/运送/能耗四类拆分，展示每类在办与今日完成；
- 点分类直接进入待办页并自动套用对应类型筛选。

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
| 后端全量 | **220 文件 / 2614 用例通过** |
| 小程序 pilot | **43 / 43 通过** + 绑定自检 |
| 小程序主站 | **42 / 42 通过** + 绑定自检 |

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

## 6. 复审补强

上线后按代码审查回看，又修了三处：

1. **巡检通用 `/transition` 完成可能漏写 `done_at`**  
   原实现只有 `/complete` 明确写 `done_at`；如果管理端/接口调用通用 `/transition` 把状态推到 `done`，工作台 `today_done` 会漏计。  
   现在把“进入 `done` 必写 `done_at`”收口到 `transitionTask`，并加了负控制测试。

2. **能耗/运送状态没有中文标签**  
   `submitted/reviewed/archived/transporting/created/dispatched` 会直接显示英文原值。已补到 `format.js` 与 `labels.js` 的兜底词典，测试断言 `submitted → 已提交`、`dispatched → 已下发`。

3. **“累计完成”实际包含取消/异常**  
   `done_count` 是全部终态口径，已把工作台文案改为“累计完成/结束”，避免把取消单说成完成单。

### 6.1 三项优化已落地（r8）

1. **统计索引**  
   `128_task_stats_indexes_and_energy_time.sql` 新增：
   - `inspection_task(tenant_id, assignee, status)`
   - `business_flow_tasks(tenant_id, entity_type, assignee)`
   - `business_flow_tasks(tenant_id, (data->>'worker_ref')) WHERE entity_type='energy_collection'`

2. **能耗历史时间清洗与约束**  
   - 新增 `youfu_safe_timestamptz(text)`：非法时间返回 `NULL`，不再让 summary 500；
   - 终态能耗任务缺失/非法 `submitted_at` 一次性冻结到 `updated_at`；
   - 新增 CHECK 约束 `business_flow_tasks_energy_submitted_at_chk`，阻止新的非法值；
   - `/open/me/summary` 的能耗完成时间改用安全函数。

3. **自定义工单完成态补 `completed_at`**  
   `ticket.ts` 对没有里程碑映射、但属于 `doneStates(def)` 的目标状态补：
   ```sql
   completed_at = COALESCE(completed_at, now())
   ```
   不会覆盖 `closed/evaluated` 前已经写入的首次完成时间。

### 6.2 优化验证

| 项 | 结果 |
| --- | --- |
| 后端全量 | **221 文件 / 2621 用例通过** |
| 安全检查 | `youfu_safe_timestamptz('bad') IS NULL` 为 true |
| 约束负控制 | 非法 `submitted_at` 插入被 CHECK 拒绝 |
| 索引核验 | 三个索引在主站/pilot 均存在 |
| live 四类统计 | 复跑 PASS，`active=4`、`done=12`、`today_done=4`、`today_new=8` |

### 6.3 运送完成时间与多档案审计（r9）

- 运送完成时间从 HTTP 路由分支收口到 `transitionOrder`：
  - 任何路径进入 `done` 都补 `sign_at/arrive_at`；
  - 适配器/脚本直接调用内核也不能漏完成时间。
- 多 worker 档案问题不在统计层硬改：
  - 任务列表和工作台列表仍有单 ID 查询，只改统计会造成新的不一致；
  - 新增只读审计 `scripts/audit-duplicate-workers.mjs`，主站/pilot 当前均为 **PASS**；
  - 如发现重复档案，先清洗数据，再统一列表查询范围。

### 6.4 工作台对账脚本

新增只读脚本：

```text
scripts/audit-workbench-stats.mjs
npm run audit:workbench-stats
```

逻辑：

- 自动选出租户内任务最多的 active worker；
- 用真实 worker JWT 调 `/open/me/summary`；
- 从数据库按“小程序用户可见规则”独立计算四类任务；
- 比对 `active_count / done_count / today_done / today_new`；
- 任何差异或未知状态直接非 0 退出。

实测：

```text
main  t-verification  worker=1b8fec45...  PASS
pilot zixing-hospital worker=HQ016       PASS
```

主站 `t-verification` 结果：

```text
API {"active_count":4,"done_count":2,"today_done":0,"today_new":0}
DB  {"active_count":4,"done_count":2,"today_done":0,"today_new":0}
```

### 6.5 纳入发布闸门

新增可选 live 门禁：

```bash
AUDIT_TENANT=t-verification \
API_BASE=http://127.0.0.1:4001/api/v1 \
npm run release-gate:live
```

执行内容：

- 原有静态门禁（迁移命名、SQL 注入、迁移幂等、RLS、SQL 列契约）；
- 工作台统计对账；
- 重复 worker 档案审计。

默认 `npm run release-gate` 不依赖真实租户，保持离线可跑；只有带 `--live-audit` 时才要求 `AUDIT_TENANT`。pilot 发布把 `API_BASE` 换成 `http://127.0.0.1:4101/api/v1`、`AUDIT_TENANT=zixing-hospital`。

### 6.6 analytics 模块机制隔离（r10）

- `/stats` 从共享 `workOrderRouter` 彻底移出，归并到 `statsRouter`；
- `statsRouter` 自身挂 `requireModule('analytics')`，任何挂载方都无法漏挂；
- 不再通过在共享接口里判断角色来打补丁；
- 移动端工单执行端点完全不动；
- 新增：
  - analytics 关闭 → 管理面 403 `MODULE_DISABLED`；
  - analytics 开启 → 200；
  - `moduleRouteBoundary` 静态回归，防止 `/stats` 再次回到共享路由。

### 6.7 机构解析与 operator 通知入口

- 新增小程序共享层 `utils/org.js`：
  - `youfu_mp_org` 缓存
  - 登录态 `tenant_id`
  - 兼容 `tenant`
  - `DEFAULT_ORG`
- 统一替换剩余 `user.tenant` 读取：
  - operator 代登记
  - 运送执行页
  - 工单详情
  - 现场反馈
  - AI 对话
  - 报表页
  - 我的报修 / 手机找回
- operator 工作台新增：
  - 未绑定微信时显示「绑定」入口；
  - 已绑定但需要订阅时显示「开启通知」；
  - 绑定成功后立即请求一次性订阅授权。

这修的是同一根因的剩余入口：登录用户字段是 `tenant_id`，不是 `tenant`。

## 7. 发布

- 后端已部署主站 / pilot，readiness 均 `ready`、`db=up`；
- 后端 r10 release ID：`20261121T114245-bcd54d11f142`；
- 数据库迁移：`128_task_stats_indexes_and_energy_time.sql` 已应用主站/pilot；
- pilot 小程序 **5.9.33** 已上传开发版本，预览码 `preview_qr_v5933.png`；
- pilot release manifest digest：`dc793a2a47d3219664a2518087d006b8033f522880d8b4e006f024cea58ae433`；
- 主站小程序 commit `aaaa8b0`，生产上传需产品确认后执行。
