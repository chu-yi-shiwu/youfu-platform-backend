// 资产关联工单聚合纯函数（批次 C · 资产管理）：只读，不写 linked_order_ids。
// 来源为 SELECT * FROM work_orders WHERE id = ANY($1)，由 routes/asset.ts 传入 asset.linked_order_ids。
export interface LinkedOrderRow {
  id: string;
  order_no: string;
  business_type: string;
  status: string;
  created_at: string;
}

export function summarizeLinkedOrders(rows: LinkedOrderRow[]) {
  return rows.map((r) => ({
    order_id: r.id,
    order_no: r.order_no,
    business_type: r.business_type,
    status: r.status,
    created_at: r.created_at,
  }));
}
