import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMonitoringHandler, fixedMonitoringQueries, monitoringLimits, monitoringTopology, operatorIds } from '../src/server/observability';
import { metricText, monitoringRanges, monitoringSegments, readMonitoringReport, type MonitoringPoint, type MonitoringReport } from '../src/lib/monitoring';
import { MonitoringChart } from '../src/components/dashboard/observability-panels';

const epoch = 1793713246;
const configuration = { NODE_ENV: 'development', AUTH_API_ORIGIN: 'http://127.0.0.1:3000', AUTH_WEB_ORIGIN: 'http://127.0.0.1:3001', WAYBILL_PROMETHEUS_ORIGIN: 'http://127.0.0.1:9090', WAYBILL_OPERATOR_GITHUB_IDS: '42' };
function request(query = '?range=1h', cookie = true) { return new Request('http://127.0.0.1:3001/api/observability' + query, { headers: cookie ? { Cookie: 'waybill-session=' + 'a'.repeat(43) } : {} }); }
function fixture() {
  let now = epoch; let identity = '42'; let authStatus = 200;
  const calls: { url: URL; init?: RequestInit }[] = [];
  let change: (key: string, body: Record<string, unknown>, historical: boolean) => unknown = (_key, body) => body;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.pathname === '/auth/me') return Response.json(authStatus === 200 ? { user: { githubId: identity }, expiresAt: new Date((now + 3600) * 1000).toISOString() } : {}, { status: authStatus });
    const expression = url.searchParams.get('query'); const key = Object.keys(fixedMonitoringQueries).find(k => fixedMonitoringQueries[k] === expression);
    if (!key) throw new Error('Unexpected expression');
    const historical = url.pathname.endsWith('query_range'); const at = Number(url.searchParams.get('time') ?? url.searchParams.get('end'));
    const times = historical ? [Number(url.searchParams.get('start')), at - Number(url.searchParams.get('step')), at] : [at];
    const rows: { metric: Record<string, string>; value: string | ((t: number) => string) }[] = [];
    if (key === 'up' || key === 'scrapeTime') for (const role of ['api', 'publisher', 'worker']) rows.push({ metric: { job: 'waybill-' + role, instance: role }, value: key === 'up' ? '1' : t => String(t - 3) });
    else if (key === 'sampleSuccess' || key === 'sampleTime') for (const source of ['outbox', 'sqs']) rows.push({ metric: { job: 'waybill-publisher', instance: 'publisher', source }, value: key === 'sampleSuccess' ? '1' : t => String(t - 10) });
    else if (key === 'queue') for (const state of ['visible', 'in_flight', 'delayed']) rows.push({ metric: { state }, value: '0' });
    else if (key === 'apiErrors') for (const status_class of ['4xx', '5xx', 'aborted']) rows.push({ metric: { status_class }, value: '0' });
    else rows.push({ metric: key === 'attempts' ? { outcome: 'success' } : key === 'retries' ? { reason: 'webhook' } : {}, value: key.startsWith('p') ? '0.004' : key === 'outbox' || key === 'deadLetters' ? '0' : '1' });
    const result = rows.map(row => ({ metric: row.metric, [historical ? 'values' : 'value']: historical ? times.map(t => [t, typeof row.value === 'function' ? row.value(t) : row.value]) : [at, typeof row.value === 'function' ? row.value(at) : row.value] }));
    return Response.json(change(key, { status: 'success', data: { resultType: historical ? 'matrix' : 'vector', result } }, historical));
  }) as typeof fetch;
  return { handler: createMonitoringHandler(fetcher, () => now * 1000), fetcher, calls, setIdentity: (value: string) => identity = value, setStatus: (value: number) => authStatus = value, advance: (seconds = 11) => now += seconds, change: (fn: typeof change) => change = fn, prometheus: () => calls.filter(c => c.url.port === '9090') };
}
function mutate(body: Record<string, unknown>, transform: (result: { metric: Record<string, string>; value?: [number, string]; values?: [number, string][] }[]) => void) { transform((body.data as { result: Parameters<typeof transform>[0] }).result); return body; }

test('missing, empty, malformed and unlisted operator configurations deny authenticated users before querying Prometheus', async () => {
  for (const allowlist of [undefined, '', ' ', '42,', '42,bad', '042', '-42', '42\n43', '42.0', '0', '43']) {
    const f = fixture(); const response = await f.handler(request(), { ...configuration, WAYBILL_OPERATOR_GITHUB_IDS: allowlist });
    expect(response.status).toBe(403); expect(f.prometheus()).toHaveLength(0); expect(await response.text()).toBe('{"error":"Operator access required."}');
  }
  expect([...operatorIds(' 42, 43 ')]).toEqual(['42', '43']); expect(operatorIds('1,'.repeat(101)).size).toBe(0);
});
test('signed-out, expired and malformed sessions fail closed without Prometheus; client-supplied identity is never trusted', async () => {
  const f = fixture(); expect((await f.handler(request('', false), configuration)).status).toBe(401); expect(f.calls).toHaveLength(0);
  f.setStatus(401); expect((await f.handler(request(), configuration)).status).toBe(401);
  f.setStatus(200); f.setIdentity('43'); expect((await f.handler(request('?range=1h&githubId=42'), configuration)).status).toBe(403);
  f.setIdentity('042'); expect((await f.handler(request(), configuration)).status).toBe(401); expect(f.prometheus()).toHaveLength(0);
});
test('operator checks run on every request including cached snapshots and revocation denies the next request', async () => {
  const f = fixture(); const first = await f.handler(request(), configuration); expect(first.status).toBe(200); readMonitoringReport(await first.json(), '1h'); const count = f.prometheus().length;
  expect((await f.handler(request(), configuration)).status).toBe(200); expect(f.prometheus()).toHaveLength(count); expect(f.calls.filter(c => c.url.pathname === '/auth/me')).toHaveLength(2);
  f.setIdentity('43'); expect((await f.handler(request(), configuration)).status).toBe(403); expect(f.prometheus()).toHaveLength(count);
  f.setIdentity('42'); f.advance(); expect((await f.handler(request(), configuration)).status).toBe(200); expect(f.prometheus().length).toBeGreaterThan(count);
  expect(f.calls.find(c => c.url.pathname === '/auth/me')?.init?.headers).toEqual({ Cookie: 'waybill-session=' + 'a'.repeat(43), Accept: 'application/json' });
  expect(f.prometheus().every(c => !new Headers(c.init?.headers).has('Cookie') && !new Headers(c.init?.headers).has('Authorization'))).toBe(true);
  expect(first.headers.get('cache-control')).toBe('private, no-store');
});
test('topology preserves host-only cookies, rejects separate hosts, mixed schemes, production HTTP and cross-origin reads', async () => {
  const f = fixture();
  for (const changes of [{ AUTH_API_ORIGIN: 'http://localhost:3000' }, { AUTH_API_ORIGIN: 'https://127.0.0.1:3000' }, { AUTH_WEB_ORIGIN: 'http://elsewhere:3001' }, { NODE_ENV: 'production' }]) expect((await f.handler(request(), { ...configuration, ...changes })).status).toBe(503);
  expect((await f.handler(new Request(request(), { headers: { Cookie: 'waybill-session=' + 'a'.repeat(43), Origin: 'https://evil.example' } }), configuration)).status).toBe(403);
  expect(f.prometheus()).toHaveLength(0);
  expect(monitoringTopology({ AUTH_API_ORIGIN: 'https://waybill.example', AUTH_WEB_ORIGIN: 'https://waybill.example', NODE_ENV: 'production' }, new Request('https://waybill.example/api/observability')).cookieName).toBe('__Host-waybill-session');
  const duplicate = new Request(request(), { headers: { Cookie: `waybill-session=${'a'.repeat(43)}; waybill-session=${'b'.repeat(43)}` } }); expect((await f.handler(duplicate, configuration)).status).toBe(401);
});
test('only fixed queries and bounded range/steps are accepted; client URLs and PromQL never reach the datasource', async () => {
  for (const query of ['?range=7d', '?range=1h&range=24h', '?query=up', '?range=1h&url=http://evil', '?datasource=evil']) { const f = fixture(); expect((await f.handler(request(query), configuration)).status).toBe(400); expect(f.prometheus()).toHaveLength(0); }
  for (const range of ['1h', '6h', '24h'] as const) {
    const f = fixture(); const response = await f.handler(request('?range=' + range), configuration); expect(response.status).toBe(200); const report = readMonitoringReport(await response.json(), range); expect(report.end - report.start).toBe(monitoringRanges[range].seconds);
    for (const call of f.prometheus()) { expect(Object.values(fixedMonitoringQueries)).toContain(call.url.searchParams.get('query')); expect(call.url.origin).toBe('http://127.0.0.1:9090'); expect(call.init?.signal).toBeDefined(); expect(call.init?.redirect).toBe('error'); if (call.url.pathname.endsWith('query_range')) expect(call.url.searchParams.get('step')).toBe(String(monitoringRanges[range].step)); }
  }
  const f = fixture(); expect((await f.handler(request(), { ...configuration, WAYBILL_PROMETHEUS_ORIGIN: 'http://public.example' })).status).toBe(503); expect(f.prometheus()).toHaveLength(0);
});
test('zero, missing, stale, failed sampling and idle histogram values remain distinct', async () => {
  const zero = fixture(); const ready = await (await zero.handler(request(), configuration)).json() as MonitoringReport; expect(ready.instant.outbox).toEqual({ state: 'ready', value: 0 }); expect(ready.instant.p95.value).toBe(.004);
  for (const [key, alteration, expected] of [
    ['retries', 'missing', 'missing'], ['scrapeTime', 'old', 'stale'], ['sampleTime', 'future', 'stale'], ['sampleSuccess', 'failed', 'unavailable'],
  ] as const) {
    const f = fixture(); f.change((k, body, historical) => k !== key || historical ? body : mutate(body, rows => { if (alteration === 'missing') rows.splice(0); else for (const row of rows) row.value![1] = alteration === 'old' ? String(epoch - 100) : alteration === 'future' ? String(epoch + 60) : '0'; }));
    const report = await (await f.handler(request(), configuration)).json() as MonitoringReport; expect(report.instant[key === 'retries' ? 'retries' : key === 'scrapeTime' ? 'attempts' : 'outbox']).toEqual({ state: expected, value: null });
  }
  const idle = fixture(); idle.change((k, body) => ['p50','p95','p99','durationObservations'].includes(k) ? mutate(body, rows => { for (const row of rows) { if (row.value) row.value[1] = k === 'durationObservations' ? '0' : 'NaN'; if (row.values) for (const p of row.values) p[1] = k === 'durationObservations' ? '0' : 'NaN'; } }) : body);
  const report = await (await idle.handler(request(), configuration)).json() as MonitoringReport; expect(report.instant.p95).toEqual({ state: 'idle', value: null }); expect(report.history.duration.every(s => s.points.every(p => p.state === 'idle' && p.value === null))).toBe(true);
});
test('NaN/infinite/partial/oversized results cannot become valid measurements or leak source details', async () => {
  for (const value of ['NaN', '+Inf', '-Inf']) {
    const f = fixture(); f.change((key, body) => key === 'p95' ? mutate(body, rows => { for (const r of rows) { if (r.value) r.value[1] = value; } }) : body); const report = await (await f.handler(request(), configuration)).json() as MonitoringReport; expect(report.instant.p95).toEqual({ state: 'non-finite', value: null }); expect(JSON.stringify(report)).not.toContain(value);
  }
  const partial = fixture(); partial.change((key, body) => key === 'attempts' ? { ...body, warnings: ['private datasource detail'] } : body); const response = await partial.handler(request(), configuration); const report = await response.json() as MonitoringReport; expect(report.partial).toBe(true); expect(report.instant.attempts.state).toBe('error'); expect(JSON.stringify(report)).not.toContain('private datasource detail');
  const oversized = fixture(); oversized.change((key, body) => key === 'attempts' ? { ...body, extra: 'x'.repeat(monitoringLimits.bodyBytes + 1) } : body); expect(((await (await oversized.handler(request(), configuration)).json()) as MonitoringReport).instant.attempts.state).toBe('error');
  const bounded = fixture(); bounded.change((key, body) => key === 'attempts' ? mutate(body, rows => { rows.push(...Array.from({ length: 10 }, (_, i) => ({ metric: { extra: String(i) }, value: [epoch, '1'] as [number, string] }))); }) : body); expect(((await (await bounded.handler(request(), configuration)).json()) as MonitoringReport).instant.attempts.state).toBe('error');
});
test('authentication and monitoring requests have effective abort deadlines and safe failure responses', async () => {
  let monitoringCalls = 0;
  const hung = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/auth/me')) return Response.json({ user: { githubId: '42' }, expiresAt: new Date((epoch + 3600) * 1000).toISOString() });
    monitoringCalls++; return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('private source address')), { once: true }); });
  }) as typeof fetch;
  const before = Date.now(); const response = await createMonitoringHandler(hung, () => epoch * 1000)(request(), configuration); expect(response.status).toBe(503); expect(Date.now() - before).toBeLessThan(10000); expect(monitoringCalls).toBeLessThanOrEqual(6); expect(await response.text()).not.toContain('private source address');
}, 12000);
test('chart gaps and units preserve actual samples without interpolation or seconds-to-ms mistakes', () => {
  const point = (time: number, value: number | null): MonitoringPoint => ({ time, value, state: value === null ? 'missing' : 'ready' });
  const points = [point(0, .004), point(15, .005), point(30, null), point(45, .006), point(90, .007)];
  expect(monitoringSegments(points, 15).map(s => s.length)).toEqual([2, 1, 1]); expect(metricText({ state: 'ready', value: 0 })).toBe('0'); expect(metricText({ state: 'idle', value: null })).toBe('No observations');
  const html = renderToStaticMarkup(createElement(MonitoringChart, { id: 'duration', title: 'Duration', description: 'HTTP calls', unit: 'Duration (seconds)', legend: [{ label: 'p95', color: '#173e52' }], series: [{ label: 'p95', state: 'ready', points }], report: { start: 0, end: 90, step: 15 } as MonitoringReport }));
  expect(html).toContain('Duration (seconds)'); expect(html).toContain('System-wide'); expect(html).toContain('data-series="p95"'); expect(html).not.toContain('milliseconds');
});

test('session verification timeout never falls through to Prometheus', async () => {
  let count = 0;
  const fetcher = (async (_input: unknown, init?: RequestInit) => { count++; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true })); }) as typeof fetch;
  const response = await createMonitoringHandler(fetcher)(request(), configuration);
  expect(response.status).toBe(503); expect(count).toBe(1); expect(await response.text()).toBe('{"error":"Session verification is unavailable."}');
}, 6000);
test('streamed body bounds, excessive historical points and unsorted samples are rejected', async () => {
  for (const excessive of [true, false]) {
    const f = fixture(); f.change((key, body, historical) => key === 'p95' && historical ? mutate(body, rows => { rows[0]!.values = excessive ? Array.from({length:722},(_,i)=>[epoch-3600+i,'1']) : [[epoch,'1'],[epoch-15,'1']]; }) : body);
    const data = await (await f.handler(request(), configuration)).json() as MonitoringReport;
    expect(data.partial).toBe(true); expect(data.history.duration.find(s=>s.label==='p95')?.state).toBe('error');
  }
  const f = fixture(); const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes(':9090/')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(monitoringLimits.bodyBytes+1)); controller.close(); } }));
    return f.fetcher(input,init);
  }) as typeof fetch;
  expect((await createMonitoringHandler(wrapped,()=>epoch*1000)(request(),configuration)).status).toBe(503);
});

test('Next internal request URLs use the explicit configured Host while forged hosts remain denied', () => {
  expect(monitoringTopology(configuration,new Request('http://localhost:3001/api/observability',{headers:{Host:'127.0.0.1:3001'}})).cookieName).toBe('waybill-session');
  expect(()=>monitoringTopology(configuration,new Request('http://127.0.0.1:3001/api/observability',{headers:{Host:'evil.example'}}))).toThrow();
});

test('cached gauges expire before their sampling freshness boundary', async () => {
  const f=fixture(); f.change((key,body,historical)=>key==='sampleTime'&&!historical?mutate(body,rows=>{for(const row of rows)row.value![1]=String(epoch-85)}):body);
  const first=await (await f.handler(request(),configuration)).json() as MonitoringReport;expect(first.instant.outbox.state).toBe('ready');const count=f.prometheus().length;f.advance(6);
  const later=await (await f.handler(request(),configuration)).json() as MonitoringReport;expect(later.instant.outbox.state).toBe('stale');expect(f.prometheus().length).toBeGreaterThan(count);
});

test('forwarded headers cannot select authentication or Prometheus destinations; forged Host fails closed', async () => {
  const f = fixture();
  const forged = new Request(request(), { headers: { Cookie: 'waybill-session=' + 'a'.repeat(43), Host: 'evil.example', 'X-Forwarded-Host': '127.0.0.1:3001' } });
  expect((await f.handler(forged, configuration)).status).toBe(503); expect(f.calls).toHaveLength(0);
  const forwarded = new Request(request(), { headers: { Cookie: 'waybill-session=' + 'a'.repeat(43), Host: '127.0.0.1:3001', Forwarded: 'host=evil.example;proto=http', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http', 'X-Original-URL': 'http://evil.example/auth/me' } });
  expect((await f.handler(forwarded, configuration)).status).toBe(200);
  expect(f.calls.every(c => ['http://127.0.0.1:3000', 'http://127.0.0.1:9090'].includes(c.url.origin))).toBe(true);
  expect(f.calls.filter(c=>c.url.pathname==='/auth/me')).toHaveLength(1);
  for (const call of f.calls) expect(new Headers(call.init?.headers).has('X-Forwarded-Host')).toBe(false);
});
test('success and all error responses prohibit shared storage and omit infrastructure and session details', async () => {
  const f = fixture(); const success = await f.handler(request(),configuration);
  const unsigned = await f.handler(request('',false),configuration);
  const invalid = await f.handler(request('?query=up'),configuration);
  f.setIdentity('43'); const forbidden = await f.handler(request(),configuration);
  f.setStatus(503); const upstream = await f.handler(request(),configuration);
  expect([success.status,unsigned.status,invalid.status,forbidden.status,upstream.status]).toEqual([200,401,400,403,503]);
  for (const response of [success,unsigned,invalid,forbidden,upstream]) {
    expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('vary')).toBe('Cookie'); expect(response.headers.get('referrer-policy')).toBe('no-referrer'); expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const body=await response.text(); for (const privateValue of ['127.0.0.1','host.docker.internal', 'WAYBILL_OPERATOR_GITHUB_IDS', 'WAYBILL_PROMETHEUS_ORIGIN', 'a'.repeat(43)]) expect(body).not.toContain(privateValue);
  }
});
test('three bounded ranges limit concurrent snapshots and coalesce identical requests', async () => {
  const f=fixture();let active=0;let maximum=0;
  const fetcher=(async(input: string|URL|Request,init?:RequestInit)=>{if(new URL(String(input)).port!=='9090')return f.fetcher(input,init);active++;maximum=Math.max(maximum,active);try{await Bun.sleep(2);return await f.fetcher(input,init)}finally{active--}}) as typeof fetch;
  const handler=createMonitoringHandler(fetcher,()=>epoch*1000);
  const responses=await Promise.all(['1h','6h','24h','1h','1h'].map(range=>handler(request('?range='+range),configuration)));
  expect(responses.every(r=>r.status===200)).toBe(true);expect(maximum).toBeLessThanOrEqual(9);expect(active).toBe(0);expect(f.prometheus()).toHaveLength(63);expect(f.calls.filter(c=>c.url.pathname==='/auth/me')).toHaveLength(5);
});
