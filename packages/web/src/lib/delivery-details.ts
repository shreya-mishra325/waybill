import { readDeliveryHistory, requestDashboardApi } from "./dashboard-api";
import type { DeliveryRecord } from "./dashboard-types";

export const detailHistoryLimit = 100;
export function validDeliveryId(id: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
}
export function scheduledRetry(row: Pick<DeliveryRecord, "status" | "nextAttemptAt">) {
  return row.status === "FAILED" ? row.nextAttemptAt : null;
}
export function deliveryRecordJson(row: DeliveryRecord) {
  return JSON.stringify({ id: row.id, eventId: row.eventId, tenantId: row.tenantId,
    targetUrl: row.targetUrl, status: row.status, attemptCount: row.attemptCount,
    createdAt: row.createdAt, lastAttemptAt: row.lastAttemptAt, nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError, event: { type: row.event.type } }, null, 2);
}
export type JsonToken = { kind: "key" | "string" | "literal" | "plain"; text: string };
export function jsonLineTokens(line: string): JsonToken[] {
  const pattern = /"(?:\\.|[^"\\])*"|\b(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g;
  const tokens: JsonToken[] = [];
  let end = 0;
  for (const match of line.matchAll(pattern)) {
    const start = match.index!;
    if (start > end) tokens.push({ kind: "plain", text: line.slice(end, start) });
    const text = match[0];
    tokens.push({ kind: text.startsWith('"') ? /^\s*:/.test(line.slice(start + text.length)) ? "key" : "string" : "literal", text });
    end = start + text.length;
  }
  if (end < line.length) tokens.push({ kind: "plain", text: line.slice(end) });
  return tokens;
}
export async function findDeliveryRecord(origin: string, tenantId: string, deliveryId: string, signal?: AbortSignal) {
  if (!validDeliveryId(deliveryId)) return { record: null, limited: false };
  const history = readDeliveryHistory(await requestDashboardApi(origin,
    `/tenants/${encodeURIComponent(tenantId)}/deliveries?limit=${detailHistoryLimit}`, { signal }), tenantId);
  return { record: history.items.find(row => row.id === deliveryId) ?? null, limited: history.nextCursor !== null };
}
