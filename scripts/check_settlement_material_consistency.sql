-- check_settlement_material_consistency.sql —— E-9 §14 复议1 哨兵巡检（只读，随时可跑）。
--
-- 【用途】全量重投影（syncMaterialCostRows）之后，结算单里的 material 行应当**逐行等于**
--   inventory_log(type='out') 按 (工单, 耗材) 的聚合结果。任何不等的行 = 联动漏账/重投影未跑/口径漂移。
--   健康库：三段查询全部返回 **0 行**。
--
-- 【口径】事实源 = inventory_log type='out'（盘盈亏 adjust 不计入，与 syncMaterialCostRows 一致）；
--   金额 = 当前 material.price × 聚合 qty（价格快照随重投影刷新）。
--
-- 【跑法】以属主执行（RLS 对属主不强制）：
--   sudo -u postgres psql -d youfu -f scripts/check_settlement_material_consistency.sql
--   youfu_app 亦可，但需带租户上下文（RLS 生效，仅看见本租户行）。
-- 🔴只读脚本：不含 DDL/DML，可在生产随时执行。

\echo '--- ① 数量/金额不一致（结算行 vs 事实源聚合），期望 0 行 ---'
WITH fact AS (
  SELECT il.tenant_id,
         il.work_order_id,
         il.material_id,
         SUM(il.qty)::numeric(12,2) AS qty,
         m.price                    AS price
  FROM inventory_log il
  JOIN material m ON m.id = il.material_id AND m.tenant_id = il.tenant_id
  WHERE il.type = 'out' AND il.material_id IS NOT NULL
  GROUP BY il.tenant_id, il.work_order_id, il.material_id, m.price
)
SELECT si.tenant_id,
       si.work_order_id,
       si.material_id,
       si.qty              AS settlement_qty,
       f.qty               AS fact_qty,
       si.amount           AS settlement_amount,
       ROUND(COALESCE(f.price, 0) * COALESCE(f.qty, 0), 2) AS fact_amount,
       CASE WHEN f.material_id IS NULL THEN '结算有行但事实源无消耗（应被 pruneStale 清掉）'
            ELSE '数量或金额漂移' END AS diagnosis
FROM settlement_item si
LEFT JOIN fact f
  ON f.tenant_id = si.tenant_id
 AND f.work_order_id = si.work_order_id
 AND f.material_id = si.material_id
WHERE si.source = 'material'
  AND (
    f.material_id IS NULL
    OR si.qty <> f.qty
    OR si.amount <> ROUND(f.price * f.qty, 2)
  )
ORDER BY si.tenant_id, si.work_order_id, si.material_id;

\echo '--- ② 有消耗但结算单缺行的工单（漏账，期望 0 行；仅统计存在 draft/confirmed 结算单的工单）---'
WITH fact AS (
  SELECT il.tenant_id, il.work_order_id, il.material_id
  FROM inventory_log il
  WHERE il.type = 'out' AND il.material_id IS NOT NULL
  GROUP BY il.tenant_id, il.work_order_id, il.material_id
)
SELECT DISTINCT f.tenant_id, f.work_order_id, f.material_id, '事实源有消耗但结算单无对应 material 行' AS diagnosis
FROM fact f
JOIN settlement_item si0
  ON si0.tenant_id = f.tenant_id AND si0.work_order_id = f.work_order_id
LEFT JOIN settlement_item si
  ON si.tenant_id = f.tenant_id
 AND si.work_order_id = f.work_order_id
 AND si.material_id = f.material_id
 AND si.source = 'material'
WHERE si.id IS NULL
ORDER BY f.tenant_id, f.work_order_id, f.material_id;

\echo '--- ③ 一单多结算明细的 service 行重复（一单终身一结算防线，期望 0 行）---'
SELECT tenant_id, work_order_id, COUNT(*)::int AS service_rows
FROM settlement_item
WHERE source = 'service'
GROUP BY tenant_id, work_order_id
HAVING COUNT(*) > 1
ORDER BY tenant_id, work_order_id;

\echo '--- ④ 租户内 material 行与事实源总金额对账（按租户汇总，两列应相等或此处无输出）---'
WITH fact AS (
  SELECT il.tenant_id, SUM(ROUND(COALESCE(m.price, 0) * il.qty, 2)) AS fact_amount
  FROM inventory_log il
  JOIN material m ON m.id = il.material_id AND m.tenant_id = il.tenant_id
  WHERE il.type = 'out' AND il.material_id IS NOT NULL
  GROUP BY il.tenant_id
),
booked AS (
  SELECT tenant_id, SUM(amount) AS booked_amount
  FROM settlement_item
  WHERE source = 'material'
  GROUP BY tenant_id
)
SELECT COALESCE(f.tenant_id, b.tenant_id)                     AS tenant_id,
       COALESCE(f.fact_amount, 0)                             AS fact_amount,
       COALESCE(b.booked_amount, 0)                           AS booked_amount,
       COALESCE(f.fact_amount, 0) - COALESCE(b.booked_amount, 0) AS diff
FROM fact f
FULL JOIN booked b ON b.tenant_id = f.tenant_id
WHERE COALESCE(f.fact_amount, 0) <> COALESCE(b.booked_amount, 0)
ORDER BY tenant_id;
