"use client";

import { useEffect, useReducer, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { DashboardApiError, readDeliveryHistory, requestDashboardApi } from "../../lib/dashboard-api";
import { formatCount, formatTimestamp, selectedWorkspace, statusLabels } from "../../lib/dashboard-format";
import { deliveryStatuses, type DeliveryHistory, type DeliveryRecord } from "../../lib/dashboard-types";
import { deliveryDetailsPath, deliveryHistoryPath, deliveryListReducer, deliveryPageSizes, initialDeliveryQuery, type DeliveryPageSize, type DeliveryFilter } from "../../lib/delivery-list";
import { useDashboard } from "./provider";
import { useDeliverySelection } from "./delivery-selection";
import { DashboardArtwork } from "./artwork";
import { DashboardGlyph, StatusChip } from "./ui";

type HistoryState = { key: string; status: "ready"; history: DeliveryHistory } | { key: string; status: "loading" } | { key: string; status: "error"; error: DashboardApiError };
function RefreshIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17"/></svg>;
}
export function Deliveries() {
  const { state } = useDashboard();
  const { tenantId } = useParams<{ tenantId: string }>();
  const workspace = state.status === "ready" ? selectedWorkspace(state.session, tenantId) : null;
  return workspace ? <DeliveryList key={workspace.id} tenantId={workspace.id}/> : null;
}
function DeliveryList({ tenantId }: { tenantId: string }) {
  const { apiOrigin, invalidate, switchWorkspace, reload } = useDashboard();
  const router = useRouter();
  const selection = useDeliverySelection();
  const [query, dispatch] = useReducer(deliveryListReducer, initialDeliveryQuery);
  const path = deliveryHistoryPath(tenantId, query);
  const key = `${path}:${query.revision}`;
  const [resource, setResource] = useState<HistoryState>({ key: "", status: "loading" });
  const [copyMessage, setCopyMessage] = useState("");
  const current: HistoryState = resource.key === key ? resource : { key, status: "loading" };
  const loading = current.status === "loading";
  const history = current.status === "ready" ? current.history : null;
  useEffect(() => {
    const controller = new AbortController();
    setResource({ key, status: "loading" });
    setCopyMessage("");
    requestDashboardApi(apiOrigin, path, { signal: controller.signal })
      .then(value => readDeliveryHistory(value, tenantId))
      .then(history => { if (!controller.signal.aborted) setResource({ key, status: "ready", history }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const failure = error instanceof DashboardApiError ? error : new DashboardApiError(0, "Unable to load deliveries. Please try again.");
        if (failure.status === 401) invalidate();
        else setResource({ key, status: "error", error: failure });
      });
    return () => controller.abort();
  }, [apiOrigin, path, key, tenantId, invalidate]);
  function openDelivery(row: DeliveryRecord) {
    selection.select(row);
    router.push(deliveryDetailsPath(tenantId, row.id));
  }
  async function copyId(id: string) {
    try { await navigator.clipboard.writeText(id); setCopyMessage("Delivery ID copied."); }
    catch { setCopyMessage("Unable to copy. Select the delivery ID to copy it manually."); }
  }
  const filters: { value: DeliveryFilter; label: string }[] = [{ value: "ALL", label: "All" }, ...deliveryStatuses.map(value => ({ value, label: statusLabels[value] }))];
  return <section className="dashboard-deliveries" aria-labelledby="deliveries-heading">
    <header className="dashboard-page-heading"><div><h1 id="deliveries-heading">Deliveries</h1><p>Browse webhook deliveries for this workspace.</p></div><DashboardArtwork/></header>
    <section className="deliveries-panel" aria-label="Workspace deliveries">
      <div className="deliveries-toolbar">
        <div className="deliveries-filters" role="group" aria-label="Filter deliveries by status">{filters.map(filter => <button key={filter.value} type="button" aria-pressed={query.filter === filter.value} onClick={() => dispatch({ type: "filter", filter: filter.value })}>{filter.label}</button>)}</div>
        <div className="deliveries-controls"><button className="dashboard-button" type="button" disabled={loading} onClick={() => dispatch({ type: "refresh" })}><RefreshIcon/>Refresh</button><label className="deliveries-page-size"><span className="dashboard-sr-only">Deliveries per page</span><select value={query.limit} onChange={event => dispatch({ type: "limit", limit: Number(event.target.value) as DeliveryPageSize })}>{deliveryPageSizes.map(size => <option key={size} value={size}>{size} per page</option>)}</select></label></div>
      </div>
      <div className="deliveries-caption"><span>Every delivery, accounted for.</span><span>Statuses are based on stored delivery records.</span></div>
      <div className="deliveries-content" aria-busy={loading}>
        {loading ? <div className="dashboard-history-loading" role="status">Loading deliveries…{[0, 1, 2, 3, 4].map(index => <span className="dashboard-skeleton" key={index}/>)}</div> : current.status === "error" ? <div className="dashboard-resource-error" role="alert"><DashboardGlyph name="alert"/><p>{current.error.message}</p><button className="dashboard-button" type="button" onClick={current.error.status === 403 || current.error.status === 404 ? () => { switchWorkspace(); void reload(); } : () => dispatch({ type: "refresh" })}>{current.error.status === 403 || current.error.status === 404 ? "Choose a workspace" : "Try again"}</button></div> : history && history.items.length === 0 ? <div className="dashboard-empty"><DashboardGlyph name="workspace"/><h2>No deliveries {query.cursors.length > 1 ? "on this page" : query.filter === "ALL" ? "yet" : "with this status"}</h2><p>{query.cursors.length > 1 ? "Use Previous to return to earlier results." : query.filter === "ALL" ? "Deliveries will appear here when events are processed for this workspace." : "Choose another status to browse this workspace’s deliveries."}</p></div> : history && <div className="deliveries-table-scroll" tabIndex={0} role="region" aria-label="Delivery records; scroll horizontally to view all columns"><table className="deliveries-table"><caption className="dashboard-sr-only">Delivery records, newest first. Creation times are in UTC.</caption><colgroup>{[17, 17, 7.5, 23.5, 13, 8, 11, 3].map((width, index) => <col key={index} style={{ width: `${width}%` }}/>)}</colgroup><thead><tr>{["Event", "Delivery ID", "Method", "Destination", "Status", "Attempts", "Created at"].map(label => <th scope="col" key={label}>{label}</th>)}<th scope="col"><span className="dashboard-sr-only">Details</span></th></tr></thead><tbody>{history.items.map(row => {
        const timestamp = formatTimestamp(row.createdAt);
        return <tr key={row.id} onClick={event => { if (!(event.target instanceof Element) || event.target.closest("a,button") || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; openDelivery(row); }}>
          <td><span className={`deliveries-event-dot dashboard-dot-${row.status.toLowerCase()}`} aria-hidden="true"/><div><Link href={deliveryDetailsPath(tenantId, row.id)} prefetch={false} onNavigate={() => selection.select(row)} title={row.event.type} aria-label={`View ${row.event.type} delivery ${row.id}`}>{row.event.type}</Link><small>Event type</small></div></td>
          <td><div className="deliveries-id"><span title={row.id}>{row.id}</span><button type="button" aria-label={`Copy delivery ID ${row.id}`} onClick={() => void copyId(row.id)}><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="8" y="4" width="12" height="14" rx="2"/><path d="M16 18v3H4V7h4"/></svg></button></div></td>
          <td><span className="deliveries-method" title="Waybill delivers webhooks using HTTP POST">POST</span></td>
          <td><span className="deliveries-destination" title={row.targetUrl}>{row.targetUrl}</span></td><td><StatusChip row={row}/></td><td>{formatCount(row.attemptCount)}</td><td><time dateTime={row.createdAt}>{timestamp.day}<small>{timestamp.time}</small></time></td><td><DashboardGlyph name="chevron"/></td>
        </tr>;
      })}</tbody></table></div>}
      </div>
      <footer className="deliveries-pagination"><span role="status">{history ? `Showing ${formatCount(history.items.length)} delivery ${history.items.length === 1 ? "record" : "records"}` : loading ? "Loading delivery records…" : "Delivery records unavailable"}</span><div><button className="dashboard-button" type="button" disabled={loading || query.cursors.length === 1} onClick={() => dispatch({ type: "previous" })}><span aria-hidden="true">‹</span> Previous</button><span className="deliveries-page-number">Page {query.cursors.length}</span><button className="dashboard-button" type="button" disabled={loading || !history?.nextCursor} onClick={() => { if (history?.nextCursor) dispatch({ type: "next", cursor: history.nextCursor }); }}>Next <span aria-hidden="true">›</span></button></div></footer>
      <p className="dashboard-sr-only" role="status">{copyMessage}</p>
    </section>
  </section>;
}
