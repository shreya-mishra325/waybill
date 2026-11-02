import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { grafanaLink, monitoringQueries, monitoringScope, observabilityStats, webhookPercentileQuery } from "../src/lib/observability";
import { ApiErrorsPanel, BacklogPanel, ObservabilityStats, UnavailableMonitoringChart } from "../src/components/dashboard/observability-panels";

const dashboard = JSON.parse(readFileSync(new URL("../../../infra/monitoring/grafana/dashboards/waybill-services.json", import.meta.url), "utf8")) as { uid: string; panels: { id: number; targets: { expr: string }[]; fieldConfig: { defaults: { unit: string } } }[] };
function panel(id: number) { const result = dashboard.panels.find(panel => panel.id === id); if (!result) throw new Error("Missing provisioned panel"); return result; }

test("Observability queries match provisioned service metrics without inventing tenant labels", () => {
  expect(monitoringQueries.attempts).toBe(panel(5).targets[0]!.expr);
  expect(monitoringQueries.p95).toBe(panel(6).targets[0]!.expr);
  expect(monitoringQueries.retries).toBe(panel(7).targets[0]!.expr);
  expect(monitoringQueries.deadLetters).toBe(panel(7).targets[1]!.expr);
  expect(monitoringQueries.apiErrors).toBe(panel(3).targets[0]!.expr);
  expect(monitoringQueries.outbox).toBe(panel(13).targets[0]!.expr);
  expect(monitoringQueries.queue).toBe(panel(14).targets[0]!.expr);
  expect(monitoringScope).toBe("System-wide");
  for (const query of Object.values(monitoringQueries)) { expect(query).not.toMatch(/tenant|workspace/i); expect(query).not.toContain("or vector(0)"); }
});
test("duration quantiles use summed histogram bucket rates in seconds, not averages or end-to-end latency", () => {
  expect(panel(6).fieldConfig.defaults.unit).toBe("s");
  for (const quantile of [0.5, 0.95, 0.99] as const) {
    expect(webhookPercentileQuery(quantile)).toBe(panel(6).targets[0]!.expr.replace("histogram_quantile(0.95,", `histogram_quantile(${quantile},`));
    expect(webhookPercentileQuery(quantile)).toContain("sum by (le)");
    expect(webhookPercentileQuery(quantile)).toContain("waybill_webhook_duration_seconds_bucket");
    expect(webhookPercentileQuery(quantile)).not.toContain("_sum");
  }
  expect(observabilityStats.find(stat => stat.id === "call-p95")?.unit).toBe("seconds");
});
test("backlog uses existing fresh-only recording rules, preserving unavailable samples instead of zero", () => {
  const rules = readFileSync(new URL("../../../infra/monitoring/prometheus/rules.yml", import.meta.url), "utf8");
  expect(rules).toContain("record: " + monitoringQueries.outbox); expect(rules).toContain("record: " + monitoringQueries.queue);
  for (const source of ["outbox", "sqs"]) {
    expect(rules).toContain(`waybill_backlog_sample_success{source="${source}"} == 1`);
    expect(rules).toContain(`((time() - waybill_backlog_sample_timestamp_seconds{source="${source}"}) < 90)`);
    expect(rules).toContain(`((time() - waybill_backlog_sample_timestamp_seconds{source="${source}"}) >= 0)`);
  }
  expect(rules).toContain('up{job="waybill-publisher"} == 1'); expect(rules).toContain("max by (state)");
  const html = renderToStaticMarkup(createElement(BacklogPanel));
  expect(html).toContain("Unavailable"); expect(html).toContain("never zero"); expect(html).toContain("future timestamps are excluded");
});
test("unconnected panels contain no illustrative data lines, numeric samples, or fake trends", () => {
  const stats = renderToStaticMarkup(createElement(ObservabilityStats));
  expect(stats.match(/<strong>Unavailable<\/strong>/g)).toHaveLength(4);
  expect(stats.match(/System-wide/g)?.length).toBeGreaterThanOrEqual(4);
  const html = renderToStaticMarkup(createElement(UnavailableMonitoringChart, { id: "test", title: "Webhook response time", description: "Histogram quantiles", unit: "Duration (seconds)", legend: [{ label: "p95", color: "#587e95" }] }));
  expect(html).toContain("No historical data loaded."); expect(html).toContain("Time (UTC)"); expect(html).toContain("Duration (seconds)");
  expect(html).not.toContain("<path"); expect(html).not.toContain("<polyline"); expect(html).not.toContain("data-series");
  const errors = renderToStaticMarkup(createElement(ApiErrorsPanel)); expect(errors).toContain("requests / sec"); expect(errors).toContain("not percentages");
});
test("operator links require a safe configured dashboard URL in production and never carry credentials", () => {
  const local = grafanaLink(undefined, true); expect(local.status).toBe("configured");
  if (local.href) { const url = new URL(local.href); expect(url.origin).toBe("http://127.0.0.1:3300"); expect(url.pathname).toContain(dashboard.uid); expect(url.searchParams.get("from")).toBe("now-24h"); expect(url.searchParams.get("to")).toBe("now"); }
  expect(grafanaLink(undefined, false)).toEqual({ status: "not-configured", href: null });
  expect(grafanaLink("https://monitoring.example.com/d/waybill-services", false).status).toBe("configured");
  for (const value of ["javascript:alert(1)", "https://user:secret@example.com/d/waybill-services", "https://example.com/d/waybill-services?token=private", "https://example.com/d/waybill-services#token", "http://example.com/d/waybill-services", "http://127.0.0.1:3300/d/waybill-services", "https://example.com/d/other-dashboard"]) expect(grafanaLink(value, false)).toEqual({ status: "invalid", href: null });
});
