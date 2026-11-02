import { monitoringScope, observabilityStats } from "../../lib/observability";

export function ObservabilityStats() {
  return <section className="obs-stats" aria-label="System-wide monitoring summaries">{observabilityStats.map(stat => <article className="obs-stat dashboard-panel" key={stat.id} aria-labelledby={`obs-${stat.id}`}><header><h2 id={`obs-${stat.id}`}>{stat.title}</h2><span>{monitoringScope}</span></header><div><strong>Unavailable</strong><small>{stat.unit}</small></div><p>Connection required</p><span className="dashboard-sr-only">{stat.description}</span></article>)}</section>;
}
export function UnavailableMonitoringChart({ id, title, description, unit, legend }: { id: string; title: string; description: string; unit: string; legend: readonly { label: string; color: string }[] }) {
  return <section className="obs-chart dashboard-panel" aria-labelledby={`obs-${id}-title`}><header><div><h2 id={`obs-${id}-title`}>{title}</h2><p>{description}</p></div><span className="obs-scope">{monitoringScope}</span></header>
    <div className="obs-chart-frame" role="img" aria-label={`${title}: monitoring connection required. No values or historical series have been loaded. Vertical axis: ${unit}. Horizontal axis: time in UTC.`}>
      <span className="obs-y-axis">{unit}</span><div className="obs-empty-grid" aria-hidden="true">{[0, 1, 2, 3, 4].map(line => <span key={line}/>)}</div><div className="obs-plot-unavailable"><strong>Monitoring connection required</strong><span>No historical data loaded.</span></div><span className="obs-x-axis">Time (UTC)</span>
    </div><ul className="obs-legend" aria-label="Unavailable monitoring series">{legend.map(item => <li key={item.label}><i style={{ backgroundColor: item.color }} aria-hidden="true"/>{item.label}</li>)}</ul>
  </section>;
}
export function BacklogPanel() {
  return <section className="obs-bottom-panel dashboard-panel" aria-labelledby="obs-backlog-title"><header><div><h2 id="obs-backlog-title">Queue and outbox depth</h2><p>Fresh backlog samples from the publisher.</p></div><span className="obs-scope">{monitoringScope}</span></header><dl className="obs-metric-rows"><div><dt>Pending outbox rows<small>waybill:outbox_pending:fresh</small></dt><dd>Unavailable</dd></div><div><dt>Approximate SQS messages<small>Visible · In flight · Delayed</small></dt><dd>Unavailable</dd></div></dl><p className="obs-panel-note">Missing, failed, or stale samples are unavailable, never zero. Fresh samples require an UP publisher and a successful sample less than 90 seconds old; future timestamps are excluded.</p></section>;
}
export function ApiErrorsPanel() {
  return <section className="obs-bottom-panel dashboard-panel" aria-labelledby="obs-api-errors-title"><header><div><h2 id="obs-api-errors-title">API error rates</h2><p>HTTP outcomes excluding health checks; requests / sec.</p></div><span className="obs-scope">{monitoringScope}</span></header><dl className="obs-metric-rows">{[{ label: "4xx · Client errors", description: "Rejected or invalid requests" }, { label: "5xx · Server errors", description: "Server-side request failures" }, { label: "Aborted requests", description: "Client disconnects" }].map(row => <div key={row.label}><dt>{row.label}<small>{row.description}</small></dt><dd>Unavailable</dd></div>)}</dl><p className="obs-panel-note">These are system-wide request rates, not percentages or per-workspace analytics.</p></section>;
}
