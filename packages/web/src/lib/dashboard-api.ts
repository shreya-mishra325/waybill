import { deliveryStatuses, type DashboardSession, type DeliveryHistory, type DeliveryRecord, type DeliveryStatus, type DeliverySummary } from "./dashboard-types";

export class DashboardApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const messages: Record<number, string> = {
  401: "Your session has ended. Sign in again to continue.",
  403: "This request is not permitted. Refresh your session and try again.",
  404: "This workspace is no longer available to your account.",
  503: "Waybill is temporarily unavailable. Please try again shortly.",
};
export function normalizeApiOrigin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("A valid Waybill API origin is required"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTPS API origin or a local development origin");
  }
  return url.origin;
}
export async function requestDashboardApi(origin: string, path: string, options: { method?: "GET" | "POST"; csrfToken?: string; idempotencyKey?: string; body?: Record<string, unknown>; signal?: AbortSignal } = {}): Promise<unknown> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("API requests require a relative path");
  const method = options.method ?? "GET";
  if (method === "POST" && !options.csrfToken) throw new DashboardApiError(403, messages[403]!);
  if (options.idempotencyKey !== undefined && (method !== "POST" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.idempotencyKey))) throw new DashboardApiError(400, "A valid replay idempotency key is required.");
  if (options.body !== undefined && method !== "POST") throw new DashboardApiError(400, "Request bodies require POST.");
  let response: Response;
  try {
    response = await fetch(normalizeApiOrigin(origin) + path, { method, credentials: "include", cache: "no-store",
      headers: { Accept: "application/json", ...(options.csrfToken ? { "X-CSRF-Token": options.csrfToken } : {}), ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}), ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    if (!response.ok) { await response.body?.cancel(); throw new DashboardApiError(response.status, messages[response.status] ?? "The request could not be completed. Please try again."); }
    if (response.status === 204) return undefined;
    return await response.json();
  } catch (error) {
    if (error instanceof DashboardApiError) throw error;
    if (options.signal?.aborted) throw error;
    throw new DashboardApiError(0, "Unable to reach Waybill. Check your connection and try again.");
  }
}
function invalid(): never { throw new DashboardApiError(502, "Waybill returned an unexpected response. Please try again."); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === "string" && value.length > 0 ? value : invalid(); }
function count(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid(); }
function date(value: unknown): string { const string = text(value); return Number.isFinite(Date.parse(string)) ? string : invalid(); }
function optionalDate(value: unknown): string | null { return value === null ? null : date(value); }
function uuid(value: unknown): string { const string = text(value); return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(string) ? string : invalid(); }
export function readDashboardSession(value: unknown): DashboardSession {
  const data = record(value); const user = record(data.user);
  if (!Array.isArray(data.tenants) || typeof data.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.csrfToken)) return invalid();
  const tenants = data.tenants.map(value => { const tenant = record(value); return { id: uuid(tenant.id), name: text(tenant.name) }; });
  if (new Set(tenants.map(tenant => tenant.id)).size !== tenants.length) return invalid();
  return { user: { id: text(user.id), githubId: text(user.githubId), githubLogin: text(user.githubLogin) }, tenants, csrfToken: data.csrfToken, expiresAt: date(data.expiresAt) };
}
export function readDeliverySummary(value: unknown): DeliverySummary {
  const data = record(value); const source = record(data.counts);
  const counts = Object.fromEntries(deliveryStatuses.map(status => [status, count(source[status])])) as Record<DeliveryStatus, number>;
  const total = count(data.total); const completed = count(data.completed);
  if (total !== Object.values(counts).reduce((sum, n) => sum + n, 0) || completed !== counts.SUCCEEDED + counts.DEAD_LETTERED) return invalid();
  const rate = data.successRatePercent;
  if (completed === 0 ? rate !== null : typeof rate !== "number" || !Number.isFinite(rate) || Math.abs(rate - counts.SUCCEEDED / completed * 100) > 0.011) return invalid();
  return { total, counts, completed, successRatePercent: rate as number | null };
}
export function readDeliveryHistory(value: unknown, tenantId: string): DeliveryHistory {
  const data = record(value); if (!Array.isArray(data.items) || (data.nextCursor !== null && typeof data.nextCursor !== "string")) return invalid();
  const items = data.items.map(value => {
    const row = record(value); const event = record(row.event);
    if (row.tenantId !== tenantId || !deliveryStatuses.includes(row.status as DeliveryStatus) || (row.lastError !== null && typeof row.lastError !== "string")) return invalid();
    return { id: uuid(row.id), eventId: uuid(row.eventId), tenantId, targetUrl: text(row.targetUrl), status: row.status as DeliveryStatus,
      attemptCount: count(row.attemptCount), createdAt: date(row.createdAt), lastAttemptAt: optionalDate(row.lastAttemptAt),
      nextAttemptAt: optionalDate(row.nextAttemptAt), lastError: row.lastError, event: { type: text(event.type) } } satisfies DeliveryRecord;
  });
  if (new Set(items.map(row => row.id)).size !== items.length) return invalid();
  return { items, nextCursor: data.nextCursor };
}
