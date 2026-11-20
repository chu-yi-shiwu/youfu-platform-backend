# pilot 备份恢复演练记录 · 2026-11-20

## 1. 演练目标

在不占用生产维护窗口、不影响 `youfu_pilot` 在线服务的前提下，验证：

1. 当前自动备份可完整恢复；
2. 恢复库的表结构、迁移登记、RLS 策略与源库一致；
3. 关键业务表数据与备份时点一致；
4. RLS 租户隔离在恢复库仍然生效；
5. 上传附件包完整可读；
6. 演练结束后临时库清理干净。

## 2. 备份

- 脚本：`/opt/youfu/pilot/scripts/backup_pilot.sh`
- cron：每日 `03:17`
- 演练前手动生成当前备份：
  - 数据库：`/opt/youfu/pilot/backup/youfu_pilot_20261120_214730.sql.gz`（2.8 MB）
  - 附件：`/opt/youfu/pilot/backup/uploads_20261120_214730.tar.gz`（892 KB）
- `gzip -t` 数据库与附件包均通过。

## 3. 恢复

- 临时库：`youfu_pilot_restore_drill`，`TEMPLATE template0`
- 恢复方式：`gunzip -c <backup>.sql.gz | psql -d youfu_pilot_restore_drill`
- 恢复退出码：`0`
- 恢复后库大小：`17 MB`
- 恢复日志：`/tmp/pilot_restore_drill.log`

## 4. 一致性核对

| 指标 | 源库 `youfu_pilot` | 恢复库 | 结论 |
| --- | --- | --- | --- |
| public 表数 | 97 | 97 | 一致 |
| RLS 策略数 | 90 | 90 | 一致 |
| `_migrations` 行数 | 131 | 131 | 一致 |
| `127_module_authorization.sql` 登记 | 1 | 1 | 一致 |
| `tenant_registry` | 2 | 2 | 一致 |
| `account_user` | 3 | 3 | 一致 |
| `dept` | 3 | 3 | 一致 |
| `worker` | 21 | 21 | 一致 |
| `work_orders` | 5 | 5 | 一致 |
| `workflow_def` | 1 | 1 | 一致 |
| `domain_event` | 91 | 91 | 一致 |
| `settlement` | 1 | 1 | 一致 |
| `asset` | 2 | 2 | 一致 |
| `volunteer_activity` | 3 | 3 | 一致 |
| 最新工单时间 | `2026-11-17 20:49:02.91495+08` | 同左 | 一致 |
| 最新领域事件时间 | `2026-11-17 22:11:09.53155+08` | 同左 | 一致 |

`tenant_module` / `department_module` 在源库和恢复库均为 0 行（默认全开），表结构已恢复。

## 5. RLS 验证

以 `youfu_app` 角色连接恢复库：

```sql
SET ROLE youfu_app;
SELECT set_config('app.tenant_id','zixing-hospital',false),
       set_config('app.scope','tenant',false);
```

| 查询 | 源库 | 恢复库 |
| --- | --- | --- |
| 本租户 `work_orders` | 5 | 5 |
| 本租户 `account_user` | 3 | 3 |
| 切换到 `not-a-tenant` 后 `work_orders` | 0 | 0 |

说明恢复库的 RLS 策略、租户隔离函数与权限均可用。

## 6. 附件验证

- `uploads_20261120_214730.tar.gz` `gzip -t` 通过；
- 包内普通文件数：6；
- 源目录 `/opt/youfu/pilot/uploads` 普通文件数：6；
- 数量一致。

## 7. 清理

- `DROP DATABASE youfu_pilot_restore_drill` 成功；
- `pg_database` 中 `youfu_pilot_restore%` 残留：0；
- 生产库未执行任何恢复/删除操作。

## 8. 限制与结论

本次为**非侵入式恢复演练**：未启动第二套应用进程，避免与生产实例重复运行巡检/SLA/模板效果/模型训练调度器。已覆盖数据库结构、迁移登记、关键数据、RLS 和附件完整性。

结论：pilot 当前自动备份可恢复到独立临时库，结构与数据一致，RLS 生效，附件完整，清理无残留。P0-4 的非侵入式恢复验证完成；如后续要求“应用切流恢复”演练，可在维护窗口内追加一次。
