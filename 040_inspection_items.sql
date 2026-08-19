-- 040_inspection_items.sql —— 补齐巡检「检查项/巡检内容」缺口（方案 B 标准版）。
-- 这是全模块深度审计发现的真缺失项（巡检单只有 title/point，无「检查什么/查到什么」）。
-- 新增：
--   1) inspection_item 检查项模板（租户级、可按点位归类）：名称 / 类型[是否|数值|文本] / 标准值 / 单位
--   2) inspection_record 巡检单↔检查项实测（实测值 / 是否合格 / 照片 / 备注），与巡检单强关联
--   3) inspection_task.items_json jsonb 快照：创建/执行巡检单时把选定模板 + 空实测框快照进单，
--      保证「巡检单即一份待填清单」，前端按 items_json 逐项渲染录入，完成后回填实测
-- 全部 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS 幂等，可重复执行；与线上 DB 现状对齐，保证全新库可复现部署。
-- 本迁移为 DDL，须以 superuser(postgres) 执行（youfu_app 无 DDL 权）：
--   PGPASSWORD=youfu2026 psql -U postgres -h 127.0.0.1 -p 5432 -d youfu -f 040_inspection_items.sql

-- ============ inspection_item 检查项模板 ============
CREATE TABLE IF NOT EXISTS inspection_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  name            text NOT NULL,                                 -- 检查项名称，如「灭火器压力是否正常」
  type            text NOT NULL DEFAULT 'bool'
                  CHECK (type IN ('bool','number','text')),      -- bool=是否合格 / number=数值实测 / text=文本描述
  standard_value  text,                                          -- 标准值（number 类型用，如「0.4」；bool 可空；text 可空）
  unit            text,                                          -- 单位（number 类型用，如「MPa」）
  category        text,                                          -- 归类/分组（可填「消防」「配电」等，便于模板管理）
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inspection_item ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inspection_item_tenant_isolation ON inspection_item;
CREATE POLICY inspection_item_tenant_isolation ON inspection_item
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_item TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_inspection_item_tenant ON inspection_item (tenant_id);

-- ============ inspection_record 实测记录 ============
CREATE TABLE IF NOT EXISTS inspection_record (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  task_id      uuid NOT NULL REFERENCES inspection_task(id) ON DELETE CASCADE,
  item_id      uuid NOT NULL REFERENCES inspection_item(id) ON DELETE RESTRICT,
  actual_value text,                                             -- 实测值（bool→'pass'/'fail'；number→数字串；text→描述）
  passed       boolean,                                          -- 是否合格（null=未判定）
  photo        text,                                             -- 现场照片 URL（可选）
  remark       text,                                             -- 该项备注/异常说明
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inspection_record ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inspection_record_tenant_isolation ON inspection_record;
CREATE POLICY inspection_record_tenant_isolation ON inspection_record
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_record TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_inspection_record_task ON inspection_record (tenant_id, task_id);
-- 同一巡检单下每个检查项只保留一条实测（UPSERT 用），避免重复录入。
ALTER TABLE inspection_record DROP CONSTRAINT IF EXISTS uq_inspection_record_task_item;
ALTER TABLE inspection_record ADD CONSTRAINT uq_inspection_record_task_item UNIQUE (tenant_id, task_id, item_id);

-- ============ inspection_task.items_json 快照列 ============
-- 存放「本次巡检要填的检查项清单」快照：[{item_id, name, type, standard_value, unit, category, actual_value, passed, photo, remark}]
-- 创建自由/计划巡检单或由计划生成实例时写入（不含实际值），前端按此逐项渲染录入；完成后回填实测并写 inspection_record。
ALTER TABLE inspection_task ADD COLUMN IF NOT EXISTS items_json jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 周期计划可绑定「该计划每次生成的巡检单要带哪些检查项」，下次生成实例时自动 seed 进 items_json。
ALTER TABLE inspection_plan ADD COLUMN IF NOT EXISTS item_ids uuid[] NOT NULL DEFAULT '{}';
