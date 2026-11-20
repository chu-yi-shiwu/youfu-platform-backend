# 试点测试准备清单（2026-11-09）

目标：让测试人员拿到这份清单就能开始，不需要再问环境、账号、数据和预期结果。

## 1. 测试环境

| 项目 | 地址 / 说明 |
| --- | --- |
| 主站 PC | `https://youfu.banerz.cn/` |
| pilot PC | `https://youfu.banerz.cn/pilot/` |
| pilot API | `https://youfu.banerz.cn/pilot/api/v1` |
| 主站后端 | `127.0.0.1:4001`，`youfu-backend` |
| pilot 后端 | `127.0.0.1:4101`，`youfu-pilot` |
| 主站健康 | `https://youfu.banerz.cn/health` |
| pilot 健康 | 服务器上 `curl http://127.0.0.1:4101/health` |
| pilot 库 | `youfu_pilot` |
| 主站库 | `youfu` |
| 服务器 | `root@8.136.107.153`，密钥 `~/.ssh/aliyun_energy` |

pilot 已应用迁移：`110 ~ 115`。

## 2. 测试角色与设备

建议至少准备：

- 1 名管理员/配置人员（PC）
- 1 名运营人员（PC）
- 2 名师傅（微信，需加入小程序体验成员）
- 2 台电脑（或 1 台电脑 + 2 个浏览器窗口，主站/pilot 各一）
- 2 台手机（微信，安装/打开体验版小程序）
- 1 个测试微信群（问题截图/录屏）
- 可用的医院内网或 4G/5G 网络

## 3. 测试账号

### pilot 真实账号

密码在服务器 600 权限文件中，不在文档里明文保存：

- `/opt/youfu/pilot/initial-credentials.txt`
  - `admin`（管理员）
  - `operator`（运营）
- `/opt/youfu/pilot/worker-create.json`
  - `w001`（师傅）

### pilot 演示账号（仅演示/测试）

- `demo_admin` / 密码 `Demo123!`
- `demo_operator` / 密码 `Demo123!`
- `demo_w1` ~ `demo_w6` / 密码 `Demo123!`

> 真实试点前必须清理演示账号。

### 主站

使用现有管理员/运营账号。主站已轮换 JWT_SECRET，旧登录全部失效，需要重新登录。

## 4. 测试数据

### 当前 pilot 演示数据

- 部门：维修组、保洁组、安保组（+ 既有总务科）
- 师傅：`DEMO-W001` ~ `DEMO-W006`
- 工单：100 条
  - pending_dispatch 20
  - assigned 20
  - processing 15
  - completed 20
  - closed 10
  - evaluated 10
  - cancelled 5
- 路由规则：6 条
- 位置：5 个
- 问题目录：8 个

### 重建 / 清理

```bash
cd /opt/youfu/pilot/backend

# 重建 100 条演示数据
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node seed-pilot-demo.mjs --tenant=zixing-hospital --orders=100

# 清理演示数据与 demo_* 账号
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node seed-pilot-demo.mjs --tenant=zixing-hospital --clean
```

### 主数据导入

```bash
# 先 dry-run
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node import-pilot-master.mjs \
  --tenant=zixing-hospital --dir=/tmp/pilot-master

# 确认后 apply
... --apply
```

示例 CSV：`scripts/pilot-master-example/`。

## 5. 测试工具

- PC 浏览器：Chrome / Edge
- 微信开发者工具：`C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat`
- 小程序体验版二维码：`youfu_mp_pilot/preview_qr_v5916.png`
- 小程序版本：底部应显示 `v5.9.16`
- 终端：curl / psql
- 自动化：`pilot-e2e.mjs`

## 6. 开测前 10 分钟检查

```bash
# 1) 服务
systemctl is-active youfu-backend
systemctl is-active youfu-pilot

# 2) 健康
curl -sS http://127.0.0.1:4001/health
curl -sS http://127.0.0.1:4101/health

# 3) 迁移
sudo -u postgres psql -d youfu_pilot -Atc \
  "SELECT name FROM _migrations WHERE name >= '110' ORDER BY name"

# 4) 演示数据（应为 depts=3 workers=6 orders=100）
sudo -u postgres psql -d youfu_pilot -Atc \
  "SELECT 'depts='||count(*) FROM dept WHERE tenant_id='zixing-hospital' AND code LIKE 'DEMO\\_%' ESCAPE '\\'"
sudo -u postgres psql -d youfu_pilot -Atc \
  "SELECT 'workers='||count(*) FROM worker WHERE tenant_id='zixing-hospital' AND id LIKE 'DEMO-W%'"
sudo -u postgres psql -d youfu_pilot -Atc \
  "SELECT 'orders='||count(*) FROM work_orders WHERE tenant_id='zixing-hospital' AND ext->>'demo_seed'='pilot-demo'"

# 5) E2E
cd /opt/youfu/pilot/backend
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node pilot-e2e.mjs
```

`pilot-e2e` 通过 = 建单、部门、派单、师傅、评价、工作台主链路正常。

## 7. 测试分轮

### A. 内部冒烟（30 分钟）

- 主站 PC 能登录
- pilot PC 能登录
- 小程序能登录
- 工作台/工单列表/详情不报错
- 试点菜单只显示报修闭环与配置

### B. 运营 PC UAT（1–2 小时）

- 建单：不选部门 → 自动归属
- 路由规则：描述含“漏水” → 维修组
- 派单/改派
- 改部门
- 退回后重新派单
- 关闭 → 评价
- 工作台数字与列表一致
- 列表筛选/导出
- 通知中心

### C. 师傅小程序 UAT（1 小时）

- 微信登录/绑定
- 只看本人任务
- 接单
- 到场
- 完成
- 拍照/语音
- 弱网重试
- 开启通知 + 自检
- 其他师傅不可见本单

### D. 权限/隔离专项（30 分钟）

- worker 登录 PC → 403
- operator 登录小程序 → 403
- 跨租户不可见
- 改角色后旧 token 401
- 未登录接口 401

### E. 发布回归（20 分钟）

- `pilot-e2e.mjs`
- 主站登录 + 工作台
- pilot 登录 + 工作台
- `/health`、`/health/ready`
- 小程序版本号

### F. 备份恢复（30 分钟）

- 确认最新 `pg_dump`
- 恢复到临时库
- 抽查工单数/部门数
- 删除临时库

## 8. 核心用例与预期

| ID | 场景 | 步骤 | 预期 |
| --- | --- | --- | --- |
| T01 | 自动归属 | 运营建单，不选部门，描述含“漏水” | 责任部门=维修组，来源以 rule: 开头 |
| T02 | 默认部门 | 建单无任何匹配条件 | 落默认部门（总务科） |
| T03 | 自动派单 | T01 提交 | 有 assignee，状态 assigned/claim_hall |
| T04 | 人工派单 | 自动未命中，运营改派 | 工单派给指定师傅 |
| T05 | 改部门 | 处理人不属于目标部门时改部门 | 409，提示先改派 |
| T06 | 改部门成功 | 解除处理人后改部门 | 200，事件 change_department |
| T07 | 师傅可见性 | 师傅登录看列表 | 只含本人任务 |
| T08 | 越权 | 师傅访问他人工单 | 403/404 |
| T09 | 完成 | 师傅接单→到场→完成 | 状态 completed |
| T10 | 评价 | 运营关闭→评价 5 分 | evaluated、score=5 |
| T11 | 工作台 | 评价后看工作台 | total、满意度、已评价数变化 |
| T12 | 渠道 | worker 登录 PC；operator 登录小程序 | 均 403 CHANNEL_FORBIDDEN |
| T13 | 旧 token | 改角色后旧 token 请求 | 401 AUTH_004 |
| T14 | 列表筛选 | 按部门/bucket/超时筛选 | 与工作台口径一致 |
| T15 | 导出 | 导出当前列表 | CSV 行数与列表一致 |
| T16 | 通知 | 师傅开启通知并自检 | errcode:0；失败有真实说明 |
| T17 | 主数据导入 | dry-run 示例 CSV | 显示 3/5/8/6/4，不写库 |
| T18 | 试点菜单 | 打开 pilot PC | 不出现结算/巡检/运送/资产/大屏/优化 |

## 9. 数据核对 SQL

```sql
-- 工单总数
SELECT count(*) FROM work_orders WHERE tenant_id='zixing-hospital';

-- 默认部门
SELECT id,name FROM dept WHERE tenant_id='zixing-hospital' AND is_default;

-- 部门为空（应为 0）
SELECT count(*) FROM work_orders WHERE tenant_id='zixing-hospital' AND department_id IS NULL;

-- evaluated 无分数（应为 0）
SELECT count(*) FROM work_orders
 WHERE tenant_id='zixing-hospital' AND status='evaluated' AND satisfaction_score IS NULL;

-- 师傅负载
SELECT id,name,load FROM worker WHERE tenant_id='zixing-hospital' ORDER BY id;
```

## 10. 问题记录模板

```text
发生时间：
测试账号/角色：
浏览器/小程序版本：
工单号：
操作步骤：
期望结果：
实际结果：
截图/录屏：
是否可复现：
```

## 11. 准入/退出标准

### 准入

- [ ] `youfu-backend`、`youfu-pilot` active
- [ ] 两个 `/health` 正常
- [ ] pilot 迁移 110~115
- [ ] 演示数据或真实基础数据就绪
- [ ] 账号可用
- [ ] 小程序 v5.9.16 可打开
- [ ] `pilot-e2e.mjs` 通过

### 退出

- [ ] T01~T18 全部通过
- [ ] 无 P0/P1 阻塞缺陷
- [ ] 问题已登记并分级
- [ ] 测试数据已按计划清理或保留
- [ ] 试点负责人确认可进入真实数据试运行

## 12. 注意事项

- 演示账号密码是公开测试密码，真实试点前必须 `--clean`。
- 微信订阅消息是“一次性授权”，43101 属于正常现象，需要重新授权。
- 主站与 pilot 同域但 localStorage 已隔离，两个站点可同时登录。
- 修改角色/停用账号后，旧 token 会立即 401，需要重新登录。
- 生产环境不要直接跑 `--apply` 导入，先 dry-run。
