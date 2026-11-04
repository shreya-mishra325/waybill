'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { selectedWorkspace } from '../../lib/dashboard-format';
import type { GrafanaLink } from '../../lib/observability';
import { monitoringRanges, readMonitoringReport, type MonitoringRange, type MonitoringReport } from '../../lib/monitoring';
import { useDashboard } from './provider';
import { DashboardArtwork } from './artwork';
import { ApiErrorsPanel, BacklogPanel, ObservabilityStats, MonitoringChart } from './observability-panels';

type Resource = { range: MonitoringRange; status: 'loading' | 'ready' | 'error' | 'restricted'; report?: MonitoringReport; error?: string };
export function Observability({ grafana }: { grafana: GrafanaLink }) {
  const { state } = useDashboard(); const { tenantId } = useParams<{ tenantId: string }>();
  const workspace = state.status === 'ready' ? selectedWorkspace(state.session, tenantId) : null;
  return workspace ? <ObservabilityContent key={workspace.id} grafana={grafana}/> : null;
}
function ObservabilityContent({ grafana }: { grafana: GrafanaLink }) {
  const { invalidate } = useDashboard(); const [range, setRange] = useState<MonitoringRange>('24h'); const [revision, setRevision] = useState(0);
  const [resource, setResource] = useState<Resource>({ range: '24h', status: 'loading' });
  const current: Resource = resource.range === range ? resource : { range, status: 'loading' };
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() { timer = setTimeout(() => { if (document.visibilityState === 'visible') void load(); else schedule(); }, 30000); }
    async function load() {
      if (controller.signal.aborted) return;
      setResource({ range, status: 'loading' });
      try {
        const response = await fetch(`/api/observability?range=${range}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (controller.signal.aborted) return;
        if (response.status === 401) { await response.body?.cancel(); invalidate(); return; }
        if (response.status === 403) { await response.body?.cancel(); setResource({ range, status: 'restricted' }); return; }
        if (!response.ok) { await response.body?.cancel(); throw new Error('Monitoring is temporarily unavailable. Please try again.'); }
        const body = await response.text(); if (new TextEncoder().encode(body).length > 1048576) throw new Error('Monitoring response is unavailable.');
        const report = readMonitoringReport(JSON.parse(body), range);
        if (!controller.signal.aborted) setResource({ range, status: 'ready', report });
      } catch {
        if (controller.signal.aborted) return;
        setResource({ range, status: 'error', error: 'Monitoring is temporarily unavailable. Please try again.' });
      }
      if (!controller.signal.aborted) schedule();
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [range, revision, invalidate]);
  const report = current.status === 'ready' ? current.report : undefined;
  const loading = current.status === 'loading'; const restricted = current.status === 'restricted';
  const status = loading ? 'Loading authorized monitoring…' : restricted ? 'Operator access required' : current.status === 'error' ? 'Monitoring unavailable' : report?.partial ? 'Some monitoring queries are unavailable' : `Checked ${new Date((report?.checkedAt ?? 0) * 1000).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC`;
  return <section className="dashboard-observability" aria-labelledby="observability-heading" aria-busy={loading}>
    <header className="dashboard-page-heading"><div className="obs-heading-copy"><h1 id="observability-heading">Observability</h1><p>System-wide monitoring of Waybill’s API, publisher, and worker.</p></div><DashboardArtwork/>{!restricted && <div className="obs-controls"><div><label><span className="dashboard-sr-only">Monitoring time range</span><select value={range} onChange={event => { if (Object.hasOwn(monitoringRanges, event.target.value)) setRange(event.target.value as MonitoringRange); }}>{Object.keys(monitoringRanges).map(value => <option key={value} value={value}>Last {value === '1h' ? '1 hour' : value === '6h' ? '6 hours' : '24 hours'}</option>)}</select></label><button className="dashboard-button" type="button" disabled={loading} onClick={() => setRevision(value => value + 1)} aria-label="Refresh monitoring data"><span aria-hidden="true">↻</span>{loading ? 'Loading…' : 'Refresh'}</button></div><span className="obs-connection-label" role="status">{status}</span></div>}</header>
    {restricted ? <section className="obs-restricted dashboard-panel" role="status"><h2>Operator access required</h2><p>System-wide monitoring is restricted to explicitly authorized operators.</p></section> : <>{current.status === 'error' && <div className="obs-request-error" role="alert"><p>{current.error}</p><button type="button" className="dashboard-button" onClick={() => setRevision(value => value + 1)}>Try again</button></div>}{report?.partial && <p className="obs-partial" role="status">Some queries could not be completed. Affected measurements remain unavailable.</p>}<ObservabilityStats report={report}/><div className="obs-panels"><MonitoringChart id="volume" title="Webhook attempt volume" description="Rate of completed webhook calls observed over time." unit="Attempts / second" series={report?.history.attempts} report={report} loading={loading} legend={[{ label: 'Success', color: '#173e52' }, { label: 'Failure', color: '#83a6b9' }]}/><MonitoringChart id="duration" title="Webhook response time" description="HTTP call duration percentiles (p50 · p95 · p99)." unit="Duration (seconds)" series={report?.history.duration} report={report} loading={loading} legend={[{ label: 'p50', color: '#173e52' }, { label: 'p95', color: '#587e95' }, { label: 'p99', color: '#abc4cf' }]}/><BacklogPanel report={report}/><ApiErrorsPanel report={report}/></div></>}
    <footer className="obs-integration"><p>System-wide metrics cover all services, not the selected workspace. Missing or idle observations remain unavailable. Authorized data refreshes every 30 seconds; server snapshots may be reused for 10 seconds.</p><div>{grafana.status === 'configured' ? <a className="obs-grafana-link" href={grafana.href} target="_blank" rel="noopener noreferrer">Open existing Grafana dashboard <span aria-hidden="true">↗</span><span className="dashboard-sr-only"> (opens a new tab)</span></a> : <span className="obs-link-unavailable">Grafana dashboard link unavailable</span>}<span>Separate operator authentication required</span></div></footer>
  </section>;
}
