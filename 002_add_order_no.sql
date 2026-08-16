-- 002: 新增业务工单号 order_no（修复 DEF-1 创建返回 code=0、DEF-2 列表缺 code 字段）
-- 增量迁移，可重复执行（用 DO 块做幂等判断）。
-- 执行：由 db/migrate.ts 自动按序加载全部 NNN_*.sql。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'work_orders' AND column_name = 'order_no'
  ) THEN
    -- 1) 先加可为空的列
    ALTER TABLE work_orders ADD COLUMN order_no text;

    -- 2) 为存量数据补值（前缀 WO_ + 创建时间纳秒 + id 后4位，保证唯一）
    UPDATE work_orders
    SET order_no = 'WO_' || to_char(created_at, 'YYYYMMDD') || '_' || replace(id, '-', '') || '_' || extract('epoch' from created_at)::bigint % 100000;

    -- 3) 补完值后再约束 NOT NULL（新增行由应用层生成）
    ALTER TABLE work_orders ALTER COLUMN order_no SET NOT NULL;

    -- 4) 业务工单号唯一（同租户内）
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_order_no_uniq UNIQUE (tenant_id, order_no);
  END IF;
END $$;
