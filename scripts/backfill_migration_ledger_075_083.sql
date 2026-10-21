-- 补记账 075~083（**写操作，需初一显式授权后才可执行**）
-- 前提：scripts/audit_migration_ledger.sql 判定这 9 个迁移的产物**全部已存在**（applied=true），
--       只是 _migrations 缺记账 ⇒ 任何人跑 migrate-as-owner.sh 都会把它们重跑一遍。
--
-- ⚠️ 诚实标注（E4 不伪造数据）：本脚本写入的 applied_at = now()（执行时刻），
--    **不是**真实应用时间。真实应用时间落在 2026-09-06 23:26 ~ 2026-09-14 04:40 之间
--    （相邻两侧记账时间戳），精确到秒的时间已不可考，故不编造。
--
-- 风险：🟡 低-中。075~083 全为纯 DDL 且 IF NOT EXISTS 幂等，无 INSERT/UPDATE/DELETE，
--       重跑不会重复写数据；仅 079（DROP+ADD 约束）与 082（DROP+CREATE UNIQUE INDEX）会在重跑时短暂重建。
--
-- 回滚（如需撤销补记账）：
--   DELETE FROM _migrations WHERE name IN ('075_intake_business_types.sql', ... ,'083_volunteer_activity_v2.sql');
--
-- 执行（ECS，postgres 身份）：
--   ssh root@8.136.107.153 "cd /tmp && sudo -u postgres psql -d youfu -f -" < scripts/backfill_migration_ledger_075_083.sql

INSERT INTO _migrations (name) VALUES
  ('075_intake_business_types.sql'),
  ('076_transport_sla.sql'),
  ('077_invite_codes.sql'),
  ('078_trial_applications.sql'),
  ('079_tenant_registry_pending.sql'),
  ('080_workflow_def_change.sql'),
  ('081_volunteer_checkin_late.sql'),
  ('082_account_phone.sql'),
  ('083_volunteer_activity_v2.sql')
ON CONFLICT DO NOTHING;

-- 校验（预期 9 行，且 075~083 连续无缺口）
SELECT count(*) AS ledger_rows FROM _migrations;
