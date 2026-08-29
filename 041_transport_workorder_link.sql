-- 041_transport_workorder_link.sql
-- P2 运送↔工单关联：transport_order 增加来源工单列。
-- 用途：工单可发起运送并回写关联，运送单详情/列表可回显关联工单。
-- 部署契约：以数据库属主（ECS 上 postgres）执行；youfu_app 为受 RLS 约束的非属主角色无权 ALTER 表。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 041_transport_workorder_link.sql
-- 幂等：全部 IF NOT EXISTS / 条件判断，可安全重跑。

ALTER TABLE transport_order
  ADD COLUMN IF NOT EXISTS work_order_id uuid;

-- work_orders.id 实际为 text 类型（非 uuid），JOIN 时 text=uuid 无隐式操作符会报错，
-- 故将本列对齐为 text，保证后端回显关联工单的 JOIN 正常（与 work_orders.id 同类型）。
ALTER TABLE transport_order
  ALTER COLUMN work_order_id TYPE text USING work_order_id::text;

-- 索引：按工单反查运送单（不影响 RLS，RLS 仍按 tenant_id 生效）
CREATE INDEX IF NOT EXISTS idx_transport_order_work_order_id
  ON transport_order (tenant_id, work_order_id);
