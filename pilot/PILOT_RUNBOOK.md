# 优服家 · 试点上线运行手册（Pilot Runbook）

> 目标：把"引擎从能跑变能用"的最后一公里固化成可复用的上线步骤。
> 覆盖：部署最新 `main` 到 ECS → 配置试点租户 → 跑通「过程挖掘 → 优化建议 → 改写流程定义」自我优化闭环 → 生产化切流清单 → 回滚。

---

## 0. 一句话定位

优服家不是一个"把流程一次性搬上线"的工具，而是一个**业务流→数据→反馈→自我优化**的持续飞轮（设计支柱④ 自我优化闭环 + ⑤ 模数共振）。本手册的操作，就是让这个飞轮在**真实租户**上第一次真正转起来。

---

## 1. 环境坐标

| 项 | 值 |
|---|---|
| ECS | `8.136.107.153`（`root@banerz.cn`），CentOS 7，Node 16（`/opt/node16`） |
| 数据库 | PG `127.0.0.1:5432`，库 `youfu`，应用角色 `youfu_app`（RLS 隔离） |
| 后端目录 | `/opt/youfu/backend` |
| 服务管理 | `systemctl restart youfu-backend.service` |
| 运行端口 | **4001**（dev 模式，`AUTH_MODE=dev`，与老平台 80/443 互不干扰） |
| 前端页（同后端托管） | `/master-data`、`/process-mining`；`/workflow/def` 走 API |
| 试点租户 | `t-verification`（默认 `DEFAULT_LOGIN_TENANT`） |

> 多租户 RLS 是铁底线：应用读取靠 `SET app.tenant_id`（带点 GUC），超级用户绕过 RLS；写隔离由 `WITH CHECK` 策略保证。

---

## 2. 部署最新 `main` 到 ECS（关键：ECS 旧构建可能落后）

**症状**：`curl 127.0.0.1:4001/master-data` → 404、`/process-mining` → 404，说明 `dist` 是旧构建（本冲刺就撞到：ECS 跑的还是 ⑦ 之前的代码）。

**在开发机执行（需 ECS SSH 私钥 `~/.ssh/aliyun_energy`）：**

```bash
# 1) 备份（排除 node_modules，避免污染 ECS 专属依赖）
ssh root@8.136.107.153 "mkdir -p /opt/youfu/backend.bak.\$(date +%s) && \
  tar cf - --exclude=node_modules -C /opt/youfu backend | \
  tar xf - -C /opt/youfu/backend.bak.\$(date +%s)"

# 2) 同步源码（保留 .env / node_modules）
cd /path/to/youfu_platform_backend
tar czf - src public tsconfig.json tsconfig.build.json package.json package-lock.json scripts | \
  ssh root@8.136.107.153 "cd /opt/youfu/backend && tar xzf -"

# 2.5) 🔴 跑数据库迁移 —— **这一步原 runbook 缺失，是 102/103 迁移长期没上生产的直接原因**
#   迁移**不会**随服务启动自动跑（src/server.ts 里没有 migrate 调用），必须手工执行。
#   实测教训（2026-10-28）：scripts/*.sh 在 git blob 里**就是 CRLF**（不是"只有工作副本是"），
#   `git archive` 取出来照样是 CRLF ⇒ `set -euo pipefail\r` 直接让整个迁移挂掉，
#   且不报任何 DB 错误、只是静默少加列 —— 最难查的一类失败。
#   ⇒ 传送后**必须先归一化**，再执行：
ssh root@8.136.107.153 "cd /opt/youfu/backend && \
  for f in scripts/*.sh; do sed -i 's/\r$//' \"\$f\"; done && \
  bash scripts/migrate-as-owner.sh /opt/youfu/backend"
#   预期输出：已应用的全部 `skip (already applied): ...`，本次新增的显示 `apply: NNN_xxx.sql` + DDL 回显。
#   执行后务必核对记账（否则等于没跑）：
#     psql -d youfu -t -A -c "SELECT name FROM _migrations WHERE name LIKE '10%'"

# 3) 构建（Node 16 直编，勿用 tsc 全局）
ssh root@8.136.107.153 "cd /opt/youfu/backend && \
  /opt/node16/bin/node node_modules/typescript/bin/tsc -p tsconfig.build.json"

# 4) 重启
ssh root@8.136.107.153 "systemctl restart youfu-backend.service"

# 5) 验证
curl -s -o /dev/null -w "master-data:%{http_code}\n" http://127.0.0.1:4001/master-data
curl -s -o /dev/null -w "process-mining:%{http_code}\n" http://127.0.0.1:4001/process-mining
curl -s -H "Authorization: Bearer dev" -H "X-Tenant-Id: t-verification" http://127.0.0.1:4001/api/v1/assets
#   ⚠️ 本环境 AUTH_MODE=prod ⇒ 上面三条返回 **401 是正常**（要登录），不是故障。
#   真正的健康判据是日志，不是 HTTP 码：
ssh root@8.136.107.153 "journalctl -u youfu-backend.service --since '10 min ago' --no-pager | \
  grep -iE '42703|does not exist|ERROR'"
#   ⇒ 空 = 健康。另确认 `listening on 0.0.0.0:4001` 与各 scheduler started 都在。
```

---

## 3. 配置试点租户：工作流 + 负载

- **状态图是零代码配置载体**：`workflow_def` 表，每租户每业务流一行（`UNIQUE(tenant_id, entity_type)`）。无定义时引擎用默认 4 态 `draft→assigned→processing→completed`。
- **写入基线**（让"飞轮改写前后"有对照）：
  ```sql
  INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES (
    't-verification', 'work_order',
    '{"initial":"draft","states":["draft","assigned","processing","completed"],
      "transitions":[{"from":"draft","to":"assigned","event":"assign"},
                     {"from":"assigned","to":"processing","event":"start"},
                     {"from":"processing","to":"completed","event":"complete"}],"config":{}}'::jsonb, 1);
  ```
- **注入真实负载**：过程挖掘的唯一数据源是统一事件总线 `domain_event`，按 `entity_id` 回放。当前 work_order 生命周期代码仅 emit `create`(建单)/`assign`(派单)/`sla_escalated`；`processing`/`completed` 由事件总线汇聚——试点直接用 `pilot/pilot_seed.sql` 写入全生命周期事件（含返工变体），生产接真实事件源（webhook/各生命周期钩子）。
- 参考样例：`pilot/pilot_seed.sql`（16 工单：10 简单路径 + 6 返工路径，assign→processing ≈ 10h 触发慢边）。

---

## 4. 跑通自我优化闭环（④ + ⑤ 实证）

所有 curl 带 `-H "Authorization: Bearer dev" -H "X-Tenant-Id: t-verification"`。

```bash
B=http://127.0.0.1:4001
# 1) 过程挖掘（看板"眼睛"）
curl -s $B/api/v1/process-mining?days=30
#   → variants / bottlenecks.slowest_edge / conformance.deviation_rate

# 2) 生成并应用优化建议（需 MODEL_AUTO_TUNE=true）
#    临时起一个 AUTO_TUNE 实例，避免污染持久安全部署：
ssh root@8.136.107.153 "cd /opt/youfu/backend && \
  MODEL_AUTO_TUNE=true PORT=4100 nohup /opt/node16/bin/node dist/server.js >/tmp/pilot4100.log 2>&1 &"
curl -s -X POST http://127.0.0.1:4100/api/v1/optimize/generate-mining?entityType=work_order\&days=30
#   → 慢边(>8h): work_order:auto_escalate（新增 escalated 态 + processing→escalated 转移）
#      偏离率(>0.3): work_order:recheck_gate（新增 recheck 态 + assigned→recheck→processing 转移）

# 3) 核查改写结果
curl -s http://127.0.0.1:4100/api/v1/workflow/def?entity=work_order   # 状态集已扩充
curl -s http://127.0.0.1:4100/api/v1/optimize/list                     # 建议 status=applied
# 演示完停掉临时实例： ssh root@8.136.107.153 "fuser -k 4100/tcp"
```

**安全红线**：持久 4001 部署 `MODEL_AUTO_TUNE` 默认**关**（只记录建议、不应用，避免试点误改流程定义）。`AUTO_TUNE` 仅临时实例或生产**明确开启**后启用。

---

## 4.5 客户要改流程定义前，必须知道的事（运营/销售口径）

> 这一节不是故障处理，是**对客承诺口径**。销售谈客户、运营走工单时都要照这个说，别按错的承诺签约。

**① 「改流程不影响老单」只对一半成立 —— 只对迁移后新建的单成立。**
实测 `src/engine/workflowDef.ts:628-630`：`getWorkflowDefAtVersion` 在 `!version || version <= 0` 时直接走 live def ⇒
`def_version = 0`（建单时未记录版本）的行**仍然跟着改版变**。
⇒ **今天之前建的存量老单，改流程后会跟着变。** 版本锁只保护迁移之后新建的单。
（这是刻意设计：老单无法证明它出生时的版本，编一个填进去等于伪造数据。）

**② 对客承诺时必须带上这句原话：**
> 「今天之前的存量单，仍会跟随流程改版变化。」

**③ 目前没有任何通路把一张在途单迁到新版本。**
已拍板**暂不做管理端点**，等真实诉求出现再做。⇒ 客户若问"能不能把老单切到新流程"，今天的答案是**不能**，不是"还没做"。

---

## 5. 生产化切流清单

- [ ] **鉴权**：`AUTH_MODE=prod` + `JWT_SECRET` 强随机；去掉 dev 兜底（`DEFAULT_LOGIN_TENANT` 仅 dev 用）。
- [ ] **真实登录源**：后端 `signLoginToken` 签发载荷 `(sub, tid, role, exp)`；前端改用真实 token。
- [ ] **MODEL_AUTO_TUNE 策略**：试点/预发可开；生产首期建议**关**（人工审建议），稳定后再开自动写回。
- [ ] **前端页鉴权**：当前 `/master-data`、`/process-mining` 公开托管，生产应在反代层加鉴权（nginx 已就位 `youfu.banerz.cn.conf`）。
- [ ] **监控**：`domain_event` 入量、挖掘变体发散度、`optimization_feedback` 应用率；每日自动化已覆盖 RLS 跨租户回归。
- [ ] **备份**：PG 定期备份；`workflow_def` 变更带 `version` 历史，可回滚。

---

## 6. 回滚

- **代码**：`systemctl stop youfu-backend.service` → 还原 `/opt/youfu/backend.bak.*` → `systemctl start youfu-backend.service`。
- **流程定义**：`UPDATE workflow_def SET def=<旧版>, version=version+1 WHERE tenant_id=? AND entity_type=?`（或 `DELETE` 回退默认 4 态）。
- **试点数据**：`DELETE FROM domain_event / work_orders / optimization_feedback / workflow_def WHERE tenant_id='t-verification'` 清理后重灌。
