# pending-migrations

本目录存放**不应由自动迁移通道执行**的 SQL：

- `105_drop_service_desk_agent.sql`：删除 `service_desk_agent` 表，需观察期结束并人工批准；
- `108_drop_open_api_app_secret.sql`：删除 `open_api_app.app_secret` 明文列，需备份并人工执行；
- `legacy/053b_review_fixes.sql`、`legacy/053c_ugc_contribution.sql`：历史文件，已分别由仓根
  `106_review_fixes_additive.sql`、`107_ugc_contribution.sql` 取代。保留仅作追溯，不要再执行。

自动迁移入口只扫描仓根且只认 `<数字>_<名称>.sql`（见 `src/db/migrationFiles.ts`）。
本目录及子目录不会被扫描；把文件移入仓根前，必须确认它符合命名规范且确实是可自动执行的加法迁移。
