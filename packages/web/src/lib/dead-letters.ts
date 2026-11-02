import { DashboardApiError, requestDashboardApi } from "./dashboard-api";

export type DeadLetterReplay = { id: string; eventId: string; createdAt: string };
export type DeadLetterRecord = { id: string; eventId: string; deliveryId: string; tenantId: string; targetUrl: string;
  lastError: string | null; attemptCount: number; createdAt: string; event: { type: string }; replay: DeadLetterReplay | null };
export type DeadLetterHistory = { items: DeadLetterRecord[]; nextCursor: string | null };
export type ReplayReceipt = { replayId: string; deadLetterId: string; originalEventId: string; eventId: string; createdAt: string };
export const deadLetterPageSizes = [10, 20, 50, 100] as const;
export type DeadLetterPageSize = typeof deadLetterPageSizes[number];
export type DeadLetterQuery = { limit: DeadLetterPageSize; cursors: (string | null)[]; revision: number };
export const initialDeadLetterQuery: DeadLetterQuery = { limit: 20, cursors: [null], revision: 0 };
export type DeadLetterQueryAction = { type: "next"; cursor: string } | { type: "previous" } | { type: "limit"; limit: DeadLetterPageSize } | { type: "refresh" };
export function deadLetterQueryReducer(state: DeadLetterQuery, action: DeadLetterQueryAction): DeadLetterQuery {
  switch (action.type) {
    case "next": return { ...state, cursors: [...state.cursors, action.cursor] };
    case "previous": return state.cursors.length > 1 ? { ...state, cursors: state.cursors.slice(0, -1) } : state;
    case "limit": return { ...state, limit: action.limit, cursors: [null] };
    case "refresh": return { ...state, revision: state.revision + 1 };
  }
}
export function deadLetterListPath(tenantId: string, query: DeadLetterQuery) {
  const params = new URLSearchParams({ limit: String(query.limit) });
  const cursor = query.cursors.at(-1);
  if (cursor) params.set("cursor", cursor);
  return `/tenants/${encodeURIComponent(tenantId)}/dead-letters?${params}`;
}
export function deadLetterPath(tenantId: string, id: string) { return `/tenants/${encodeURIComponent(tenantId)}/dead-letters/${encodeURIComponent(id)}`; }
function invalid(): never { throw new DashboardApiError(502, "Waybill returned unexpected dead-letter data. Please try again."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown) { return typeof value === "string" && value.length > 0 ? value : invalid(); }
function uuid(value: unknown) { const result = text(value); return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result) ? result : invalid(); }
function date(value: unknown) { const result = text(value); return Number.isFinite(Date.parse(result)) ? result : invalid(); }
export function readDeadLetterHistory(value: unknown, tenantId: string): DeadLetterHistory {
  const data = object(value);
  if (!Array.isArray(data.items) || (data.nextCursor !== null && (typeof data.nextCursor !== "string" || !data.nextCursor.length))) return invalid();
  const items = data.items.map(value => {
    const row = object(value); const event = object(row.event);
    if (row.tenantId !== tenantId || typeof row.attemptCount !== "number" || !Number.isSafeInteger(row.attemptCount) || row.attemptCount < 0 || (row.lastError !== null && typeof row.lastError !== "string")) return invalid();
    const replay = row.replay === null ? null : object(row.replay);
    return { id: uuid(row.id), eventId: uuid(row.eventId), deliveryId: uuid(row.deliveryId), tenantId, targetUrl: text(row.targetUrl),
      lastError: row.lastError, attemptCount: row.attemptCount, createdAt: date(row.createdAt), event: { type: text(event.type) },
      replay: replay ? { id: uuid(replay.id), eventId: uuid(replay.eventId), createdAt: date(replay.createdAt) } : null } satisfies DeadLetterRecord;
  });
  if (new Set(items.map(row => row.id)).size !== items.length) return invalid();
  return { items, nextCursor: data.nextCursor };
}
export function archivedPayloadJson(value: unknown, row: DeadLetterRecord) {
  const data = object(value);
  if (data.tenantId !== row.tenantId || data.deadLetterId !== row.id || data.eventId !== row.eventId || !Object.hasOwn(data, "payload")) return invalid();
  try { const json = JSON.stringify(data.payload, null, 2); return typeof json === "string" ? json : invalid(); }
  catch { return invalid(); }
}
export function readReplayReceipt(value: unknown, row: DeadLetterRecord): ReplayReceipt {
  const data = object(value);
  if (data.deadLetterId !== row.id || data.originalEventId !== row.eventId || data.eventId === row.eventId) return invalid();
  return { replayId: uuid(data.replayId), deadLetterId: row.id, originalEventId: row.eventId, eventId: uuid(data.eventId), createdAt: date(data.createdAt) };
}
export function canRequestReplay(row: DeadLetterRecord, payloadReady: boolean) { return row.replay === null && payloadReady; }
export function deadLetterError(error: unknown, operation: "list" | "payload" | "replay") {
  if (!(error instanceof DashboardApiError)) return new DashboardApiError(0, "The request could not be completed. Please try again.");
  if (error.status === 404 && operation !== "list") return new DashboardApiError(404, "This archived record is no longer available. Refresh the list.");
  if (error.status === 410) return new DashboardApiError(410, "The archived payload is no longer available.");
  if (error.status === 409) return new DashboardApiError(409, "Replay was not accepted. It may already be requested, the source may have changed, or its destination may not match the configured receiver. Refresh before trying again.");
  if (error.status === 502 && operation === "payload") return new DashboardApiError(502, "The archive could not be inspected. It may be invalid or exceed the server’s inspection limit.");
  return error;
}
export async function submitDeadLetterReplay(origin: string, row: DeadLetterRecord, csrfToken: string, idempotencyKey: string, signal?: AbortSignal) {
  return readReplayReceipt(await requestDashboardApi(origin, `${deadLetterPath(row.tenantId, row.id)}/replay`, { method: "POST", csrfToken, idempotencyKey, signal }), row);
}
