-- 051_e1_effectiveness.sql —— 批次 E1：完整监察（效能指数 V5 + 达标基线 R10 数据源）。
-- 扩展 platform_tenant_summary()：在 E_min 聚合之上加「服务效能指数」（跨租户去标识化合成指标）：
--   close_rate   闭环率（closed / total）
--   overdue_rate 超时率（timeout / total）
--   eff_index    效能指数 = close_rate*0.5 + (1-overdue_rate)*0.3 + (satisfaction/5)*0.2（无数据 → null）
-- 基线阈值由后端常量提供（platform.ts：闭环>=80%、超时<=10%、满意度>=4.0），不在 SQL 硬编码（可配）。
-- CREATE OR REPLACE 幂等；须 superuser 执行（返回类型变更须先 DROP，建议单事务）：
--   sudo -u postgres psql -d youfu -1 -v ON_ERROR_STOP=1 -f 051_e1_effectiveness.sql

-- 返回类型由 OUT 参数变更，CREATE OR REPLACE 不支持改返回类型 → 必须先 DROP（同一事务内重建，无窗口）
DROP FUNCTION IF EXISTS platform_tenant_summary();

CREATE OR REPLACE FUNCTION platform_tenant_summary()
RETURNS TABLE (
  tenant_id text,
  total           int,
  closed          int,
  cancelled       int,
  pending         int,
  processing      int,
  timeout         int,
  satisfaction_avg numeric,
  satisfaction_count int,
  close_rate      numeric,
  overdue_rate    numeric,
  eff_index       numeric
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT tenant_id,
    count(*)::int                                                                  AS total,
    count(*) FILTER (WHERE status IN ('completed','closed','evaluated'))::int      AS closed,
    count(*) FILTER (WHERE status = 'cancelled')::int                              AS cancelled,
    count(*) FILTER (WHERE status IN ('created','assigned','claim_hall','pending_dispatch','pending_accept'))::int AS pending,
    count(*) FILTER (WHERE status IN ('processing','transporting','accompanying','auditing','review','paused','suspended','pending_review','review_passed'))::int AS processing,
    count(*) FILTER (WHERE status NOT IN ('completed','closed','evaluated','cancelled')
                      AND sla_due_at IS NOT NULL AND sla_due_at < now())::int      AS timeout,
    AVG(satisfaction_score)::numeric(3,2)                                          AS satisfaction_avg,
    COUNT(satisfaction_score)::int                                                 AS satisfaction_count,
    CASE WHEN count(*) > 0
         THEN round((count(*) FILTER (WHERE status IN ('completed','closed','evaluated')))::numeric / count(*), 4)
         ELSE NULL END                                                             AS close_rate,
    CASE WHEN count(*) > 0
         THEN round((count(*) FILTER (WHERE status NOT IN ('completed','closed','evaluated','cancelled')
                      AND sla_due_at IS NOT NULL AND sla_due_at < now()))::numeric / count(*), 4)
         ELSE NULL END                                                             AS overdue_rate,
    CASE WHEN count(*) > 0 AND AVG(satisfaction_score) IS NOT NULL
         THEN round(
                (count(*) FILTER (WHERE status IN ('completed','closed','evaluated')))::numeric / count(*) * 0.5
                + (1 - (count(*) FILTER (WHERE status NOT IN ('completed','closed','evaluated','cancelled')
                      AND sla_due_at IS NOT NULL AND sla_due_at < now()))::numeric / count(*)) * 0.3
                + AVG(satisfaction_score) / 5 * 0.2,
                4)
         ELSE NULL END                                                             AS eff_index
  FROM work_orders
  GROUP BY tenant_id;
$$;
