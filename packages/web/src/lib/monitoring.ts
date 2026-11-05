export const monitoringRanges = { '5m': { seconds: 300, step: 15 }, '1h': { seconds: 3600, step: 15 }, '6h': { seconds: 21600, step: 60 }, '24h': { seconds: 86400, step: 120 } } as const;
export type MonitoringRange = keyof typeof monitoringRanges;
export type MetricState = 'ready' | 'missing' | 'stale' | 'idle' | 'non-finite' | 'unavailable' | 'error';
export type MetricValue = { state: MetricState; value: number | null };
export type MonitoringPoint = MetricValue & { time: number };
export type MonitoringSeries = { label: string; state: MetricState; points: MonitoringPoint[] };
export const instantKeys = ['attempts', 'p95', 'retries', 'deadLetters', 'outbox', 'visible', 'inFlight', 'delayed', 'clientErrors', 'serverErrors', 'aborted'] as const;
export type MonitoringReport = { range: MonitoringRange; start: number; end: number; step: number; checkedAt: number; partial: boolean; instant: Record<typeof instantKeys[number], MetricValue>; history: { attempts: MonitoringSeries[]; duration: MonitoringSeries[] } };
export const metricStateLabels: Record<MetricState, string> = { ready: 'Observed', missing: 'No series observed', stale: 'Stale sample', idle: 'No observations in window', 'non-finite': 'Non-finite sample', unavailable: 'Source unavailable', error: 'Query unavailable' };
export function metricText(metric: MetricValue | undefined) {
  if (!metric) return 'Loading…';
  if (metric.state !== 'ready') return metric.state === 'idle' ? 'No observations' : 'Unavailable';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(metric.value!);
}
export function monitoringSegments(points: MonitoringPoint[], step: number) {
  const segments: MonitoringPoint[][] = []; let current: MonitoringPoint[] = [];
  for (const point of points) {
    if (point.state !== 'ready' || point.value === null) { if (current.length) segments.push(current); current = []; continue; }
    if (current.length && point.time - current.at(-1)!.time > step * 1.5) { segments.push(current); current = []; }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
export function readMonitoringReport(value: unknown, range: MonitoringRange): MonitoringReport {
  const data = value as MonitoringReport;
  const states = Object.keys(metricStateLabels);
  const validMetric = (m: MetricValue) => m && states.includes(m.state) && (m.state === 'ready' ? typeof m.value === 'number' && Number.isFinite(m.value) && m.value >= 0 : m.value === null);
  if (!data || data.range !== range || data.step !== monitoringRanges[range].step || !Number.isFinite(data.checkedAt) || !Number.isFinite(data.start) || !Number.isFinite(data.end) || data.end - data.start !== monitoringRanges[range].seconds || typeof data.partial !== 'boolean' || !data.instant || !instantKeys.every(k => validMetric(data.instant[k]))) throw new Error('Invalid monitoring response');
  for (const [key, labels] of [['attempts', ['success', 'failure']], ['duration', ['p50', 'p95', 'p99']]] as const) {
    const series = data.history?.[key];
    if (!Array.isArray(series) || series.length !== labels.length || !labels.every(label => series.filter(s => s.label === label).length === 1)) throw new Error('Invalid monitoring history');
    for (const s of series) if (!states.includes(s.state) || !Array.isArray(s.points) || s.points.length > 721 || s.points.some((p, i) => !validMetric(p) || !Number.isFinite(p.time) || p.time < data.start || p.time > data.end || (i > 0 && p.time <= s.points[i - 1]!.time))) throw new Error('Invalid monitoring points');
  }
  return data;
}
