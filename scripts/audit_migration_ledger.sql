-- 账实判定器（只读，仅 SELECT）—— 判定「磁盘有文件但 _migrations 未记账」的迁移到底应用了没有。
-- 背景：生产 _migrations 记账与磁盘迁移文件不一致（075~083 有文件无记账，090~096 有记账无文件），
--       直接跑 migrate-as-owner.sh 会把 075~083 重跑一遍（含回填类迁移 ⇒ 重复写）。
-- 用法：ssh root@<ecs> "cd /tmp && sudo -u postgres psql -d youfu -f -" < scripts/audit_migration_ledger.sql
-- 判定口径：一个迁移的**全部**产物都在 ⇒ applied=true；任一产物缺失 ⇒ 部分应用/未应用。
-- 内置对照组（防假锚）：
--   073/074 已记账且必已应用 → 必须 true（判 false 说明探测器坏了）
--   999_probe_nonexistent 纯虚构 → 必须 false（判 true 说明探测器恒真）

WITH checks AS (
  -- ---- 对照组（必 true）----
  SELECT '073' AS m, 'label_dict' AS obj,
         EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'label_dict') AS ok
  -- 074 建的里程碑列挂在 work_orders（复数）上；此前误写成 work_order 导致对照组假 false
  UNION ALL SELECT '074', 'work_orders.accepted_at',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'work_orders' AND column_name = 'accepted_at')
  UNION ALL SELECT '074', 'work_orders.rated_at',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'work_orders' AND column_name = 'rated_at')
  -- ---- 对照组（必 false，纯虚构）----
  UNION ALL SELECT '999', 'zzz_no_such_table_probe',
         EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'zzz_no_such_table_probe')

  -- ---- 待判定：075 ~ 083（磁盘有文件、_migrations 无记账）----
  UNION ALL SELECT '075', 'business_type_dict',
         EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'business_type_dict')
  UNION ALL SELECT '075', 'fault_category.business_type',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'fault_category' AND column_name = 'business_type')
  UNION ALL SELECT '076', 'transport_order.sla_due_at',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'transport_order' AND column_name = 'sla_due_at')
  UNION ALL SELECT '076', 'transport_order.escalated_at',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'transport_order' AND column_name = 'escalated_at')
  UNION ALL SELECT '077', 'invite_codes',
         EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'invite_codes')
  UNION ALL SELECT '078', 'trial_applications',
         EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'trial_applications')
  UNION ALL SELECT '079', 'tenant_registry.status_check_pending',
         EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                 WHERE t.relname = 'tenant_registry' AND c.conname = 'tenant_registry_status_check'
                   AND pg_get_constraintdef(c.oid) ILIKE '%pending%')
  UNION ALL SELECT '080', 'workflow_def_change',
         EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'workflow_def_change')
  UNION ALL SELECT '080', 'workflow_def_change.rls',
         EXISTS (SELECT 1 FROM pg_class WHERE relname = 'workflow_def_change' AND relrowsecurity)
  UNION ALL SELECT '081', 'volunteer_record.check_in_late',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'volunteer_record' AND column_name = 'check_in_late')
  UNION ALL SELECT '082', 'account_user.phone',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'account_user' AND column_name = 'phone')
  UNION ALL SELECT '082', 'idx_account_phone_unique',
         EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_account_phone_unique')
  UNION ALL SELECT '083', 'volunteer_activity.user_id',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'volunteer_activity' AND column_name = 'user_id')
  UNION ALL SELECT '083', 'volunteer_activity.signup_deadline',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'volunteer_activity' AND column_name = 'signup_deadline')
  UNION ALL SELECT '083', 'volunteer_activity.description',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'volunteer_activity' AND column_name = 'description')
)
SELECT m AS migration,
       bool_and(ok)                                   AS applied,
       count(*)                                       AS probes,
       count(*) FILTER (WHERE NOT ok)                 AS missing,
       coalesce(string_agg(obj, ', ') FILTER (WHERE NOT ok), '-') AS missing_objects
FROM checks
GROUP BY m
ORDER BY m;
