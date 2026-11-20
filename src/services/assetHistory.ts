// 资产关联工单聚合纯函数（批次 C · 资产管理）：只读，不写 linked_order_ids。
// 来源为 SELECT * FROM work_orders WHERE id = ANY($1)，由 routes/asset.ts 传入 asset.linked_order_ids。
export interface LinkedOrderRow {
  id: string;
  order_no: string | null;
  business_type: string | null;
  status: string;
  created_at: string;
  updated_at?: string | null;
  completed_at?: string | null;
}

export function summarizeLinkedOrders(rows: LinkedOrderRow[]) {
  return rows.map((r) => ({
    // 2026-11-17：同时保留 id 与 order_id，兼容前端 rowKey="id" 与既有 order_id 消费方。
    id: r.id,
    order_id: r.id,
    order_no: r.order_no,
    business_type: r.business_type,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at ?? null,
    completed_at: r.completed_at ?? null,
  }));
}
