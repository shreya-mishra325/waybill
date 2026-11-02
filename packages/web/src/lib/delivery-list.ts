import type { DeliveryStatus } from "./dashboard-types";

export const deliveryPageSizes = [10, 25, 50, 100] as const;
export type DeliveryPageSize = typeof deliveryPageSizes[number];
export type DeliveryFilter = DeliveryStatus | "ALL";
export type DeliveryListQuery = { filter: DeliveryFilter; limit: DeliveryPageSize; cursors: (string | null)[]; revision: number };
export type DeliveryListAction = { type: "filter"; filter: DeliveryFilter } | { type: "limit"; limit: DeliveryPageSize } | { type: "next"; cursor: string } | { type: "previous" } | { type: "refresh" };
export const initialDeliveryQuery: DeliveryListQuery = { filter: "ALL", limit: 50, cursors: [null], revision: 0 };
export function deliveryListReducer(state: DeliveryListQuery, action: DeliveryListAction): DeliveryListQuery {
  switch (action.type) {
    case "filter": return { ...state, filter: action.filter, cursors: [null] };
    case "limit": return { ...state, limit: action.limit, cursors: [null] };
    case "next": return { ...state, cursors: [...state.cursors, action.cursor] };
    case "previous": return state.cursors.length > 1 ? { ...state, cursors: state.cursors.slice(0, -1) } : state;
    case "refresh": return { ...state, revision: state.revision + 1 };
  }
}
export function deliveryHistoryPath(tenantId: string, query: DeliveryListQuery) {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.filter !== "ALL") params.set("status", query.filter);
  const cursor = query.cursors.at(-1);
  if (cursor) params.set("cursor", cursor);
  return `/tenants/${encodeURIComponent(tenantId)}/deliveries?${params}`;
}
export function deliveryDetailsPath(tenantId: string, deliveryId: string) {
  return `/app/${encodeURIComponent(tenantId)}/deliveries/${encodeURIComponent(deliveryId)}`;
}
