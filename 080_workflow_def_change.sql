-- 080_workflow_def_change.sql —— 流程配置「提交→审核」一期（2026-09-12《优服家_流程配置审核设计》§3）。
-- 说明：设计文档草案编号 066，落盘时 066~079 已被既有迁移占用，按序列惯例顺延为 080（内容与草案一致）。
--
-- 1) 新表 workflow_def_change：每租户每业务流至多一条在途变更（UNIQUE）。
--    状态机：draft → submitted → live（approve 唯一写 live 边，复用 saveWorkflowDef）/ submitted → draft（驳回）。
--    live 表 workflow_def 零改动 = 10+ 读路径零风险；approve 成功后删除本行
--    （审计由 workflow_def_history 快照 reason='approve' 承担；驳回 status 回 draft + reject_comment）。
-- 2) RLS 租户隔离 + youfu_app GRANT（含 sequence）。
-- 3) 附带防御段：role_permission.role CHECK 六角色一致性（070 已修；此处幂等收敛为防御性重申，
--    已一致则跳过，独立段落可单独回退）。
-- 幂等可重跑（重跑收敛到同一终态）；索引谓词不含 now()（plain btree，无易变函数）。
-- DDL 须以 superuser(postgres) 执行：
--   sudo -u postgres psql youfu -f 080_workflow_def_change.sql

-- ============ 1) 在途变更表 ============
CREATE TABLE IF NOT EXISTS workflow_def_change (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL,
  entity_type   text NOT NULL,
  def           jsonb NOT NULL,
  note          text,                          -- 变更说明（提交人填写）
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','submitted')),
  base_version  int  NOT NULL,                 -- 提交时的 live 版本，approve 时防脏写（409 DRAFT_STALE）
  created_by    text,
  submitted_by  text,
  submitted_at  timestamptz,
  reject_comment text,                         -- 最近一次驳回意见（驳回时回填，status 回 draft）
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type)
);

ALTER TABLE workflow_def_change ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_def_change_tenant_isolation ON workflow_def_change;
CREATE POLICY workflow_def_change_tenant_isolation ON workflow_def_change
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_def_change TO youfu_app;
GRANT USAGE, SELECT ON SEQUENCE workflow_def_change_id_seq TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_wfdchg_tenant_status ON workflow_def_change (tenant_id, status);

-- ============ 2) 附带防御段：role_permission.role CHECK 六角色（070 已修，防御性重申） ============
-- 背景：046 建表时 role_permission.role CHECK 内联仅含 4 角色，070 已放宽为 6 角色。
-- 本段做成「已一致则跳过」的幂等防御块：正常库重跑为 no-op；若某环境缺 070 则自动收敛到六角色终态。
-- 独立段落、独立说明，出问题可单独回退本段（不动第 1 段）。
DO $$
DECLARE
  con text;
  target_def text;
  already_ok boolean;
BEGIN
  -- 目标定义（与 070 同款写法）：6 角色放行
  target_def := 'CHECK (role = ANY (ARRAY[''admin''::text, ''operator''::text, ''dispatcher''::text, ''worker''::text, ''reviewer''::text, ''service_desk''::text]))';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'role_permission'::regclass AND contype = 'c'
      AND conname = 'role_permission_role_check'
      AND regexp_replace(pg_get_constraintdef(oid), '[\s(),]', '', 'g')
          = regexp_replace(target_def, '[\s(),]', '', 'g')
  ) INTO already_ok;

  IF already_ok THEN
    RAISE NOTICE 'role_permission_role_check 已存在且定义一致（6 角色），跳过';
  ELSE
    FOR con IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'role_permission'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%admin%'
    LOOP
      EXECUTE format('ALTER TABLE role_permission DROP CONSTRAINT %I', con);
    END LOOP;
    ALTER TABLE role_permission ADD CONSTRAINT role_permission_role_check
      CHECK (role = ANY (ARRAY[
        'admin'::text, 'operator'::text, 'dispatcher'::text, 'worker'::text,
        'reviewer'::text, 'service_desk'::text
      ]));
    RAISE NOTICE 'role_permission.role CHECK 已放宽为 6 角色';
  END IF;
END $$;
