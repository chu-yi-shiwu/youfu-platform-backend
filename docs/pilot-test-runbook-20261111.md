# 试点测试运行手册（2026-11-11）

配套本轮新增的自动化：

| 文件 | 类型 | 覆盖 |
| --- | --- | --- |
| `src/test/workflowRoleMatrix.test.ts` | 后端单测 | 富 13 态流程的角色 × 动作门禁 |
| `src/test/dataQuality.test.ts` | 后端单测 | 2 字标题、超长标题、电话/位置提示 |
| `src/test/uploads.test.ts` | 后端单测 | 上传路径/扩展名/token 鉴权基础 |
| `src/test/pool.test.ts` | 后端单测 | 租户编码白名单（中文医院名 → 400） |
| `youfu_frontend_dev/src/test/api/templates.test.ts` | 前端单测 | PC `canShowAction` 可见性 |
| `youfu_frontend_dev/e2e/*.spec.ts` | PC Playwright | 登录矩阵、建单、审核按钮、XSS、pilot 模块可见性/页面冒烟 |
| `scripts/pilot-role-action-e2e.mjs` | 真实 API E2E | 角色 × 动作 200/403/422 + 状态推进 |
| `scripts/pilot-media-e2e.mjs` | 真实公网 E2E | 1MB/4.5MB/5MB+1 上传、照片/录音 token 读取、备注权限 |
| `scripts/pilot-security-e2e.mjs` | 真实 API 安全 E2E | 跨租户、IDOR、PII、JWT 篡改、SQL 注入、上传穿越 |
| `scripts/pilot-perf-e2e.mjs` | 真实 API 性能 E2E | 20/10 验收、50/50 压力、列表/详情/工作台/上传/soak |
| `scripts/pilot-list-1000-e2e.mjs` | 1000 条列表 | 首页/深分页/limit=200/工作台 |
| `scripts/pilot-upload-5mb-e2e.mjs` | 5MB 上传 | 本机 5 并发 + 公网单张探针 + 5MB+1 上限 |
| `scripts/backup-restore-drill.sh` | 备份恢复 | dump → 临时库 → 行数/RLS 比对 → 删库 |
| `scripts/pilot-integrity-audit.sh` | 数据完整性 | 默认部门/悬空引用/重复/孤儿事件通知/SLA |
| `scripts/pilot-full-business-e2e.mjs` | 全流程集成 | 隔离 UAT 租户：公开报修→派单→处理→复核→评价 |
| `scripts/pilot-uat-all-modules-e2e.mjs` | 全模块 UAT | 16 模块闭环：工单/结算/巡检/巡更/资产/耗材/设备/应急/志愿者/优化/账号/反馈/运送/陪检等 |
| `docs/pilot-uat-checklist-20261111.md` | 真机 UAT | 登录/公开报修/派单/处理/复核/弱网/权限/签字 |

## 1. 本地/CI 必跑

```bash
cd youfu_backend_dev_v2
npm run typecheck
npm test
npm run release-gate

cd ../youfu_frontend_dev
npm test
```

### PC Playwright E2E

```bash
cd youfu_frontend_dev
cp .env.e2e.example .env.e2e.local
# 编辑 .env.e2e.local，填入 PILOT_ADMIN_PASSWORD / PILOT_WORKER_PASSWORD
npm run test:e2e:pc
```

默认使用本机 Edge（`channel=msedge`），无需下载 Chromium。
用例：

```text
中文医院名租户 → 400 提示 + 输入提示
正确租户 admin → 工作台
worker PC → 引导小程序
1 字标题 → 后端 400，页面显示“标题过短”
2 字标题“空调” → 建单成功页（route 拦截，不落真实工单）
pending_review 详情 → admin 看到审核通过/驳回/撤销
工单标题/描述 XSS → 按文本渲染，不执行
```

当前结果：`9 passed`。

`.env.e2e.local` 已被 `.env.*` 忽略；不要把密码提交到仓库。

当前基线（2026-11-11）：

```text
后端 203 文件 / 2449 用例
前端 30 文件 / 238 用例
PC Playwright 9 用例
Role / Media / Security / Perf / FullBusiness E2E
releaseGate 5/5 通过
```

## 2. 真实试点 E2E（ECS）

脚本会创建**临时师傅账号**（无微信 openid），不会给真实师傅发通知；结束时删除临时工单、账号、人员档案和上传文件。

```bash
cd /opt/youfu/pilot/backend
cp /path/to/scripts/pilot-role-action-e2e.mjs .
cp /path/to/scripts/pilot-media-e2e.mjs .

PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node pilot-role-action-e2e.mjs

PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node pilot-media-e2e.mjs
```

全流程集成（隔离 UAT 租户）：

```bash
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node scripts/pilot-full-business-e2e.mjs
```

全模块 UAT（隔离租户，16 模块闭环）：

```bash
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node scripts/pilot-uat-all-modules-e2e.mjs
```

成功输出：

```text
[role-e2e] PASS run=... orders=2
[media-e2e] PASS run=... uploads=3 photos=1 voice=1
[security-e2e] PASS run=... orders=2 files=1
[full] PASS tenant=uat-full-... order=...
```

### 安全脚本

```bash
cd /opt/youfu/pilot/backend
PGDATABASE=youfu_pilot ENV_FILE=.env \
  MAIN_WORKER_PASSWORD='<主站真实账号密码>' \
  /opt/node16/bin/node pilot-security-e2e.mjs
```

覆盖：

```text
主站 token 读 pilot 工单 → 401/403/404
pilot token 读主站工单 → 401/403/404
X-Tenant-Id 伪造 → 响应仍全是 pilot 租户
worker 读/改他人承接工单 → 403/404
worker 读联系人 PII / 统计 / 改角色权限 / 他人通知 → 403
worker 枚举人员档案 / 读他人档案 → 403
worker 创建通用业务流任务 → 403（flow.create 已移除）
内部工单 token 查公开我的报修 → 不返回该单
内部工单单号查公开状态 → 404
未认证读工单 → 401
篡改 JWT 签名 → 401
SQL 注入登录/筛选/租户 → 401/400，不 500
上传 org 路径穿越 → 400/404
上传 HTML → 415
上传文件名 ../../evil.png → 201 但 UUID 重命名、URL 在租户目录内
XSS 标题按原文入库（前端转义由 PC E2E 验证）
```

详细发现与残留风险见 `docs/pilot-security-report-20261111.md`。

### 性能脚本

```bash
cd /opt/youfu/pilot/backend

# 验收：20 单 / 10 并发
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node scripts/pilot-perf-e2e.mjs

# 压力：50 单 / 50 并发（延迟只记录，仍断言 5xx/重复单号/失败数）
PGDATABASE=youfu_pilot ENV_FILE=.env \
  PERF_CREATE_TOTAL=50 PERF_CONCURRENCY=50 PERF_STRESS=1 \
  /opt/node16/bin/node scripts/pilot-perf-e2e.mjs

# 1000 条列表
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node scripts/pilot-list-1000-e2e.mjs

# 5MB 上传
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node scripts/pilot-upload-5mb-e2e.mjs

# 备份恢复演练
bash scripts/backup-restore-drill.sh

# 数据完整性只读审计
bash scripts/pilot-integrity-audit.sh
```

24 小时 soak：

```bash
nohup env PGDATABASE=youfu_pilot ENV_FILE=.env \
  PERF_CREATE_TOTAL=1 PERF_CONCURRENCY=1 PERF_UPLOAD_TOTAL=0 \
  PERF_LIST_ROUNDS=3 PERF_DETAIL_ROUNDS=3 PERF_STATS_ROUNDS=3 \
  PERF_SOAK_SECONDS=86400 PERF_SOAK_INTERVAL_MS=1000 \
  /opt/node16/bin/node scripts/pilot-perf-e2e.mjs \
  > /opt/youfu/pilot/logs/soak-24h-$(date +%Y%m%d-%H%M%S).log 2>&1 &
```

正常结束自动清理；异常中止用：

```bash
bash scripts/pilot-perf-cleanup.sh <run-id>
```

结果见 `docs/pilot-perf-report-20261111.md`。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PILOT_TENANT` | `zixing-hospital` | 试点租户 |
| `PILOT_BASE_URL` | `http://127.0.0.1:4101` | 角色脚本 API 地址 |
| `PILOT_PUBLIC_BASE` | `https://youfu.banerz.cn/pilot` | 媒体脚本公网地址（覆盖 nginx） |
| `UPLOAD_DIR` | `/opt/youfu/pilot/uploads` | 试点上传根目录 |
| `PGDATABASE` | `youfu_pilot` | 试点库 |
| `ENV_FILE` | `.env` | 数据库/账号配置 |

### 角色脚本覆盖

```text
A 到场 200
A 开始处理 200
A 挂起（无原因）422
A 挂起（带 suspend_reason）200
A 恢复 200
A 取消 403
B 取消 403/404
A 提交复核 200
A 复核通过 403
A 复核退回 403
B 复核通过 403/404
admin 驳回 200
A 再次提交复核 200
admin 复核通过 200
admin 完成 200
admin 取消第二张单 200
```

### 媒体脚本覆盖

```text
1MB 图片上传 201 → 关联工单 200
4.5MB 图片上传 201（旧 nginx 1MB 限制会 413）
5MB+1 图片 413 TOO_LARGE（后端业务上限）
1MB 录音上传 201 → 关联工单 200
照片 + public_view_token 200 image/jpeg
录音 + public_view_token 200 audio/mpeg
无 token 401
错误 token 401
承接人保存 feedback_note 200
承接人改非白名单字段 403
非承接人保存备注 403/404
```

## 3. 真机 UAT（必须人工做）

### 师傅小程序

1. 扫最新 pilot 预览码；
2. 用 `17773639019 / lch1519033115` 登录，机构 `zixing-hospital`；
3. 打开一张 assigned/processing 工单；
4. 现场反馈：拍照上传、录音、保存备注；
5. 播放录音、预览照片；
6. 处理中挂起，必须填写原因；
7. 提交复核，确认只显示“已提交复核，等待管理员审核”，没有复核按钮；
8. 退出重进，确认照片/录音/备注仍在。

### PC 管理员

1. 用 `admin` 登录 `https://youfu.banerz.cn/pilot/`，租户 `zixing-hospital`；
2. 工单申报：标题填 2 字（如“空调”），描述“空调漏水”，提交；
3. 确认建单成功且自动派单；
4. 打开待审核工单，点「审核通过」/「驳回」；
5. 打开 processing 工单，点「撤销」并填原因；
6. 确认师傅账号 PC 登录 403。

### 微信通知

1. 师傅工作台点「开启通知」并允许；
2. 自检期望 `errcode:0`；
3. 真实派单后确认微信收到「工单处理通知」；
4. `43101` = 一次性授权用完，再点一次「开启通知」。

## 4. 测试数据与安全

- 自动化脚本只创建 `E2E-ROLE-*` / `E2E-MEDIA-*` 临时账号和 `ext.e2e_*` 标记工单；
- 失败也会执行清理；如异常中断，可按前缀清理：
  - 工单：`ext->>'e2e_role_matrix'` / `ext->>'e2e_media'`
  - 账号：`username LIKE 'e2e_role_%'` / `e2e_media_%`
  - 人员：`id LIKE 'E2E-ROLE-%'` / `E2E-MEDIA-%`
- 不要用真实师傅账号跑压测；
- 不要上传真实患者照片/录音做测试；
- 每次 destructive 测试前备份：

```bash
sudo -u postgres pg_dump -Fc youfu_pilot > /opt/youfu/backup/youfu_pilot-pre-test-$(date +%Y%m%d-%H%M%S).dump
```

## 5. 退出标准

- P0/P1 缺陷 = 0；
- 角色脚本 PASS；
- 媒体脚本 PASS；
- 真机照片/录音/备注/挂起/复核全部通过；
- PC 审核通过/驳回/撤销通过；
- 24 小时观察 5xx = 0；
- 备份恢复演练通过；
- 医院管理员/后勤/师傅三方 UAT 签字。
