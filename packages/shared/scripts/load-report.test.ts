import { describe, expect, test } from "bun:test";
import { loadReport, loadTenantIndex, type LoadRequest, type LoadReceipt, type LoadOutcome } from "./load-report";

const limits = { planned: 2, p95Ms: 1000, maxMs: 2000, maxScheduleLagMs: 250, requireAllAccepted: true };
const requests: LoadRequest[] = [0, 1].map(sequence => ({ sequence, tenantId: `tenant-${sequence}`, scheduledAt: sequence * 100,
  sentAt: sequence * 100 + 2, finishedAt: sequence * 100 + 10, status: 201, eventId: `event-${sequence}` }));
const receipts = () => new Map<string, LoadReceipt>(requests.map(request => [request.eventId!, { tenantId: request.tenantId, at: request.sentAt! + 500, calls: 1 }]));
const outcomes: LoadOutcome[] = requests.map(request => ({ eventId: request.eventId!, tenantId: request.tenantId, status: "SUCCEEDED", attemptCount: 1 }));

describe("sustained load report", () => {
  test("requires receipts and durable outcomes for all accepted work", () => {
    const result = loadReport(requests, receipts(), outcomes, limits);
    expect(result.passed).toBe(true);
    expect(result.p95Ms).toBe(500);
    expect(result.tenants).toHaveLength(2);
    expect(result.httpP95Ms).toBe(8);
  });
  test("does not hide lost work behind fast completed deliveries", () => {
    const observed = receipts();
    observed.delete("event-1");
    expect(loadReport(requests, observed, outcomes.slice(0, 1), limits).passed).toBe(false);
    expect(loadReport(requests, observed, outcomes, limits).pending).toBe(1);
  });
  test("fails rejections, uncertain writes, and generator saturation", () => {
    const rejected = [{ ...requests[0]!, status: 429, eventId: undefined }, requests[1]!];
    expect(loadReport(rejected, receipts(), outcomes, limits).rejected).toBe(1);
    expect(loadReport(rejected, receipts(), outcomes, limits).passed).toBe(false);
    expect(loadReport([{ ...requests[0]!, status: undefined, eventId: undefined, error: "timeout" }, requests[1]!], receipts(), outcomes, limits).passed).toBe(false);
    expect(loadReport([{ ...requests[0]!, sentAt: undefined, error: "concurrency cap" }, requests[1]!], receipts(), outcomes, limits).passed).toBe(false);
    expect(loadReport([{ ...requests[0]!, sentAt: 400 }, requests[1]!], receipts(), outcomes, limits).passed).toBe(false);
  });
  test("checks individual tenants rather than hiding a slow tenant in the aggregate", () => {
    const observed = receipts();
    observed.set("event-1", { tenantId: "tenant-1", at: 2500, calls: 1 });
    expect(loadReport(requests, observed, outcomes, limits).passed).toBe(false);
  });
  test("rejects cross-tenant outcomes, nonterminal state, duplicate identities, and empty runs", () => {
    expect(loadReport(requests, receipts(), [{ ...outcomes[0]!, tenantId: "other" }, outcomes[1]!], limits).passed).toBe(false);
    expect(loadReport(requests, receipts(), [{ ...outcomes[0]!, status: "FAILED" }, outcomes[1]!], limits).passed).toBe(false);
    expect(loadReport([requests[0]!, { ...requests[1]!, eventId: "event-0" }], receipts(), outcomes, limits).passed).toBe(false);
    expect(loadReport([], new Map(), [], { ...limits, planned: 0 }).passed).toBe(false);
  });
  test("reports at-least-once duplicate calls without treating them as lost work", () => {
    const observed = receipts();
    observed.set("event-0", { tenantId: "tenant-0", at: 502, calls: 2 });
    const result = loadReport(requests, observed, outcomes, limits);
    expect(result.passed).toBe(true);
    expect(result.duplicateCalls).toBe(1);
  });
});


describe("busy and quiet load", () => {
  test("keeps the declared rates and visits every quiet tenant each second", () => {
    const counts = Array.from({ length: 6 }, () => 0);
    for (let sequence = 0; sequence < 1800; sequence++) counts[loadTenantIndex(sequence, 6, 10)]!++;
    expect(counts).toEqual([1200, 120, 120, 120, 120, 120]);
    expect([0, 1, 2, 3, 4, 5].map(sequence => loadTenantIndex(sequence, 3))).toEqual([0, 1, 2, 0, 1, 2]);
  });
  const fairness = { busyTenantId: "tenant-0", quietTenantIds: ["tenant-1"], busyRequests: 1, quietRequestsPerTenant: 1,
    busyP95Ms: 5000, busyMaxMs: 5000, minBusyPending: 1, minOverlappingRequests: 1 };
  test("requires observed outstanding accepted work instead of assuming overlap from wall-clock duration", () => {
    expect(loadReport(requests, receipts(), outcomes, { ...limits, fairness }).passed).toBe(false);
    const overlapping = requests.map(request => ({ ...request, busyPendingAtSubmission: 1 }));
    expect(loadReport(overlapping, receipts(), outcomes, { ...limits, fairness }).passed).toBe(true);
    expect(loadReport(overlapping, receipts(), outcomes, { ...limits, fairness: { ...fairness, quietTenantIds: ["missing-tenant"] } }).passed).toBe(false);
  });
  test("allows a separately declared busy completion budget without relaxing quiet latency", () => {
    const observed = receipts();
    const overlapping = requests.map(request => ({ ...request, busyPendingAtSubmission: 1 }));
    observed.set("event-0", { tenantId: "tenant-0", at: 4000, calls: 1 });
    expect(loadReport(overlapping, observed, outcomes, { ...limits, fairness }).passed).toBe(true);
    observed.set("event-1", { tenantId: "tenant-1", at: 4000, calls: 1 });
    expect(loadReport(overlapping, observed, outcomes, { ...limits, fairness }).passed).toBe(false);
  });
});


test("preload evidence requires complete publication and visible work before any consumer starts", () => {
  const preload = { expected: 1200, published: 1200, visible: 1200, inFlight: 0, delayed: 0, receiptsBeforeStart: 0 };
  expect(loadReport(requests, receipts(), outcomes, { ...limits, preload }).passed).toBe(true);
  for (const changed of [{ published: 1199 }, { visible: 1199 }, { inFlight: 1 }, { delayed: 1 }, { receiptsBeforeStart: 1 }, { expected: 1000 }]) {
    expect(loadReport(requests, receipts(), outcomes, { ...limits, preload: { ...preload, ...changed } }).passed).toBe(false);
  }
});
