import { monitoringQueries } from '../lib/observability';
import { instantKeys, monitoringRanges, type MetricState, type MetricValue, type MonitoringPoint, type MonitoringRange, type MonitoringReport, type MonitoringSeries } from '../lib/monitoring';

type Env = Record<string, string | undefined>;
type Sample = [number, string];
type Series = { metric: Record<string, string>; values: Sample[] };
type Query = { ok: true; series: Series[] } | { ok: false; series: [] };
export const monitoringLimits = { bodyBytes: 524288, responseBytes: 1048576, series: 8, points: 721, queryMs: 5000, snapshotMs: 8000, sessionMs: 3000, cacheMs: 10000 } as const;
export const fixedMonitoringQueries = {
  ...Object.fromEntries(Object.entries(monitoringQueries).map(([key, expression]) => [key, expression.replaceAll('$__rate_interval', '1m')])),
  up: 'up{job=~"waybill-(api|publisher|worker)"}',
  scrapeTime: 'timestamp(up{job=~"waybill-(api|publisher|worker)"})',
  sampleSuccess: 'waybill_backlog_sample_success',
  sampleTime: 'waybill_backlog_sample_timestamp_seconds',
  durationObservations: 'sum(rate(waybill_webhook_duration_seconds_count[1m]))',
} as Record<string, string>;
const historyKeys = ['attempts', 'p50', 'p95', 'p99', 'durationObservations', 'up', 'scrapeTime'] as const;
class MonitoringError extends Error { constructor(public status: number, message: string) { super(message); } }
function fail(status: number, message: string): never { throw new MonitoringError(status, message); }
export function operatorIds(value: string | undefined): Set<string> {
  if (!value || value.length > 4096) return new Set();
  const ids = value.split(',').map(id => id.trim());
  return ids.length <= 100 && ids.every(id => /^[1-9][0-9]{0,19}$/.test(id)) ? new Set(ids) : new Set();
}
function origin(value: string | undefined): URL {
  try { const url = new URL(value ?? ''); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(); return url; }
  catch { return fail(503, 'Monitoring configuration is unavailable.'); }
}
export function monitoringTopology(env: Env, request: Request) {
  const api = origin(env.AUTH_API_ORIGIN); const web = origin(env.AUTH_WEB_ORIGIN);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(web.hostname);
  const requestHost = request.headers.get('host');
  const matchingHost = requestHost ? requestHost.toLowerCase() === web.host : new URL(request.url).origin === web.origin;
  if (api.hostname !== web.hostname || api.protocol !== web.protocol || !matchingHost || (web.protocol !== 'https:' && (!local || env.NODE_ENV === 'production'))) fail(503, 'Monitoring session topology is unsupported.');
  if ((request.headers.get('origin') && request.headers.get('origin') !== web.origin) || request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'Monitoring access is restricted.');
  return { api, web, cookieName: api.protocol === 'https:' ? '__Host-waybill-session' : 'waybill-session' };
}
function prometheusOrigin(env: Env) {
  const url = origin(env.WAYBILL_PROMETHEUS_ORIGIN);
  const host = url.hostname;
  const privateHost = ['localhost', '127.0.0.1', '[::1]'].includes(host) || /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host) || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host) || /^[a-z][a-z0-9-]*$/.test(host) || host.endsWith('.internal');
  if (!privateHost) fail(503, 'Monitoring configuration is unavailable.');
  return url.origin;
}
async function boundedJson(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await response.body?.cancel(); throw new Error('Response bound'); }
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) { signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break; bytes += value.length; if (bytes > limit) throw new Error('Response bound'); chunks.push(value); }
    const body = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response'); return value as Record<string, unknown>; }
function parseQuery(value: unknown, range: boolean, start: number, end: number): Series[] {
  const body = object(value); const data = object(body.data);
  if (body.status !== 'success' || body.warnings !== undefined || body.infos !== undefined || data.resultType !== (range ? 'matrix' : 'vector') || !Array.isArray(data.result) || data.result.length > monitoringLimits.series) throw new Error('Partial or invalid response');
  const labelsSeen = new Set<string>();
  return data.result.map(item => {
    const row = object(item); const metric = object(row.metric);
    if (Object.keys(metric).length > 12 || Object.entries(metric).some(([k, v]) => k.length > 100 || typeof v !== 'string' || v.length > 200)) throw new Error('Invalid labels');
    const labelKey = JSON.stringify(Object.entries(metric).sort(([a], [b]) => a.localeCompare(b))); if (labelsSeen.has(labelKey)) throw new Error('Duplicate series'); labelsSeen.add(labelKey);
    const values = range ? row.values : [row.value];
    if (!Array.isArray(values) || values.length > (range ? monitoringLimits.points : 1)) throw new Error('Result bound');
    let previous = -Infinity;
    const samples: Sample[] = values.map(raw => { if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== 'number' || !Number.isFinite(raw[0]) || raw[0] < start || raw[0] > end || raw[0] <= previous || typeof raw[1] !== 'string' || !/^(?:NaN|[+-]?Inf|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i.test(raw[1])) throw new Error('Invalid sample'); previous = raw[0]; return [raw[0], raw[1]]; });
    return { metric: metric as Record<string, string>, values: samples };
  });
}
const metric = (state: MetricState, value: number | null = null): MetricValue => ({ state, value });
function number(raw: string | undefined, idle = false): MetricValue {
  if (raw === undefined) return metric('missing');
  const n = Number(raw); return Number.isFinite(n) && n >= 0 ? metric('ready', n) : metric(raw === 'NaN' && idle ? 'idle' : 'non-finite');
}
function at(series: Series, time?: number) { return (time === undefined ? series.values[0] : series.values.find(v => v[0] === time))?.[1]; }
function sourceHealth(up: Query | undefined, stamps: Query | undefined, job: string, now: number, time?: number): MetricState {
  if (!up?.ok || !stamps?.ok) return 'error';
  const sources = up.series.filter(s => s.metric.job === job); if (!sources.length) return 'missing';
  for (const source of sources) {
    const state = at(source, time); if (state === undefined) return 'missing'; if (state !== '1') return 'unavailable';
    const stamp = stamps.series.find(s => s.metric.job === job && s.metric.instance === source.metric.instance); const timestamp = Number(stamp && at(stamp, time));
    if (!Number.isFinite(timestamp) || timestamp <= 0 || now - timestamp >= 45 || now < timestamp) return 'stale';
  }
  return 'ready';
}
function readMetric(query: Query | undefined, health: MetricState, label?: [string, string], idle = false): MetricValue {
  if (!query?.ok) return metric('error'); if (health !== 'ready') return metric(health);
  const rows = label ? query.series.filter(s => s.metric[label[0]] === label[1]) : query.series;
  if (!rows.length) return metric('missing');
  const numbers = rows.map(row => number(at(row), idle)); const invalid = numbers.find(n => n.state !== 'ready');
  return invalid ?? metric('ready', numbers.reduce((sum, n) => sum + n.value!, 0));
}
export function createMonitoringHandler(requestFetch: typeof fetch = fetch, clock = () => Date.now()) {
  const freshness = new WeakMap<MonitoringReport, number>();
  const cache = new Map<string, { expires: number; report: MonitoringReport }>(); const inflight = new Map<string, Promise<MonitoringReport>>();
  async function snapshot(prometheus: string, range: MonitoringRange): Promise<MonitoringReport> {
    const checkedAt = Math.floor(clock() / 1000); const { seconds, step } = monitoringRanges[range]; const end = Math.floor(checkedAt / step) * step; const start = end - seconds;
    const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), monitoringLimits.snapshotMs);
    const current: Record<string, Query> = {}; const history: Record<string, Query> = {};
    const jobs = [...Object.keys(fixedMonitoringQueries).map(key => ({ key, historical: false })), ...historyKeys.map(key => ({ key, historical: true }))]; let next = 0;
    try {
      await Promise.all(Array.from({ length: 3 }, async () => { while (next < jobs.length) {
        const job = jobs[next++]!; const target = job.historical ? history : current;
        try {
          controller.signal.throwIfAborted(); const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(monitoringLimits.queryMs)]);
          const url = new URL(job.historical ? '/api/v1/query_range' : '/api/v1/query', prometheus);
          url.searchParams.set('query', fixedMonitoringQueries[job.key]!); url.searchParams.set('timeout', '4s');
          if (job.historical) { url.searchParams.set('start', String(start)); url.searchParams.set('end', String(end)); url.searchParams.set('step', String(step)); } else url.searchParams.set('time', String(checkedAt));
          const response = await requestFetch(url, { signal, redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
          if (!response.ok) { await response.body?.cancel(); throw new Error('Query unavailable'); }
          target[job.key] = { ok: true, series: parseQuery(await boundedJson(response, signal, monitoringLimits.bodyBytes), job.historical, job.historical ? start : checkedAt, job.historical ? end : checkedAt) };
        } catch { target[job.key] = { ok: false, series: [] }; }
      } }));
    } finally { clearTimeout(deadline); }
    if (!Object.values(current).some(q => q.ok)) fail(503, 'Monitoring is temporarily unavailable.');
    const health = (job: string) => sourceHealth(current.up, current.scrapeTime, job, checkedAt);
    const worker = health('waybill-worker'); const api = health('waybill-api'); const publisher = health('waybill-publisher');
    const idle = readMetric(current.durationObservations, worker).value === 0;
    function backlog(source: string): MetricState {
      if (publisher !== 'ready') return publisher;
      if (!current.sampleSuccess?.ok || !current.sampleTime?.ok) return 'error';
      const rows = current.sampleSuccess.series.filter(s => s.metric.source === source); if (!rows.length) return 'missing';
      const valid = rows.some(s => { const stamp = current.sampleTime!.series.find(t => t.metric.instance === s.metric.instance && t.metric.job === s.metric.job && t.metric.source === source); const time = Number(stamp && at(stamp)); return at(s) === '1' && time > 0 && checkedAt >= time && checkedAt - time < 90; });
      if (valid) return 'ready'; return rows.some(s => at(s) === '1') ? 'stale' : 'unavailable';
    }
    const instant: MonitoringReport['instant'] = { attempts: readMetric(current.attempts, worker), p95: readMetric(current.p95, worker, undefined, idle), retries: readMetric(current.retries, worker), deadLetters: readMetric(current.deadLetters, worker), outbox: readMetric(current.outbox, backlog('outbox')), visible: readMetric(current.queue, backlog('sqs'), ['state', 'visible']), inFlight: readMetric(current.queue, backlog('sqs'), ['state', 'in_flight']), delayed: readMetric(current.queue, backlog('sqs'), ['state', 'delayed']), clientErrors: readMetric(current.apiErrors, api, ['status_class', '4xx']), serverErrors: readMetric(current.apiErrors, api, ['status_class', '5xx']), aborted: readMetric(current.apiErrors, api, ['status_class', 'aborted']) };
    function historical(key: string, label: string, outcome?: string): MonitoringSeries {
      const q = history[key]; if (!q?.ok) return { label, state: 'error', points: [] };
      const rows = outcome ? q.series.filter(s => s.metric.outcome === outcome) : q.series;
      const times = [...new Set(rows.flatMap(s => s.values.map(v => v[0])))].sort((a, b) => a - b);
      const points: MonitoringPoint[] = times.map(time => {
        const h = sourceHealth(history.up, history.scrapeTime, 'waybill-worker', time, time);
        if (h !== 'ready') return { time, ...metric(h) };
        const count = history.durationObservations?.ok ? history.durationObservations.series.find(s => at(s, time) !== undefined) : undefined;
        const isIdle = count && at(count, time) === '0';
        const numbers = rows.map(row => number(at(row, time), Boolean(isIdle))); const invalid = numbers.find(n => n.state !== 'ready');
        return { time, ...(invalid ?? metric('ready', numbers.reduce((sum, n) => sum + n.value!, 0))) };
      });
      return { label, state: points.some(p => p.state === 'ready') ? 'ready' : points[0]?.state ?? 'missing', points };
    }
    const report: MonitoringReport = { range, start, end, step, checkedAt, partial: [...Object.values(current), ...Object.values(history)].some(q => !q.ok), instant, history: { attempts: [historical('attempts', 'success', 'success'), historical('attempts', 'failure', 'failure')], duration: ['p50', 'p95', 'p99'].map(label => historical(label, label)) } };
    const boundaries = [['scrapeTime', 45], ['sampleTime', 90]] as const;
    const expiries = boundaries.flatMap(([key, age]) => current[key]?.ok ? current[key].series.map(s => (Number(at(s)) + age) * 1000).filter(value => Number.isFinite(value) && value > checkedAt * 1000) : []);
    freshness.set(report, Math.min(clock() + monitoringLimits.cacheMs, ...expiries));
    return report;
  }
  return async function handle(request: Request, env: Env): Promise<Response> {
    const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    try {
      const { api, cookieName } = monitoringTopology(env, request);
      const cookies = (request.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(cookieName + '='));
      if (cookies.length !== 1 || !new RegExp(`^${cookieName}=[A-Za-z0-9_-]{43}$`).test(cookies[0]!)) fail(401, 'Sign in required.');
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(monitoringLimits.sessionMs)]);
      let response: Response;
      try { response = await requestFetch(new URL('/auth/me', api), { headers: { Cookie: cookies[0]!, Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal }); } catch { return Response.json({ error: 'Session verification is unavailable.' }, { status: 503, headers }); }
      if (response.status === 401) { await response.body?.cancel(); fail(401, 'Sign in required.'); }
      if (!response.ok) { await response.body?.cancel(); fail(503, 'Session verification is unavailable.'); }
      const session = object(await boundedJson(response, signal, 65536)); const user = object(session.user);
      if (typeof user.githubId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(user.githubId) || typeof session.expiresAt !== 'string' || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= clock()) fail(401, 'Sign in required.');
      if (!operatorIds(env.WAYBILL_OPERATOR_GITHUB_IDS).has(user.githubId)) fail(403, 'Operator access required.');
      const params = new URL(request.url).searchParams;
      if ([...params.keys()].some(key => key !== 'range') || params.getAll('range').length > 1) fail(400, 'Use a supported monitoring range.');
      const range = params.get('range') ?? '24h'; if (!Object.hasOwn(monitoringRanges, range)) fail(400, 'Use a supported monitoring range.');
      const prometheus = prometheusOrigin(env); const key = prometheus + ':' + range; const entry = cache.get(key);
      let report: MonitoringReport;
      if (entry && entry.expires > clock()) report = entry.report;
      else {
        let pending = inflight.get(key);
        if (!pending) {
          if (inflight.size >= 3) fail(503, 'Monitoring is busy. Try again shortly.');
          pending = snapshot(prometheus, range as MonitoringRange); inflight.set(key, pending);
          void pending.finally(() => inflight.delete(key)).catch(() => {});
        }
        report = await pending;
        if (cache.size >= 3) cache.delete(cache.keys().next().value!);
        cache.set(key, { expires: Math.min(clock() + monitoringLimits.cacheMs, freshness.get(report) ?? 0), report });
      }
      const body = JSON.stringify(report); if (new TextEncoder().encode(body).length > monitoringLimits.responseBytes) fail(503, 'Monitoring result is unavailable.');
      return new Response(body, { headers: { ...headers, 'Content-Type': 'application/json' } });
    } catch (error) { return Response.json({ error: error instanceof MonitoringError ? error.message : 'Monitoring is temporarily unavailable.' }, { status: error instanceof MonitoringError ? error.status : 503, headers }); }
  };
}
