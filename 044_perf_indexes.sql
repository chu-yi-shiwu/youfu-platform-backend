-- 044_perf_indexes.sql
-- P-1 / P-4：work_orders 性能索引 + JSONB GIN。
-- 用途：
--   - (tenant_id, status, created_at DESC)：列表按状态过滤+时间倒序（repo/ticket.ts list / routes/workOrder.ts open 列表）。
--   - (tenant_id, created_at DESC)：看板/统计按租户全量时间倒序（无 status 过滤场景）。
--   - GIN(ext)：按 ext->>'source' 等 JSONB 内部键过滤加速。
-- 部署契约：以数据库属主（ECS 上 postgres）执行；youfu_app 为非属主无权 CREATE INDEX。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 044_perf_indexes.sql
-- 幂等：全部 IF NOT EXISTS，可安全重跑。

CREATE INDEX IF NOT EXISTS idx_work_orders_tenant_status_created
  ON work_orders (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_orders_tenant_created
  ON work_orders (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_orders_ext_gin
  ON work_orders USING gin (ext);

-- business_flow_tasks.data 同样加 GIN（P-4），主流已含 (tenant_id,entity_type,...) 复合索引。
CREATE INDEX IF NOT EXISTS idx_business_flow_data_gin
  ON business_flow_tasks USING gin (data);
