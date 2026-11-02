import { DashboardApiError, requestDashboardApi } from "./dashboard-api";

export type ApiKeyRecord = { id: string; tenantId: string; createdByUserId: string; name: string; createdAt: string; expiresAt: string; revokedAt: string | null; scope: "events:write" };
export type ApiKeyHistory = { items: ApiKeyRecord[]; nextCursor: string | null };
export type IssuedApiKey = { key: ApiKeyRecord; token: string };
export type ApiKeyStatus = "Active" | "Expired" | "Revoked";
export const apiKeyPageSizes = [1, 10, 20, 50, 100] as const;
export type ApiKeyPageSize = typeof apiKeyPageSizes[number];
export type ApiKeyQuery = { limit: ApiKeyPageSize; cursors: (string | null)[]; revision: number };
export type ApiKeyQueryAction = { type: "next"; cursor: string } | { type: "previous" } | { type: "limit"; limit: ApiKeyPageSize } | { type: "refresh" } | { type: "created" };
export const initialApiKeyQuery: ApiKeyQuery = { limit: 20, cursors: [null], revision: 0 };
export function apiKeyQueryReducer(state: ApiKeyQuery, action: ApiKeyQueryAction): ApiKeyQuery {
  switch (action.type) {
    case "next": return { ...state, cursors: [...state.cursors, action.cursor] };
    case "previous": return state.cursors.length > 1 ? { ...state, cursors: state.cursors.slice(0, -1) } : state;
    case "limit": return { ...state, limit: action.limit, cursors: [null] };
    case "refresh": return { ...state, revision: state.revision + 1 };
    case "created": return { ...state, cursors: [null], revision: state.revision + 1 };
  }
}
export function apiKeysPath(tenantId: string) { return `/tenants/${encodeURIComponent(tenantId)}/api-keys`; }
export function apiKeyListPath(tenantId: string, query: ApiKeyQuery) {
  const params = new URLSearchParams({ limit: String(query.limit) });
  const cursor = query.cursors.at(-1); if (cursor) params.set("cursor", cursor);
  return `${apiKeysPath(tenantId)}?${params}`;
}
export function apiKeyStatus(row: Pick<ApiKeyRecord, "revokedAt" | "expiresAt">, now = Date.now()): ApiKeyStatus {
  return row.revokedAt !== null ? "Revoked" : Date.parse(row.expiresAt) <= now ? "Expired" : "Active";
}
export function validateApiKeyInput(name: string, expiry: string) {
  const trimmed = name.trim(); const expiresInDays = Number(expiry);
  const errors: { name?: string; expiresInDays?: string } = {};
  if (!trimmed.length || trimmed.length > 80) errors.name = "Enter a name of 1–80 characters.";
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) errors.expiresInDays = "Choose a whole number from 1 to 365 days.";
  return { input: { name: trimmed, expiresInDays }, errors, valid: Object.keys(errors).length === 0 };
}
function invalid(): never { throw new DashboardApiError(502, "Waybill returned unexpected API key data. Refresh and try again."); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(); return value as Record<string, unknown>; }
function text(value: unknown) { return typeof value === "string" && value.length > 0 ? value : invalid(); }
function uuid(value: unknown) { const result = text(value); return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result) ? result : invalid(); }
function date(value: unknown) { const result = text(value); return Number.isFinite(Date.parse(result)) ? result : invalid(); }
export function readApiKeyRecord(value: unknown, tenantId: string): ApiKeyRecord {
  const row = object(value);
  if (row.tenantId !== tenantId || row.scope !== "events:write") return invalid();
  const name = text(row.name); if (name.length > 80 || !name.trim().length) return invalid();
  return { id: uuid(row.id), tenantId, createdByUserId: text(row.createdByUserId), name, createdAt: date(row.createdAt), expiresAt: date(row.expiresAt), revokedAt: row.revokedAt === null ? null : date(row.revokedAt), scope: "events:write" };
}
export function readApiKeyHistory(value: unknown, tenantId: string): ApiKeyHistory {
  const data = object(value); if (!Array.isArray(data.items)) return invalid();
  const items = data.items.map(value => readApiKeyRecord(value, tenantId));
  if (new Set(items.map(row => row.id)).size !== items.length) return invalid();
  return { items, nextCursor: data.nextCursor === null ? null : uuid(data.nextCursor) };
}
export function readIssuedApiKey(value: unknown, tenantId: string): IssuedApiKey {
  const source = object(value); const key = readApiKeyRecord(source, tenantId); const token = text(source.token);
  if (!new RegExp(`^wb_${key.id}\\.[A-Za-z0-9_-]{43}$`, "i").test(token) || key.revokedAt !== null) return invalid();
  return { key, token };
}
export async function createApiKey(origin: string, tenantId: string, csrfToken: string, input: { name: string; expiresInDays: number }, signal?: AbortSignal) {
  return readIssuedApiKey(await requestDashboardApi(origin, apiKeysPath(tenantId), { method: "POST", csrfToken, body: input, signal }), tenantId);
}
export async function revokeApiKey(origin: string, row: ApiKeyRecord, csrfToken: string, signal?: AbortSignal) {
  const result = readApiKeyRecord(await requestDashboardApi(origin, `${apiKeysPath(row.tenantId)}/${encodeURIComponent(row.id)}/revoke`, { method: "POST", csrfToken, signal }), row.tenantId);
  if (result.id !== row.id || result.revokedAt === null) return invalid();
  return result;
}
export function apiKeyError(error: unknown, operation: "list" | "create" | "revoke") {
  const failure = error instanceof DashboardApiError ? error : new DashboardApiError(0, "The request could not be completed.");
  if (failure.status === 400) return new DashboardApiError(400, operation === "create" ? "The key name or expiration was rejected. Check the form and try again." : "The key request is no longer valid. Refresh the list.");
  if (operation === "revoke" && failure.status === 404) return new DashboardApiError(404, "This API key is no longer available in this workspace. Refresh the list.");
  if (operation === "create" && [0, 502, 503].includes(failure.status)) return new DashboardApiError(failure.status, "Key creation could not be confirmed. Refresh to check whether a key was issued before trying again. If its secret was lost, revoke that key and create another.");
  return failure;
}
