"use client";

import { useEffect, useReducer, useState } from "react";
import { useParams } from "next/navigation";
import { requestDashboardApi, type DashboardApiError } from "../../lib/dashboard-api";
import { formatCount, formatTimestamp, selectedWorkspace } from "../../lib/dashboard-format";
import { deadLetterError, deadLetterListPath, deadLetterPageSizes, deadLetterQueryReducer, initialDeadLetterQuery, readDeadLetterHistory, type DeadLetterHistory, type DeadLetterPageSize, type ReplayReceipt } from "../../lib/dead-letters";
import { DashboardArtwork } from "./artwork";
import { useDashboard } from "./provider";
import { DashboardGlyph } from "./ui";
import { DeadLetterDetails } from "./dead-letter-details";

type HistoryResource = { key: string; path: string; status: "loading" | "ready" | "error"; history?: DeadLetterHistory; error?: DashboardApiError };
export function DeadLetters() {
  const { state } = useDashboard(); const { tenantId } = useParams<{ tenantId: string }>();
  const workspace = state.status === "ready" ? selectedWorkspace(state.session, tenantId) : null;
  return workspace ? <DeadLetterList key={workspace.id} tenantId={workspace.id}/> : null;
}
function DeadLetterList({ tenantId }: { tenantId: string }) {
  const { apiOrigin, invalidate, switchWorkspace, reload } = useDashboard();
  const [query, dispatch] = useReducer(deadLetterQueryReducer, initialDeadLetterQuery);
  const [resource, setResource] = useState<HistoryResource>({ key: "", path: "", status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replayPending, setReplayPending] = useState(false); const [receipts, setReceipts] = useState<Record<string, ReplayReceipt>>({});
  const path = deadLetterListPath(tenantId, query); const key = `${path}:${query.revision}`;
  const loading = resource.key !== key || resource.status === "loading";
  const history = resource.path === path ? resource.history : undefined;
  const error = resource.path === path ? resource.error : undefined;
  const rows = history?.items.map(row => { const receipt = receipts[row.id]; return receipt && !row.replay ? { ...row, replay: { id: receipt.replayId, eventId: receipt.eventId, createdAt: receipt.createdAt } } : row; }) ?? [];
  const selected = rows.find(row => row.id === selectedId) ?? null;
  useEffect(() => {
    const controller = new AbortController();
    requestDashboardApi(apiOrigin, path, { signal: controller.signal }).then(value => readDeadLetterHistory(value, tenantId))
      .then(history => { if (!controller.signal.aborted) setResource({ key, path, status: "ready", history }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const failure = deadLetterError(error, "list");
        if (failure.status === 401) invalidate();
        else setResource(previous => ({ key, path, status: "error", error: failure, history: previous.path === path && ![403, 404].includes(failure.status) ? previous.history : undefined }));
      });
    return () => controller.abort();
  }, [apiOrigin, path, key, tenantId, invalidate]);
  function accepted(receipt: ReplayReceipt) { setReceipts(value => ({ ...value, [receipt.deadLetterId]: receipt })); dispatch({ type: "refresh" }); }
  return <section className="dashboard-dead-letters" aria-labelledby="dead-letters-heading">
    <header className="dashboard-page-heading"><div><h1 id="dead-letters-heading">Dead letters</h1><p>Inspect failed webhook deliveries and recover archived events.</p></div><DashboardArtwork/></header>
    <div className="dead-letters-grid"><section className="dead-letters-list dashboard-panel" aria-labelledby="dead-letters-list-heading">
      <header className="dead-list-heading"><div><h2 id="dead-letters-list-heading">Archived failures</h2><span>· Most recent first</span></div><div><button className="dashboard-button" type="button" disabled={loading || replayPending} onClick={() => dispatch({ type: "refresh" })}><span aria-hidden="true">↻</span>Refresh</button><label><span className="dashboard-sr-only">Archived records per page</span><select value={query.limit} disabled={replayPending} onChange={event => { setSelectedId(null); dispatch({ type: "limit", limit: Number(event.target.value) as DeadLetterPageSize }); }}>{deadLetterPageSizes.map(size => <option key={size} value={size}>{size} per page</option>)}</select></label></div></header>
      {error && <div className="dead-list-error" role="alert"><p>{error.message}{history && " Showing previously loaded records."}</p><button className="dashboard-button" type="button" disabled={replayPending} onClick={error.status === 403 || error.status === 404 ? () => { switchWorkspace(); void reload(); } : () => dispatch({ type: "refresh" })}>{error.status === 403 || error.status === 404 ? "Choose a workspace" : "Try again"}</button></div>}
      <div className="dead-list-content" aria-busy={loading}>{!history && loading ? <div className="dashboard-history-loading" role="status">Loading archived failures…{[0, 1, 2, 3].map(index => <span className="dashboard-skeleton" key={index}/>)}</div> : history && rows.length === 0 ? <div className="dashboard-empty"><DashboardGlyph name="workspace"/><h3>No archived failures</h3><p>{query.cursors.length > 1 ? "There are no records on this page. Use Previous to return." : "Archived failed deliveries for this workspace will appear here."}</p></div> : history && <div className="dead-table-scroll" role="region" aria-label="Archived failures table; scroll horizontally to read all columns" tabIndex={0}><table className="dead-table"><caption className="dashboard-sr-only">Archived failed deliveries, most recent first. Times are in UTC. Select a record to inspect its archived payload.</caption><colgroup>{[33, 33, 17, 10, 7].map((width, index) => <col key={index} style={{ width: `${width}%` }}/>)}</colgroup><thead><tr>{["Event", "Destination", "Archived", "Attempts"].map(label => <th scope="col" key={label}>{label}</th>)}<th scope="col"><span className="dashboard-sr-only">Select</span></th></tr></thead><tbody>{rows.map(row => {
        const time = formatTimestamp(row.createdAt);
        return <tr key={row.id} className={row.id === selectedId ? "is-selected" : undefined} onClick={event => { if (!replayPending && event.target instanceof Element && !event.target.closest("button")) setSelectedId(row.id); }}><td><i className="dead-row-dot" aria-hidden="true"/><button className="dead-row-select" type="button" aria-label={`Inspect ${row.event.type}, dead letter ${row.id}`} aria-pressed={row.id === selectedId} disabled={replayPending} onClick={() => setSelectedId(row.id)}><strong title={row.event.type}>{row.event.type}</strong><small title={row.id}>{row.id}</small></button></td><td><span className="dead-destination" title={row.targetUrl}>{row.targetUrl}</span></td><td><time dateTime={row.createdAt}>{time.day}<small>{time.time}</small></time></td><td>{formatCount(row.attemptCount)}</td><td><DashboardGlyph name="chevron"/></td></tr>;
      })}</tbody></table></div>}</div>
      <footer className="dead-pagination"><span role="status">{loading ? "Loading archived records…" : history ? `${formatCount(rows.length)} archived ${rows.length === 1 ? "record" : "records"} shown` : "Archived records unavailable"}</span><div><button className="dashboard-button" type="button" disabled={loading || replayPending || query.cursors.length === 1} onClick={() => { setSelectedId(null); dispatch({ type: "previous" }); }}><span aria-hidden="true">‹</span> Previous</button><button className="dashboard-button" type="button" disabled={loading || replayPending || !history?.nextCursor} onClick={() => { if (history?.nextCursor) { setSelectedId(null); dispatch({ type: "next", cursor: history.nextCursor }); } }}>Next <span aria-hidden="true">›</span></button></div></footer>
    </section>
    <aside className="dead-selected-panel" aria-label="Selected dead-letter details">{selected ? <DeadLetterDetails key={selected.id} row={selected} revision={query.revision} onBusy={setReplayPending} onReplay={accepted}/> : <section className="dead-no-selection dashboard-panel"><DashboardGlyph name="workspace"/><h2>Select a dead letter</h2><p>Choose an archived failure to inspect its stored error, payload, and replay state.</p></section>}</aside></div>
  </section>;
}
