# 试点模拟数据与 E2E（2026-11-09）

不依赖医院真实数据，用于产品演示、真机走查和试点验收。

## 1. 一键生成

在 ECS pilot 后端目录执行：

```bash
cd /opt/youfu/pilot/backend
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node seed-pilot-demo.mjs --tenant=zixing-hospital --orders=100
```

生成了：

- 部门：`维修组`、`保洁组`、`安保组`（不覆盖既有 `总务科`）
- 人员：`DEMO-W001` ~ `DEMO-W006`
- 演示账号：
  - `demo_admin` / `demo_operator` / `demo_w1` ~ `demo_w6`
  - 统一密码：`Demo123!`
- 位置：住院部、门诊楼、医技楼、行政楼、急诊科
- 问题目录：漏水、空调、电路、门窗、网络、保洁、安保、其他
- 路由规则：保洁/安保/漏水/空调/电路/网络 → 对应部门
- 工单：100 条，覆盖
  - pending_dispatch 20
  - assigned 20
  - processing 15
  - completed 20
  - closed 10
  - evaluated 10
  - cancelled 5

重复执行会先清掉上一轮 demo 数据再重建，不会堆叠。

## 2. 一键清理

> 🔴 这些 `demo_*` 账号是演示账号（密码统一 `Demo123!`），**真实试点前必须执行 `--clean`**，
> 或至少停用这些账号；不要把演示账号带进正式试点。

```bash
cd /opt/youfu/pilot/backend
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node seed-pilot-demo.mjs --tenant=zixing-hospital --clean
```

只删除 `DEMO_*` 部门、`DEMO-W*` 人员、`demo_*` 账号、`[DEMO]` 规则、
`demo_*` 目录和 `ext.demo_seed='pilot-demo'` 工单，不动 `总务科`、`W0001` 和真实数据。

## 3. 端到端验收

```bash
cd /opt/youfu/pilot/backend
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node pilot-e2e.mjs
```

覆盖：

1. 运营账号 mp 登录被拒；
2. 运营建单，不选部门；
3. 规则自动归属维修组；
4. 自动/人工派单；
5. 师傅登录，只看本人任务；
6. 其他师傅不可见；
7. 师傅接单 → 完成；
8. 管理员关闭 → 评价 5 分；
9. 工作台 total +1、满意度计数 +1；
10. 自动清理测试单。

## 4. 试点模式

`/pilot/` 构建使用 `--mode pilot`（`.env.pilot` 设置 `VITE_PILOT_MODE=1`）：

- 菜单只保留：工作台、工单申报、工单管理、设置中心、基础数据、系统管理、需求反馈；
- 隐藏：结算、巡检、巡更、志愿者、监控、运送、资产、耗材、设备、应急预案、数据大屏、统计分析、自适应优化、体验用户、移动入口；
- 工作台隐藏巡检/运送/应急/资产看板和优化飞轮。
