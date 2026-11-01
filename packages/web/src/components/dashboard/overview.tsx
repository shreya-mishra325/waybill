"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Icon } from "../icon";
import { DashboardApiError, readDeliveryHistory, readDeliverySummary, requestDashboardApi } from "../../lib/dashboard-api";
import { formatCount, formatRate, formatTimestamp, selectedWorkspace, statusLabels } from "../../lib/dashboard-format";
import { deliveryStatuses, type DeliveryHistory, type DeliveryStatus, type DeliverySummary } from "../../lib/dashboard-types";
import { useDashboard } from "./provider";
import { DashboardArtwork } from "./artwork";
import { DashboardGlyph, DashboardPanel, DeferredLink, StatusChip } from "./ui";

type Resource<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: DashboardApiError };
function ResourceError({ error, retry }: { error: DashboardApiError; retry: () => void }) {
  const { switchWorkspace, reload } = useDashboard();
  return <div className="dashboard-resource-error" role="alert"><DashboardGlyph name="alert"/><p>{error.message}</p><button type="button" className="dashboard-button" onClick={error.status === 403 || error.status === 404 ? () => { switchWorkspace(); void reload(); } : retry}>{error.status === 403 || error.status === 404 ? "Choose a workspace" : "Try again"}</button></div>;
}
function StatCards({ summary, retry }: { summary: Resource<DeliverySummary>; retry: () => void }) {
  if (summary.status === "error") return <ResourceError error={summary.error} retry={retry}/>;
  const stats: { label: string; status: "total" | DeliveryStatus; value: number | null }[] = [
    { label: "Total deliveries", status: "total", value: summary.status === "ready" ? summary.value.total : null },
    { label: "Delivered", status: "SUCCEEDED", value: summary.status === "ready" ? summary.value.counts.SUCCEEDED : null },
    { label: "In flight", status: "IN_FLIGHT", value: summary.status === "ready" ? summary.value.counts.IN_FLIGHT : null },
    { label: "Failed", status: "FAILED", value: summary.status === "ready" ? summary.value.counts.FAILED : null },
    { label: "Dead letters", status: "DEAD_LETTERED", value: summary.status === "ready" ? summary.value.counts.DEAD_LETTERED : null },
  ];
  return <section className="dashboard-stats" aria-label="Delivery summary" aria-busy={summary.status === "loading"}>{stats.map(stat => <div className={`dashboard-stat dashboard-status-${stat.status.toLowerCase()}`} key={stat.status}><span className="dashboard-stat-icon" aria-hidden="true">{stat.status === "total" ? <Icon name="activity"/> : <i/>}</span><div><strong>{stat.value === null ? <span className="dashboard-skeleton"/> : formatCount(stat.value)}</strong><span className="dashboard-stat-label">{stat.label}</span>{stat.status === "total" && summary.status === "ready" && <small className="dashboard-pending-count">{formatCount(summary.value.counts.PENDING)} pending</small>}</div></div>)}</section>;
}
function Outcomes({ summary, retry }: { summary: Resource<DeliverySummary>; retry: () => void }) {
  if (summary.status === "error") return <DashboardPanel title="Delivery outcomes"><ResourceError error={summary.error} retry={retry}/></DashboardPanel>;
  if (summary.status === "loading") return <DashboardPanel title="Delivery outcomes"><div className="dashboard-outcome-loading" role="status">Loading delivery outcomes…<span className="dashboard-skeleton"/></div></DashboardPanel>;
  const data = summary.value;
  const ordered: DeliveryStatus[] = ["SUCCEEDED", "IN_FLIGHT", "FAILED", "DEAD_LETTERED", "PENDING"];
  return <><DashboardPanel title="Delivery outcomes" className="dashboard-outcomes" actions={<strong className="dashboard-rate">{formatRate(data.successRatePercent)}</strong>}>
    <p className="dashboard-outcome-caption">{data.completed ? "Success rate among completed deliveries." : "No completed deliveries yet."}</p>
    <div className="dashboard-outcome-bar" role="img" aria-label={data.total ? deliveryStatuses.map(status => `${formatCount(data.counts[status])} ${statusLabels[status].toLowerCase()}`).join(", ") : "No delivery outcomes yet"}>{ordered.map(status => data.counts[status] > 0 && <span className={`dashboard-outcome-${status.toLowerCase()}`} key={status} style={{ width: `${data.counts[status] / data.total * 100}%` }}/>)}</div>
    <dl className="dashboard-outcome-legend">{ordered.map(status => <div key={status}><dt><i className={`dashboard-outcome-${status.toLowerCase()}`}/>{status === "DEAD_LETTERED" ? "Dead letters" : statusLabels[status]}</dt><dd>{formatCount(data.counts[status])}{data.total > 0 && <> ({(data.counts[status] / data.total * 100).toFixed(1)}%)</>}</dd></div>)}</dl>
  </DashboardPanel><div className={data.counts.DEAD_LETTERED ? "dashboard-dead-notice" : "dashboard-dead-notice is-clear"}><DashboardGlyph name={data.counts.DEAD_LETTERED ? "alert" : "workspace"}/><div><strong>{data.counts.DEAD_LETTERED ? `${formatCount(data.counts.DEAD_LETTERED)} dead-lettered ${data.counts.DEAD_LETTERED === 1 ? "delivery" : "deliveries"}` : "No dead-lettered deliveries"}</strong><p>{data.counts.DEAD_LETTERED ? "Review archived failures and replay eligible events." : "Exhausted deliveries will appear here."}</p></div>{data.counts.DEAD_LETTERED > 0 && <DeferredLink className="dashboard-text-link">View <Icon name="arrow"/></DeferredLink>}</div></>;
}
export function Overview() {
  const { apiOrigin, state, invalidate } = useDashboard(); const params = useParams<{ tenantId: string }>();
  const workspace = state.status === "ready" ? selectedWorkspace(state.session, params.tenantId) : null;
  const [revision, setRevision] = useState(0); const [data, setData] = useState<{ tenantId: string; summary: Resource<DeliverySummary>; history: Resource<DeliveryHistory> }>({ tenantId: "", summary: { status: "loading" }, history: { status: "loading" } });
  const tenantId = workspace?.id;
  useEffect(() => {
    if (!tenantId) return;
    const controller = new AbortController(); let alive = true;
    setData({ tenantId, summary: { status: "loading" }, history: { status: "loading" } });
    function errorFor(error: unknown) { return error instanceof DashboardApiError ? error : new DashboardApiError(0, "The request could not be completed. Please try again."); }
    requestDashboardApi(apiOrigin, `/tenants/${encodeURIComponent(tenantId)}/deliveries/summary`, { signal: controller.signal })
      .then(readDeliverySummary).then(summary => { if (alive) setData(value => ({ ...value, summary: { status: "ready", value: summary } })); })
      .catch((error: unknown) => { if (!alive || controller.signal.aborted) return; const failure = errorFor(error); if (failure.status === 401) invalidate(); else setData(value => ({ ...value, summary: { status: "error", error: failure } })); });
    requestDashboardApi(apiOrigin, `/tenants/${encodeURIComponent(tenantId)}/deliveries?limit=5`, { signal: controller.signal })
      .then(value => readDeliveryHistory(value, tenantId)).then(history => { if (alive) setData(value => ({ ...value, history: { status: "ready", value: history } })); })
      .catch((error: unknown) => { if (!alive || controller.signal.aborted) return; const failure = errorFor(error); if (failure.status === 401) invalidate(); else setData(value => ({ ...value, history: { status: "error", error: failure } })); });
    return () => { alive = false; controller.abort(); };
  }, [apiOrigin, tenantId, revision, invalidate]);
  if (state.status !== "ready" || !workspace) return null;
  const current = data.tenantId === workspace.id ? data : { summary: { status: "loading" } as Resource<DeliverySummary>, history: { status: "loading" } as Resource<DeliveryHistory> };
  const retry = () => setRevision(value => value + 1);
  const denied = [current.summary, current.history].find(value => value.status === "error" && [403, 404].includes(value.error.status));
  if (denied?.status === "error") return <div className="dashboard-overview"><ResourceError error={denied.error} retry={retry}/></div>;
  return <div className="dashboard-overview"><header className="dashboard-page-heading"><DashboardArtwork/><div><h1>Good to see you, {state.session.user.githubLogin}.</h1><p>Here’s what’s happening with your webhooks.</p></div></header><StatCards summary={current.summary} retry={retry}/><div className="dashboard-overview-grid"><DashboardPanel className="dashboard-recent" title="Recent activity" subtitle="Latest webhook events across all statuses." actions={<div className="dashboard-panel-actions"><button className="dashboard-refresh" type="button" aria-label="Refresh Overview" disabled={current.summary.status === "loading" || current.history.status === "loading"} onClick={retry}><Icon name="retry"/></button><DeferredLink className="dashboard-text-link">View all <Icon name="arrow"/></DeferredLink></div>}>
    {current.history.status === "error" ? <ResourceError error={current.history.error} retry={retry}/> : current.history.status === "loading" ? <div className="dashboard-history-loading" role="status">Loading recent deliveries…{[0, 1, 2, 3, 4].map(index => <span className="dashboard-skeleton" key={index}/>)}</div> : current.history.value.items.length === 0 ? <div className="dashboard-empty"><Icon name="archive"/><h3>No deliveries yet</h3><p>Your latest delivery records will appear here once events are dispatched.</p></div> : <div className="dashboard-table-scroll" role="region" aria-label="Recent deliveries, times in UTC" tabIndex={0}><table className="dashboard-table"><thead><tr><th scope="col">Event</th><th scope="col">Method</th><th scope="col">Destination</th><th scope="col">Status</th><th scope="col">Time (UTC)</th><th scope="col"><span className="dashboard-sr-only">Delivery details</span></th></tr></thead><tbody>{current.history.value.items.map(row => {
      const timestamp = formatTimestamp(row.createdAt);
      return <tr key={row.id}><td><span className={`dashboard-row-dot dashboard-dot-${row.status.toLowerCase()}`} aria-hidden="true"/><div><strong>{row.event.type}</strong><span title={row.eventId}>{row.eventId}</span></div></td><td><span className="dashboard-method">POST</span></td><td><span className="dashboard-destination" title={row.targetUrl}>{row.targetUrl}</span></td><td><StatusChip row={row}/></td><td><time dateTime={row.createdAt}><span>{timestamp.day}</span><small>{timestamp.time}</small></time></td><td><DeferredLink label={`Details for ${row.event.type}`}><DashboardGlyph name="chevron"/></DeferredLink></td></tr>;
    })}</tbody></table></div>}
  </DashboardPanel><aside className="dashboard-overview-side" aria-label="Delivery outcomes"><Outcomes summary={current.summary} retry={retry}/></aside></div></div>;
}
