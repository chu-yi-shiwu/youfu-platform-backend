-- 068_basic_data_updated_at.sql —— M0-1 / D1 修复（B 件）：为 047 建的 4 张基础数据表补 updated_at 列。
--
-- 根因（2026-09-03 上线前全量审查 D-07，主报告五病灶之一）：
--   src/routes/basicData.ts:278 更新路径无条件拼 `updated_at = now()`，
--   但 047_basic_data_consolidate.sql 建的 equipment_brand / priority_dict / sla_policy /
--   work_order_template 四表均无 updated_at 列 → 这 4 类基础数据「编辑」操作 100% 必现
--   `column "updated_at" does not exist` → 422/500，基础数据编辑功能全瘫痪。
--
-- 修复原则（审查铁律）：
--   ① 只补列，绝不反向改表删列对齐 047——equipment_type 在生产由 035 定义
--      （7 列含 updated_at + UNIQUE(tenant_id,code)，035 先于 047 执行，047 IF NOT EXISTS 静默跳过），
--      任何「对齐 047」的操作都会破坏生产真实 schema。
--   ② 全部 ADD COLUMN IF NOT EXISTS 幂等，可重复执行。
--   ③ DEFAULT now() + NOT NULL：PG11+ 元数据级变更，无全表重写，存量行回填为建列时刻。
--
-- 部署契约（铁律）：DDL 必须以数据库属主(postgres) 身份执行，youfu_app 无权 ALTER：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 068_basic_data_updated_at.sql
--
-- 验收断言（执行后必跑）：
--   SELECT table_name, column_name FROM information_schema.columns
--    WHERE table_name IN ('equipment_brand','priority_dict','sla_policy','work_order_template','equipment_type')
--      AND column_name='updated_at' ORDER BY table_name;
--   预期：恰好 5 行（4 张补列表 + equipment_type 既有列）。

ALTER TABLE equipment_brand       ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE priority_dict         ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sla_policy            ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE work_order_template   ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- equipment_type 生产定义（035）已含 updated_at，此处仅作兜底幂等保护：
-- 若某环境因迁移顺序异常缺列（正常不应发生），补齐；正常环境为 no-op。
ALTER TABLE equipment_type        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
