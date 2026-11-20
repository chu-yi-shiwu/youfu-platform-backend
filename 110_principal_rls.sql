-- 110_principal_rls.sql —— 从“租户隔离”扩展到“租户 + 本人范围”的 RLS。
--
-- 背景（2026-11-08 根治）：
--   - 全仓 275 处直接 SQL 查 work_orders，事件/照片/语音/运送单多处没有行可见性；
--   - 按端点加 assertWorkOrderVisible 是补丁，新端点仍会漏；
--   - 本系统已有 RLS 租户隔离，直接扩展为“租户 + 请求级 scope”是结构性修复。
--
-- 请求级变量（由 withTenantClient SET LOCAL，见 src/db/pool.ts）：
--   app.scope       tenant | self | system
--   app.user_id     account_user.id
--   app.worker_ids  逗号分隔的 worker.id（self 时）
--   app.claim_hall  1 = 当前事务允许看未分派单（仅抢单大厅/认领）
--
-- 自动派单/退回重派会改 assignee 给别人：PostgreSQL 的 UPDATE 新行还要过 SELECT 策略，
-- 因此这两段受信系统动作在事务内临时切 app.scope='system'（见 withTenantScope），
-- 不新增“dispatch”能力去放宽 READ。
--
-- 安全默认：没有设置 app.scope 时按 self（空 worker_ids）处理，fail-closed。
-- 执行：sudo -u postgres psql -d <db> -v ON_ERROR_STOP=1 -f 110_principal_rls.sql

-- ============ 请求级变量读取函数 ============
CREATE OR REPLACE FUNCTION app_scope() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.scope', true), ''), 'self')
$$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app_worker_ids() RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN current_setting('app.worker_ids', true) IS NULL
      OR current_setting('app.worker_ids', true) = ''
    THEN ARRAY[]::text[]
    ELSE string_to_array(current_setting('app.worker_ids', true), ',')
  END
$$;

CREATE OR REPLACE FUNCTION app_claim_hall() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.claim_hall', true), '0') = '1'
$$;

GRANT EXECUTE ON FUNCTION app_scope() TO youfu_app;
GRANT EXECUTE ON FUNCTION app_user_id() TO youfu_app;
GRANT EXECUTE ON FUNCTION app_worker_ids() TO youfu_app;
GRANT EXECUTE ON FUNCTION app_claim_hall() TO youfu_app;

-- ============ work_orders ============
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_by text;
COMMENT ON COLUMN work_orders.created_by IS '创建人 account_user.id；RLS 允许创建人看到自己刚建的单';

CREATE INDEX IF NOT EXISTS idx_wo_tenant_assignee ON work_orders(tenant_id, assignee_id);
CREATE INDEX IF NOT EXISTS idx_wo_tenant_created_by ON work_orders(tenant_id, created_by);

ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS work_orders_tenant_isolation ON work_orders;
DROP POLICY IF EXISTS work_orders_select ON work_orders;
DROP POLICY IF EXISTS work_orders_insert ON work_orders;
DROP POLICY IF EXISTS work_orders_update ON work_orders;
DROP POLICY IF EXISTS work_orders_delete ON work_orders;

CREATE POLICY work_orders_select ON work_orders
  FOR SELECT TO youfu_app
  USING (
    tenant_id = app_tenant_id()
    AND (
      app_scope() IN ('tenant', 'system')
      OR assignee_id = ANY(app_worker_ids())
      OR (
        app_user_id() <> ''
        AND created_by = app_user_id()
        AND (assignee_id IS NULL OR assignee_id = ANY(app_worker_ids()))
      )
      OR (app_claim_hall() AND assignee_id IS NULL)
    )
  );

CREATE POLICY work_orders_insert ON work_orders
  FOR INSERT TO youfu_app
  WITH CHECK (
    tenant_id = app_tenant_id()
    AND (
      app_scope() IN ('tenant', 'system')
      OR (
        app_user_id() <> ''
        AND created_by = app_user_id()
        AND (assignee_id IS NULL OR assignee_id = ANY(app_worker_ids()))
      )
    )
  );

CREATE POLICY work_orders_update ON work_orders
  FOR UPDATE TO youfu_app
  USING (
    tenant_id = app_tenant_id()
    AND (
      app_scope() IN ('tenant', 'system')
      OR assignee_id = ANY(app_worker_ids())
      OR (
        app_user_id() <> ''
        AND created_by = app_user_id()
        AND (assignee_id IS NULL OR assignee_id = ANY(app_worker_ids()))
      )
      OR (app_claim_hall() AND assignee_id IS NULL)
    )
  )
  WITH CHECK (
    tenant_id = app_tenant_id()
    AND (
      app_scope() IN ('tenant', 'system')
      OR assignee_id = ANY(app_worker_ids())
      OR (
        app_user_id() <> ''
        AND created_by = app_user_id()
        AND assignee_id IS NULL
      )
    )
  );

CREATE POLICY work_orders_delete ON work_orders
  FOR DELETE TO youfu_app
  USING (tenant_id = app_tenant_id() AND app_scope() IN ('tenant', 'system'));

-- ============ ticket_event ============
-- 事件可见性跟父工单走：父单不可见，事件也不可见。
-- 注意：子查询里的 work_orders 会再次套用上面的 work_orders RLS，不递归到 ticket_event。
ALTER TABLE ticket_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_event_tenant_isolation ON ticket_event;
DROP POLICY IF EXISTS ticket_event_select ON ticket_event;
DROP POLICY IF EXISTS ticket_event_insert ON ticket_event;
DROP POLICY IF EXISTS ticket_event_modify ON ticket_event;

CREATE POLICY ticket_event_select ON ticket_event
  FOR SELECT TO youfu_app
  USING (
    tenant_id = app_tenant_id()
    AND EXISTS (
      SELECT 1 FROM work_orders wo
      WHERE wo.id = ticket_event.work_order_id
        AND wo.tenant_id = ticket_event.tenant_id
    )
  );

CREATE POLICY ticket_event_insert ON ticket_event
  FOR INSERT TO youfu_app
  WITH CHECK (
    tenant_id = app_tenant_id()
    AND EXISTS (
      SELECT 1 FROM work_orders wo
      WHERE wo.id = ticket_event.work_order_id
        AND wo.tenant_id = ticket_event.tenant_id
    )
  );

CREATE POLICY ticket_event_modify ON ticket_event
  FOR UPDATE TO youfu_app
  USING (tenant_id = app_tenant_id() AND app_scope() IN ('tenant', 'system'))
  WITH CHECK (tenant_id = app_tenant_id() AND app_scope() IN ('tenant', 'system'));

DROP POLICY IF EXISTS ticket_event_delete ON ticket_event;
CREATE POLICY ticket_event_delete ON ticket_event
  FOR DELETE TO youfu_app
  USING (tenant_id = app_tenant_id() AND app_scope() IN ('tenant', 'system'));

-- ============ transport_order ============
ALTER TABLE transport_order ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_transport_tenant_carrier ON transport_order(tenant_id, carrier);

DROP POLICY IF EXISTS transport_order_tenant_isolation ON transport_order;
DROP POLICY IF EXISTS transport_order_select ON transport_order;
DROP POLICY IF EXISTS transport_order_insert ON transport_order;
DROP POLICY IF EXISTS transport_order_update ON transport_order;
DROP POLICY IF EXISTS transport_order_delete ON transport_order;

CREATE POLICY transport_order_select ON transport_order
  FOR SELECT TO youfu_app
  USING (
    tenant_id = app_tenant_id()
    AND (
      app_scope() IN ('tenant', 'system')
      OR carrier = ANY(app_worker_ids())
      OR (app_claim_hall() AND carrier IS NULL)
    )
  );

CREATE POLICY transport_order_insert ON transport_order
  FOR INSERT TO youfu_app
  WITH CHECK (tenant_id = app_tenant_id() AND app_scope() IN ('tenant', 'system'));

CREATE POLICY transport_order_update ON transport_order
  FOR UPDATE TO youfu_app
  USING (
    tenant_id = app_tenant_id()
    AND (
      app_scope() IN ('tenant', 'system')
      OR carrier = ANY(app_worker_ids())
      OR (app_claim_hall() AND carrier IS NULL)
    )
  )
  WITH CHECK (
    tenant_id = app_tenant_id()
    AND (app_scope() IN ('tenant', 'system') OR carrier = ANY(app_worker_ids()))
  );

CREATE POLICY transport_order_delete ON transport_order
  FOR DELETE TO youfu_app
  USING (tenant_id = app_tenant_id() AND app_scope() IN ('tenant', 'system'));
