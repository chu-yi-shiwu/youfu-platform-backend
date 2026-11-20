// 资产事件时间线（2026-11-17 资产模块 P2）：只读聚合，不写库。
// 事实源：
//   - domain_event（entity_type='asset'）：建档/编辑/状态变更/调拨/报障/报废/维保
//   - work_orders（asset.linked_order_ids）：关联工单
// 输出统一按 created_at 倒序，保留既有工单字段（id/order_id/order_no/...）以兼容前端与外部消费方。

import { summarizeLinkedOrders } from './assetHistory.js';

export interface AssetOrderRow {
  id: string;
  order_no: string | null;
  business_type: string | null;
  status: string;
  created_at: string;
}

export interface AssetEventRow {
  id: number | string;
  type: string;
  actor?: string | null;
  payload?: unknown;
  created_at: string;
}

export type AssetTimelineItem =
  | ({ kind: 'work_order' } & ReturnType<typeof summarizeLinkedOrders>[number])
  | {
      kind: 'event';
      id: string;
      event_type: string;
      actor: string | null;
      payload: unknown;
      created_at: string;
    };

export function mergeAssetTimeline(orders: AssetOrderRow[], events: AssetEventRow[]): AssetTimelineItem[] {
  const orderItems: AssetTimelineItem[] = summarizeLinkedOrders(orders).map((o) => ({
    ...o,
    kind: 'work_order' as const,
  }));
  const eventItems: AssetTimelineItem[] = events.map((e) => ({
    kind: 'event' as const,
    // domain_event.id 是 bigint，避免与工单 uuid 冲突，加前缀。
    id: `evt-${e.id}`,
    event_type: e.type,
    actor: e.actor ?? null,
    payload: e.payload ?? {},
    created_at: e.created_at,
  }));
  return [...orderItems, ...eventItems].sort(
    (x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime(),
  );
}
