-- 优服家 试点上线冲刺 · t-verification 种子数据
-- 目的：在真实租户上构造 16 工单全生命周期(domain_event) + work_orders 行，
--        并写入 4 态基线 workflow_def，供"过程挖掘→优化建议→改写流程定义"闭环演示。
-- 设计：10 简单路径 + 6 返工路径(偏离率=6/16=0.375>0.3→触发 recheck_gate)；
--        assign→processing ≈ 10h-2min ≈ 598min(>480→触发 auto_escalate)。
-- 运行：sudo -u postgres psql -d youfu -f (超级用户绕过 RLS)

BEGIN;

-- 1) 清理残留（t-verification 与 t-demo-pm 的 E2E 痕迹）
DELETE FROM domain_event        WHERE tenant_id = 't-verification';
DELETE FROM work_orders         WHERE tenant_id = 't-verification';
DELETE FROM optimization_feedback WHERE tenant_id = 't-verification';
DELETE FROM workflow_def        WHERE tenant_id = 't-verification';
DELETE FROM domain_event        WHERE tenant_id = 't-demo-pm';
DELETE FROM work_orders         WHERE tenant_id = 't-demo-pm';
DELETE FROM optimization_feedback WHERE tenant_id = 't-demo-pm';
DELETE FROM workflow_def        WHERE tenant_id = 't-demo-pm';
DELETE FROM system_config       WHERE tenant_id = 't-verification';

-- 0) 租户品牌配置（顶部租户名 + 服务热线）
INSERT INTO system_config (tenant_id, key, value) VALUES
  ('t-verification', 'brand_name', '长沙市第四医院'),
  ('t-verification', 'hotline',    '0731-85536356');

-- 2) 基线 workflow_def（4 态，飞轮改写前后对照用）
INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES (
  't-verification', 'work_order',
  '{"initial":"draft","states":["draft","assigned","processing","completed"],"transitions":[{"from":"draft","to":"assigned","event":"assign"},{"from":"assigned","to":"processing","event":"start"},{"from":"processing","to":"completed","event":"complete"}],"config":{}}'::jsonb,
  1
);

-- 3) 16 工单 work_orders 行（状态均为终态 completed，时间分布在过去 ~21 天）
WITH cases AS (
  SELECT
    g AS i,
    'PILOT-WO-' || lpad(g::text, 3, '0') AS eid,
    (ARRAY['electric','water','hvac','network','elevator','lighting','security','plumbing'])[(g-1) % 8 + 1] AS bt,
    'PL2026-' || lpad(g::text, 4, '0') AS ono,
    (g % 8 IN (0,6,7)) AS rework,
    now() - (21 - g) * interval '1 day' - (g * 37 % 13) * interval '1 hour' AS t0
  FROM generate_series(1,16) g
)
INSERT INTO work_orders (id, tenant_id, business_type, priority, status, auto_flow, assets, created_at, updated_at, order_no)
SELECT eid, 't-verification', bt, 'normal', 'completed', true, '[]'::jsonb, t0, t0 + interval '12 hours', ono
FROM cases;

-- 4) 全生命周期 domain_event（统一事件总线 = 过程挖掘唯一数据源）
WITH cases AS (
  SELECT
    g AS i,
    'PILOT-WO-' || lpad(g::text, 3, '0') AS eid,
    (g % 8 IN (0,6,7)) AS rework,
    now() - (21 - g) * interval '1 day' - (g * 37 % 13) * interval '1 hour' AS t0
  FROM generate_series(1,16) g
),
ev (eid, type, actor, ts) AS (
  SELECT eid, 'create',     'system',        t0 FROM cases
  UNION ALL
  SELECT eid, 'assigned',   'auto_dispatch', t0 + interval '2 minutes' FROM cases
  UNION ALL
  SELECT eid, 'processing', 'worker',        t0 + interval '10 hours' FROM cases
  UNION ALL
  SELECT eid, 'recheck',    'worker',        t0 + interval '10 hours 30 minutes' FROM cases WHERE rework
  UNION ALL
  SELECT eid, 'processing', 'worker',        t0 + interval '11 hours' FROM cases WHERE rework
  UNION ALL
  SELECT eid, 'completed',  'worker',        t0 + interval '12 hours' FROM cases
)
INSERT INTO domain_event (tenant_id, entity_type, entity_id, type, actor, payload, created_at)
SELECT 't-verification', 'work_order', eid, type, actor, '{}'::jsonb, ts
FROM ev
ORDER BY eid, ts;

COMMIT;
