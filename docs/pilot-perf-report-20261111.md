# 试点性能与稳定性测试报告（2026-11-11）

## 1. 环境

| 项目 | 值 |
| --- | --- |
| 服务器 | 4 vCPU / 16GB |
| 后端 | pilot `127.0.0.1:4101`，经 nginx `https://youfu.banerz.cn/pilot` |
| 数据库 | PostgreSQL 本机，连接池 `max=20` |
| 租户 | `zixing-hospital` |
| 测试数据 | 临时师傅 + 临时工单（`ext.perf_run` 标记），结束清理 |
| 真实数据 | 测试期间 3 张真实工单，未被改动 |

## 2. 验收基线（20 单 / 10 并发）

| 场景 | 样本 | 成功率 | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 建单 | 20 | 100% | 884.7ms | **2593.1ms** | 2607.3ms | 2607.3ms |
| 列表 limit=100 | 20 | 100% | 24.1ms | 141.1ms | 185.2ms | 185.2ms |
| 详情 | 20 | 100% | 13.5ms | 14.5ms | 15.0ms | 15.0ms |
| 工作台 | 10 | 100% | 18.7ms | 22.6ms | 22.6ms | 22.6ms |
| 1MB 上传 | 5 | 100% | 1990.2ms | 2027.1ms | 2027.1ms | 2027.1ms |

结果：**PASS**。  
验收线：建单 p95 < 3000ms、列表 < 1500ms、详情 < 800ms、工作台 < 2000ms、上传 < 5000ms。

## 3. 压力基线（50 单 / 50 并发，仅记录）

| 场景 | 样本 | 成功率 | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 建单 | 50 | 100% | 495.8ms | 8675.8ms | 8925.1ms | 8925.1ms |
| 列表 limit=100 | 20 | 100% | 33.9ms | 267.2ms | 293.0ms | 293.0ms |
| 详情 | 20 | 100% | 13.6ms | 14.4ms | 15.8ms | 15.8ms |
| 工作台 | 10 | 100% | 18.7ms | 20.4ms | 20.4ms | 20.4ms |
| 1MB 上传 | 5 | 100% | 2034.7ms | 2224.7ms | 2224.7ms | 2224.7ms |

建单 50 并发墙钟约 **8.96s**，0 个 5xx、0 重复工单号。

### 结论

- 50 并发同时建单是**压力场景**，不是医院试点日常负载；
- 建单尾部延迟主要来自 50 请求争用 20 个数据库连接 + 自动派单/评分链路；
- 读路径（列表/详情/工作台）在两种并发下都很稳定；
- 不建议为 50 并发直接调大连接池：Postgres 与应用同机（4 vCPU），盲目加连接可能让尾延迟更差。若未来确实需要更高建单吞吐，应先把自动派单异步化/队列化，再按 DB CPU 与连接等待调参。

## 4. 短时稳定性（30s soak）

```text
请求 725
成功 725
错误率 0%
p50 17.8ms
p95 240.5ms
p99 245.5ms
max 651.5ms
```

说明：这是 30 秒代理 soak；**24 小时 soak 尚未执行**，建议低峰期用：

```bash
PERF_SOAK_SECONDS=86400 PERF_CREATE_TOTAL=10 PERF_CONCURRENCY=5 PERF_UPLOAD_TOTAL=0 \
  node scripts/pilot-perf-e2e.mjs
```

同时监控：5xx、DB 连接等待、CPU、内存、磁盘、nginx 499/502/504。

### 24 小时 soak（已启动）

```text
开始：2026-11-11 21:32
PID：19995
日志：/opt/youfu/pilot/logs/soak-24h-20261111-213219.log
run：pmwc5rwql3c68
模式：1 单预置 + 1 rps 列表读，24h
```

查看：

```bash
tail -f /opt/youfu/pilot/logs/soak-24h-20261111-213219.log
ps -p "$(cat /opt/youfu/pilot/logs/soak-24h.pid)" -o pid,etime,cmd
```

停止（异常情况）：

```bash
kill "$(cat /opt/youfu/pilot/logs/soak-24h.pid)"
bash scripts/pilot-perf-cleanup.sh pmwc5rwql3c68
```

正常结束会自动清理临时工单/账号/人员。soak 期间 PC 列表可能出现「性能测试-0」，不要操作它。

## 5. 1000 条工单列表

直接 SQL 造 1000 条临时工单（`ext.perf_seed` 标记），不触发自动派单/通知；结束后删除。

| 场景 | 样本 | 成功率 | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 第 1 页 `limit=100` | 20 | 100% | 56.2ms | 291.6ms | 306.8ms |
| 深分页 `offset=900&limit=100` | 20 | 100% | 280.3ms | 308.0ms | 310.0ms |
| `offset=800&limit=200` | 10 | 100% | 329.5ms | 560.5ms | 560.5ms |
| 工作台（1000 单） | 10 | 100% | 30.5ms | 47.2ms | 47.2ms |

结论：1000 条数据下分页与工作台仍稳定，深分页 p95 约 308ms，可接受。

## 6. 5MB 并发上传

| 场景 | 并发 | 成功率 | p50 | p95 |
| --- | ---: | ---: | ---: | ---: |
| 4.9MB 图片（本机后端） | 5 | 100% | 286.5ms | 357.9ms |
| 5MB+1 图片 | 1 | — | — | 413 `TOO_LARGE` |
| 4.9MB 图片（公网单张） | 1 | 100% | 8854ms | 8854ms |
| 4.9MB 图片（公网 5 并发） | 5 | 100% | 51.4s | 52.2s |

结论：

- 应用/磁盘处理 5MB 并发很快（p95 358ms）；
- 公网单张 4.9MB 约 8.9s，5 并发约 52s，瓶颈是 **ECS 公网入方向带宽**（约 5Mbps），不是后端；
- 真实手机上传还受移动网络影响；
- 如果现场照片普遍 5MB，建议评估 ECS 带宽升级，或在“原图留存”合规前提下增加客户端压缩档位。

## 7. 备份恢复演练

```text
pg_dump: youfu_pilot -> 2.0MB
恢复临时库: 2 秒
行数比对: dept / location_dict / fault_category / worker / contact / work_orders /
          account_user / role_permission / ticket_event / notification 全部一致
RLS 策略: src=84 restored=84
抽查: 默认部门=1、联系人=178、工单=3
临时库已删除，未触碰 youfu_pilot
```

结论：备份可用、恢复流程可执行；建议每月演练一次，并把 dump 复制到异地/对象存储。

## 8. 测试脚本

```bash
cd /opt/youfu/pilot/backend

# 验收（20/10）
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node scripts/pilot-perf-e2e.mjs

# 压力（50/50，仅记录延迟，仍硬断言 5xx/重复单号/失败数）
PGDATABASE=youfu_pilot ENV_FILE=.env \
  PERF_CREATE_TOTAL=50 PERF_CONCURRENCY=50 PERF_STRESS=1 \
  /opt/node16/bin/node scripts/pilot-perf-e2e.mjs

# 1000 条列表
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node scripts/pilot-list-1000-e2e.mjs

# 5MB 并发上传（默认本机后端 + 公网单张探针）
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node scripts/pilot-upload-5mb-e2e.mjs

# 备份恢复演练（恢复到临时库，不碰 youfu_pilot）
bash scripts/backup-restore-drill.sh
```

脚本行为：

- 自动创建临时师傅账号（无微信 openid）+ 唯一技能标签；
- 工单只命中临时师傅，不给真实师傅发通知；
- 工单写 `ext.perf_run`，结束按标记清理；
- 上传文件同步删除；
- 失败也会执行清理。

## 9. 清理结果

```text
临时工单 0
临时账号 0
临时人员档案 0
临时上传文件 0
真实工单 3（未改动）
```

## 10. 待办

- 24 小时 soak（低峰期）；
- 公网带宽评估（5MB 单张约 8.9s，5 并发约 52s）；
- 自动派单异步化评估（若建单吞吐成为瓶颈）；
- 每月备份恢复演练 + dump 异地保存。
