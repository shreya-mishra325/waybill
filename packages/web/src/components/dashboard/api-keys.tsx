"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { requestDashboardApi, type DashboardApiError } from "../../lib/dashboard-api";
import { apiKeyError, apiKeyListPath, apiKeyPageSizes, apiKeyQueryReducer, apiKeyStatus, initialApiKeyQuery, readApiKeyHistory, type ApiKeyHistory, type ApiKeyPageSize, type ApiKeyRecord } from "../../lib/api-keys";
import { formatCount, formatTimestamp, selectedWorkspace } from "../../lib/dashboard-format";
import { useDashboard } from "./provider";
import { DashboardArtwork } from "./artwork";
import { DashboardGlyph } from "./ui";
import { ApiKeyCreate } from "./api-key-create";
import { ApiKeyRevokeDialog } from "./api-key-revoke-dialog";

type Resource = { key: string; path: string; status: "loading" | "ready" | "error"; history?: ApiKeyHistory; error?: DashboardApiError };
export function ApiKeys() {
  const { state } = useDashboard(); const { tenantId } = useParams<{ tenantId: string }>();
  const workspace = state.status === "ready" ? selectedWorkspace(state.session, tenantId) : null;
  return workspace ? <ApiKeyManagement key={workspace.id} tenantId={workspace.id}/> : null;
}
function ApiKeyManagement({ tenantId }: { tenantId: string }) {
  const { apiOrigin, invalidate, reload, switchWorkspace } = useDashboard();
  const [query, dispatch] = useReducer(apiKeyQueryReducer, initialApiKeyQuery);
  const [resource, setResource] = useState<Resource>({ key: "", path: "", status: "loading" });
  const [revoking, setRevoking] = useState<ApiKeyRecord | null>(null); const [overrides, setOverrides] = useState<Record<string, ApiKeyRecord>>({});
  const [notice, setNotice] = useState(""); const [now, setNow] = useState(() => Date.now());
  const table = useRef<HTMLDivElement>(null); const lastRevoke = useRef<string | null>(null);
  const path = apiKeyListPath(tenantId, query); const key = `${path}:${query.revision}`;
  const history = resource.path === path ? resource.history : undefined;
  const error = resource.path === path ? resource.error : undefined;
  const loading = resource.key !== key || resource.status === "loading";
  const rows = history?.items.map(row => overrides[row.id] ?? row) ?? [];
  const nextExpiry = rows.reduce((next, row) => row.revokedAt === null && Date.parse(row.expiresAt) > now ? Math.min(next, Date.parse(row.expiresAt)) : next, Infinity);
  useEffect(() => {
    const controller = new AbortController();
    requestDashboardApi(apiOrigin, path, { signal: controller.signal }).then(value => readApiKeyHistory(value, tenantId))
      .then(history => { if (!controller.signal.aborted) { setResource({ key, path, status: "ready", history }); setNow(Date.now()); } })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const failure = apiKeyError(error, "list");
        if (failure.status === 401) invalidate();
        else setResource(previous => ({ key, path, status: "error", error: failure, history: previous.path === path && ![403, 404].includes(failure.status) ? previous.history : undefined }));
      });
    return () => controller.abort();
  }, [apiOrigin, path, key, tenantId, invalidate]);
  useEffect(() => { const timer = setTimeout(() => setNow(Date.now()), Math.max(25, Math.min(60000, nextExpiry - now + 5))); return () => clearTimeout(timer); }, [nextExpiry, now]);
  useEffect(() => { const update = () => setNow(Date.now()); window.addEventListener("focus", update); return () => window.removeEventListener("focus", update); }, []);
  useEffect(() => { if (!revoking && lastRevoke.current) { const button = table.current?.querySelector<HTMLButtonElement>(`[data-revoke-key="${lastRevoke.current}"]`); (button ?? table.current)?.focus({ preventScroll: true }); } }, [revoking]);
  function created(row: ApiKeyRecord) { setNotice(`API key “${row.name}” created.`); dispatch({ type: "created" }); }
  function revoked(row: ApiKeyRecord) { setOverrides(value => ({ ...value, [row.id]: row })); setNotice(`API key “${row.name}” revoked.`); setRevoking(null); dispatch({ type: "refresh" }); }
  return <section className="dashboard-api-keys" aria-labelledby="api-key-management-heading">
    <header className="dashboard-page-heading"><div><h1 id="api-key-management-heading">API key management</h1><p>Manage credentials for sending events to Waybill.</p></div><DashboardArtwork/></header>
    <div className="api-keys-grid"><section className="api-keys-list dashboard-panel" aria-labelledby="api-keys-list-heading">
      <header className="api-keys-list-heading"><div><h2 id="api-keys-list-heading">API keys</h2><span>· Most recent first</span></div><div><button className="dashboard-button" type="button" disabled={loading} onClick={() => dispatch({ type: "refresh" })}><span aria-hidden="true">↻</span>Refresh</button><label><span className="dashboard-sr-only">API keys per page</span><select value={query.limit} onChange={event => dispatch({ type: "limit", limit: Number(event.target.value) as ApiKeyPageSize })}>{apiKeyPageSizes.map(limit => <option key={limit} value={limit}>{limit} per page</option>)}</select></label></div></header>
      {notice && <p className="api-keys-list-notice" role="status">{notice}</p>}
      {error && <div className="api-keys-list-error" role="alert"><p>{error.message}{history && " Showing previously loaded metadata."}</p><button className="dashboard-button" type="button" onClick={error.status === 403 || error.status === 404 ? () => { switchWorkspace(); void reload(); } : () => dispatch({ type: "refresh" })}>{error.status === 403 || error.status === 404 ? "Choose a workspace" : "Try again"}</button></div>}
      <div className="api-keys-list-content" aria-busy={loading}>{!history && loading ? <div className="dashboard-history-loading" role="status">Loading API keys…{[0, 1, 2].map(index => <span className="dashboard-skeleton" key={index}/>)}</div> : history && !rows.length ? <div className="dashboard-empty"><DashboardGlyph name="key"/><h3>No API keys {query.cursors.length > 1 ? "on this page" : "yet"}</h3><p>{query.cursors.length > 1 ? "Use Previous to return to earlier records." : "Create a key to send events to this workspace."}</p></div> : history && <div className="api-keys-table-scroll" ref={table} role="region" aria-label="Issued API key metadata; scroll horizontally to read all columns" tabIndex={0}><table className="api-keys-table"><caption className="dashboard-sr-only">API key metadata, newest first. Dates are shown in UTC. Previously issued secrets are never listed.</caption><colgroup>{[22, 17, 13, 20, 20, 8].map((width, index) => <col key={index} style={{ width: `${width}%` }}/>)}</colgroup><thead><tr>{["Key name", "Key ID", "Status", "Created", "Expires", "Action"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row => {
        const status = apiKeyStatus(row, now); const createdAt = formatTimestamp(row.createdAt); const expiresAt = formatTimestamp(row.expiresAt);
        return <tr key={row.id}><td><strong title={row.name}>{row.name}</strong></td><td><code title={row.id}>{row.id}</code></td><td><span className={`api-key-status is-${status.toLowerCase()}`}><i aria-hidden="true"/>{status}</span></td><td><time dateTime={row.createdAt} title={`${createdAt.day}, ${createdAt.time}`}>{createdAt.day}</time></td><td><time dateTime={row.expiresAt} title={`${expiresAt.day}, ${expiresAt.time}`}>{expiresAt.day}</time></td><td>{status === "Active" ? <button type="button" data-revoke-key={row.id} className="api-key-revoke-action" aria-label={`Revoke API key ${row.name}`} onClick={() => { if (apiKeyStatus(row) === "Active") { lastRevoke.current = row.id; setRevoking(row); } else setNow(Date.now()); }}>Revoke</button> : <span className="api-key-no-action" aria-label={`No revoke action for a ${status.toLowerCase()} key`}>—</span>}</td></tr>;
      })}</tbody></table></div>}</div>
      <footer className="api-keys-pagination"><span role="status">{loading ? "Loading key metadata…" : history ? `${formatCount(rows.length)} ${rows.length === 1 ? "key" : "keys"} displayed` : "Key metadata unavailable"}</span><div><button className="dashboard-button" type="button" disabled={loading || query.cursors.length === 1} onClick={() => dispatch({ type: "previous" })}><span aria-hidden="true">‹</span> Previous</button><button className="dashboard-button" type="button" disabled={loading || !history?.nextCursor} onClick={() => { if (history?.nextCursor) dispatch({ type: "next", cursor: history.nextCursor }); }}>Next <span aria-hidden="true">›</span></button></div></footer>
    </section>
    <ApiKeyCreate tenantId={tenantId} onCreated={created} onRefresh={() => dispatch({ type: "refresh" })}/></div>
    {revoking && <ApiKeyRevokeDialog key={revoking.id} row={revoking} onDismiss={() => setRevoking(null)} onRevoked={revoked}/>}
  </section>;
}
