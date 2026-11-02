"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { DashboardApiError } from "../../lib/dashboard-api";
import { deliveryLabel, formatCount, formatTimestamp, selectedWorkspace } from "../../lib/dashboard-format";
import type { DeliveryRecord } from "../../lib/dashboard-types";
import { detailHistoryLimit, findDeliveryRecord, scheduledRetry } from "../../lib/delivery-details";
import { DashboardArtwork } from "./artwork";
import { useDashboard } from "./provider";
import { useDeliverySelection } from "./delivery-selection";
import { DeliveryRecordViewer } from "./delivery-record-viewer";
import { DashboardGlyph, StatusChip } from "./ui";

function RecordedTime({ value, absent = "Not recorded" }: { value: string | null; absent?: string }) {
  if (!value) return <span>{absent}</span>;
  const timestamp = formatTimestamp(value);
  return <time dateTime={value}>{timestamp.day}, {timestamp.time}</time>;
}
export function DeliveryResultPanel({ record }: { record: DeliveryRecord }) {
  const [tab, setTab] = useState<"information" | "error">("information");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const hasError = record.lastError !== null && record.lastError.length > 0;
  const tabs = [{ id: "information", label: "Delivery information" }, { id: "error", label: "Recorded error" }] as const;
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
    setTab(tabs[next]!.id); buttons.current[next]?.focus();
  }
  return <section className="details-result dashboard-panel">
    <div className="details-tabs" role="tablist" aria-label="Recorded delivery information">{tabs.map((item, index) => <button type="button" role="tab" id={`${id}-${item.id}-tab`} aria-controls={`${id}-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} key={item.id} ref={element => { buttons.current[index] = element; }} onClick={() => setTab(item.id)} onKeyDown={event => navigate(event, index)}>{item.label}</button>)}</div>
    <div id={`${id}-information`} role="tabpanel" aria-labelledby={`${id}-information-tab`} tabIndex={0} hidden={tab !== "information"}>
      <h2>Latest recorded result</h2><p>The delivery service stores its most recent outcome, not individual attempt logs.</p>
      <dl className="details-result-rows"><div><dt>Stored status</dt><dd>{record.status}{scheduledRetry(record) && " · awaiting retry"}</dd></div><div><dt>Attempts recorded</dt><dd>{formatCount(record.attemptCount)}</dd></div><div><dt>Last attempted</dt><dd><RecordedTime value={record.lastAttemptAt} absent={record.attemptCount === 0 ? "Not attempted yet" : "Not recorded"}/></dd></div><div><dt>Next attempt</dt><dd><RecordedTime value={scheduledRetry(record)} absent="No retry scheduled"/></dd></div></dl>
    </div>
    <div id={`${id}-error`} role="tabpanel" aria-labelledby={`${id}-error-tab`} tabIndex={0} hidden={tab !== "error"}><h2>Recorded error</h2><p>This is the stored error from delivery processing. Detailed HTTP response logs are not available.</p></div>
    <div className={hasError ? "details-stored-error has-error" : "details-stored-error"}><DashboardGlyph name="alert"/><div><strong>Last recorded error</strong><p>{hasError ? record.lastError : "No error recorded."}</p></div></div>
  </section>;
}
function DetailsContent({ tenantId, deliveryId }: { tenantId: string; deliveryId: string }) {
  const { apiOrigin, invalidate, switchWorkspace, reload } = useDashboard();
  const selection = useDeliverySelection();
  const [handoff] = useState(() => selection.read(deliveryId));
  const [revision, setRevision] = useState(0);
  type Resource = { status: "loading" } | { status: "ready"; record: DeliveryRecord } | { status: "missing"; limited: boolean } | { status: "error"; error: DashboardApiError };
  const [resource, setResource] = useState<Resource>(() => handoff?.tenantId === tenantId ? { status: "ready", record: handoff } : { status: "loading" });
  useEffect(() => {
    if (handoff?.tenantId === tenantId) return;
    const controller = new AbortController();
    setResource({ status: "loading" });
    findDeliveryRecord(apiOrigin, tenantId, deliveryId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setResource(result.record ? { status: "ready", record: result.record } : { status: "missing", limited: result.limited });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const failure = error instanceof DashboardApiError ? error : new DashboardApiError(0, "Unable to load this delivery. Please try again.");
      if (failure.status === 401) invalidate();
      else setResource({ status: "error", error: failure });
    });
    return () => controller.abort();
  }, [apiOrigin, tenantId, deliveryId, handoff, revision, invalidate]);
  const row = resource.status === "ready" ? resource.record : null;
  return <section className="dashboard-delivery-details" aria-labelledby="delivery-details-heading">
    <Link className="details-back-link" href={`/app/${tenantId}/deliveries`}><span aria-hidden="true">←</span>Back to Deliveries</Link>
    <header className="dashboard-page-heading"><div><h1 id="delivery-details-heading">Delivery details</h1><p>Inspect the current state of your webhook delivery.</p></div><DashboardArtwork/></header>
    {resource.status === "loading" ? <div className="details-loading dashboard-panel" role="status" aria-busy="true">Loading delivery record…<span className="dashboard-skeleton"/></div> : resource.status === "missing" ? <section className="details-unavailable dashboard-panel"><DashboardGlyph name="workspace"/><h2>Delivery unavailable</h2><p>{resource.limited ? `This delivery was not found among the latest ${detailHistoryLimit} records. Older deliveries can be opened by selecting them from the Deliveries list.` : "This delivery is not available in this workspace’s delivery history. Return to Deliveries and select an available record."}</p><Link className="dashboard-button" href={`/app/${tenantId}/deliveries`}>Back to Deliveries</Link></section> : resource.status === "error" ? <div className="dashboard-resource-error" role="alert"><DashboardGlyph name="alert"/><p>{resource.error.message}</p><button className="dashboard-button" type="button" onClick={resource.error.status === 403 || resource.error.status === 404 ? () => { switchWorkspace(); void reload(); } : () => setRevision(value => value + 1)}>{resource.error.status === 403 || resource.error.status === 404 ? "Choose a workspace" : "Try again"}</button></div> : row && <div className="details-grid">
      <div className="details-main-column">
        <section className="details-metadata dashboard-panel" aria-labelledby="details-event-name"><header><div><h2 id="details-event-name" title={row.event.type}>{row.event.type}</h2><p className="details-identifier">{row.id}</p></div><div className="details-recorded-state"><StatusChip row={row}/><div><span>Last attempt</span><RecordedTime value={row.lastAttemptAt}/></div></div></header>
          <dl className="details-metadata-grid"><div><dt>Destination</dt><dd>{row.targetUrl}</dd></div><div><dt>Current status</dt><dd>{row.status}</dd></div><div><dt>Attempts made</dt><dd>{formatCount(row.attemptCount)}</dd></div><div><dt>Event ID</dt><dd>{row.eventId}</dd></div><div className="details-created"><dt>Created at</dt><dd><RecordedTime value={row.createdAt}/></dd></div></dl>
        </section>
        <DeliveryResultPanel record={row}/>
      </div>
      <aside className="details-side-column" aria-label="Delivery status and record"><section className="details-status-summary dashboard-panel"><h2>Status summary</h2><dl><div><dt>Current state</dt><dd>{deliveryLabel(row)}</dd></div><div><dt>Next retry</dt><dd><RecordedTime value={scheduledRetry(row)} absent="No retry scheduled"/></dd></div></dl></section><DeliveryRecordViewer record={row}/></aside>
    </div>}
  </section>;
}
export function DeliveryDetails() {
  const { state } = useDashboard();
  const { tenantId, deliveryId } = useParams<{ tenantId: string; deliveryId: string }>();
  const workspace = state.status === "ready" ? selectedWorkspace(state.session, tenantId) : null;
  return workspace ? <DetailsContent key={`${workspace.id}:${deliveryId}`} tenantId={workspace.id} deliveryId={deliveryId}/> : null;
}
