export const monitoringScope = "System-wide";
export const grafanaDashboardUid = "waybill-services";
export const localGrafanaDashboard = `http://127.0.0.1:3300/d/${grafanaDashboardUid}/waybill-service-metrics`;
export const webhookAttemptQuery = 'sum by (outcome) (rate(waybill_webhook_attempts_total[$__rate_interval]))';
export function webhookPercentileQuery(quantile: 0.5 | 0.95 | 0.99) {
  return `histogram_quantile(${quantile}, sum by (le) (rate(waybill_webhook_duration_seconds_bucket[$__rate_interval])))`;
}
export const monitoringQueries = {
  attempts: webhookAttemptQuery,
  p50: webhookPercentileQuery(0.5),
  p95: webhookPercentileQuery(0.95),
  p99: webhookPercentileQuery(0.99),
  retries: 'sum by (reason) (rate(waybill_delivery_retries_total[$__rate_interval]))',
  deadLetters: 'sum(rate(waybill_delivery_terminal_outcomes_total{outcome="dead_lettered"}[$__rate_interval]))',
  outbox: 'waybill:outbox_pending:fresh',
  queue: 'waybill:sqs_messages:fresh',
  apiErrors: 'sum by (status_class) (rate(waybill_http_requests_total{status_class=~"4xx|5xx|aborted",operation!="health"}[$__rate_interval]))',
} as const;
export const observabilityStats = [
  { id: "attempt-rate", title: "Webhook attempt rate", unit: "attempts / sec", description: "Completed HTTP calls; preparation failures excluded.", query: monitoringQueries.attempts },
  { id: "call-p95", title: "Webhook HTTP call p95", unit: "seconds", description: "HTTP call duration, excluding queue wait.", query: monitoringQueries.p95 },
  { id: "retry-decisions", title: "Retry decisions", unit: "decisions / sec", description: "Persisted retry decisions, grouped by reason.", query: monitoringQueries.retries },
  { id: "dead-letter-updates", title: "Dead-letter updates", unit: "updates / sec", description: "Persistence observations, not unique archive counts.", query: monitoringQueries.deadLetters },
] as const;
export type GrafanaLink = { status: "configured"; href: string } | { status: "not-configured" | "invalid"; href: null };
export function grafanaLink(configured: string | undefined, development: boolean): GrafanaLink {
  const value = configured === undefined ? development ? localGrafanaDashboard : undefined : configured;
  if (!value) return { status: "not-configured", href: null };
  try {
    const url = new URL(value);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(development && local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || !new RegExp(`^/d/${grafanaDashboardUid}(?:/[^/]+)?/?$`).test(url.pathname)) return { status: "invalid", href: null };
    url.search = new URLSearchParams({ from: "now-24h", to: "now", timezone: "utc" }).toString();
    return { status: "configured", href: url.toString() };
  } catch { return { status: "invalid", href: null }; }
}
