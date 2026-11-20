# 主站切换演练记录（2026-11-08）

目的：在不碰现网 `youfu` 库 / 4001 服务的前提下，用主站真实数据验证
“新后端 → 110/111/115 → 112/113/114 → 新前端”的切换顺序。

## 1. 演练方式

1. `pg_dump youfu` → 恢复为独立库 `youfu_rehearsal`；
2. 授权 `youfu_app`；
3. 应用 `110_principal_rls.sql`、`111_department_model.sql`、`115_account_token_version.sql`；
4. 用当前新后端 `dist` 在 **4102** 端口连 `youfu_rehearsal` 启动（独立上传目录）；
5. 真 HTTP 登录 + 工作台 + 工单列表冒烟；
6. 再应用 `112_drop_service_desk.sql`、`113_evaluated_score_check.sql`、`114_drop_service_desk_agent.sql`；
7. 再冒烟；
8. 停止 4102、删除演练库与临时文件。

现网 `youfu` 库、4001 服务、主站前端全程未改。

## 2. 数据基线

- `youfu` 全库工单：65
- `t-verification` 工单：52
- 工作台切换前：
  - buckets：pending 8 / active 4 / done 24 / cancelled 16
  - timeout 12
  - `data_quality.evaluated_missing_score = 4`
- 主站历史：`service_desk`/`department` 全 NULL，4 张 evaluated 无分数。

## 3. 演练结果

### 110/111/115 + 新后端

- 登录 `t-verification` 成功；
- `/stats/workbench` total=52，buckets 与基线一致；
- `/open/work_orders` total=52，返回 `department_name`；
- `/basic-data/dept` 正常返回；
- 所有存量工单 `department_id` 已回填，无空值。

### 112/113/114 后

- `work_orders.service_desk` / `department` 列：0；
- `service_desk*` 表：0；
- evaluated 无分数：0（4 行按迁移还原为 completed，不伪造评分）；
- `t-verification` 工单仍为 52，无丢单；
- 工作台 buckets 不变，`data_quality.evaluated_missing_score = 0`；
- `/service-desks` → 404。

## 4. 结论

主站按以下顺序切换在当前代码上可执行，且不会丢单：

1. 备份 `youfu` 库 + `/opt/youfu/backend/dist` + `/opt/youfu/frontend-dist`；
2. 应用 `110`、`111`、`115`；
3. 部署新后端并重启 `youfu-backend`；
4. 应用 `112`、`113`、`114`；
5. 部署新 PC 前端；
6. 处理 8 个 `w_*` operator → worker，并让旧 JWT 过期/重登；
7. 切换后复核：工作台 total、buckets、工单列表、详情、登录。

## 5. 注意

- 112 必须在**新后端已接管**之后执行，旧后端仍读 `service_desk`/`department` 时会炸。
- 115 必须在新后端启动前应用（新登录要读取 `token_version`）。
- 主站仍是旧前端时不要先执行 112；旧前端会读旧字段。
- 演练库已删除，4102 已停止。
