"use client";

import { useState, useTransition } from "react";
import { useParams, useRouter } from "next/navigation";
import { selectedWorkspace } from "../../lib/dashboard-format";
import type { GrafanaLink } from "../../lib/observability";
import { useDashboard } from "./provider";
import { DashboardArtwork } from "./artwork";
import { ApiErrorsPanel, BacklogPanel, ObservabilityStats, UnavailableMonitoringChart } from "./observability-panels";

export function Observability({ grafana }: { grafana: GrafanaLink }) {
  const { state } = useDashboard(); const { tenantId } = useParams<{ tenantId: string }>();
  const workspace = state.status === "ready" ? selectedWorkspace(state.session, tenantId) : null;
  return workspace ? <ObservabilityContent key={workspace.id} grafana={grafana}/> : null;
}
function ObservabilityContent({ grafana }: { grafana: GrafanaLink }) {
  const { reload } = useDashboard(); const router = useRouter(); const [refreshing, startTransition] = useTransition(); const [checked, setChecked] = useState(false);
  function refresh() {
    startTransition(async () => { await reload(); router.refresh(); setChecked(true); });
  }
  return <section className="dashboard-observability" aria-labelledby="observability-heading">
    <header className="dashboard-page-heading"><div className="obs-heading-copy"><h1 id="observability-heading">Observability</h1><p>System-wide monitoring of Waybill’s API, publisher, and worker.</p></div><DashboardArtwork/><div className="obs-controls"><div><label><span className="dashboard-sr-only">Historical range; unavailable without a monitoring connection</span><select disabled value="24h" aria-describedby="obs-connection-description"><option value="24h">Last 24 hours</option></select></label><button className="dashboard-button" type="button" disabled={refreshing} aria-label="Refresh page access and monitoring link configuration" onClick={refresh}><span aria-hidden="true">↻</span>{refreshing ? "Checking…" : "Refresh page"}</button></div><span className="obs-connection-label" role="status">{refreshing ? "Checking page access…" : checked ? "Access checked · Connection required" : "Monitoring connection required"}</span></div></header>
    <ObservabilityStats/>
    <div className="obs-panels"><UnavailableMonitoringChart id="volume" title="Webhook attempt volume" description="Rate of completed webhook calls observed over time." unit="Attempts / second" legend={[{ label: "Success", color: "#173e52" }, { label: "Failure", color: "#83a6b9" }]}/><UnavailableMonitoringChart id="duration" title="Webhook response time" description="HTTP call duration percentiles (p50 · p95 · p99)." unit="Duration (seconds)" legend={[{ label: "p50", color: "#173e52" }, { label: "p95", color: "#587e95" }, { label: "p99", color: "#abc4cf" }]}/><BacklogPanel/><ApiErrorsPanel/></div>
    <footer className="obs-integration"><p id="obs-connection-description">Waybill has no authorized monitoring query connection. No metric values or trends are loaded here. These metrics cover all services, not the selected workspace.</p><div>{grafana.status === "configured" ? <a className="obs-grafana-link" href={grafana.href} target="_blank" rel="noopener noreferrer">Open existing Grafana dashboard <span aria-hidden="true">↗</span><span className="dashboard-sr-only"> (opens a new tab)</span></a> : <span className="obs-link-unavailable">Grafana dashboard link unavailable</span>}<span>Separate operator authentication required</span></div>{grafana.status !== "configured" && <p className="obs-configuration-error" role={grafana.status === "invalid" ? "alert" : "status"}>{grafana.status === "invalid" ? "The operator dashboard link configuration is invalid." : "An operator dashboard URL has not been configured for this deployment."}</p>}</footer>
  </section>;
}
