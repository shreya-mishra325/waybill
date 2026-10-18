import { describe, expect, it } from "bun:test";
import { fairnessReport, summarize, type Sample } from "./fairness-report";

function fixture() {
  const samples: Sample[] = [];
  const receipts = new Map<string, number>();
  for (const phase of ["baseline", "load"] as const) {
    for (let i = 0; i < 3; i++) {
      const eventId = `${phase}-${i}`;
      samples.push({ tenant: "quiet", phase, sentAt: i * 1000, status: 201, eventId });
      receipts.set(eventId, i * 1000 + 100);
    }
  }
  samples.push({ tenant: "busy", phase: "load", sentAt: 0, status: 201, eventId: "busy" });
  receipts.set("busy", 100);
  return { samples, receipts, limits: { busyRequests: 1, quietP95Ms: 500, busyFinishedAt: 3000 } };
}

describe("fairness report", () => {
  it("passes complete deliveries within the predeclared latency limit", () => {
    const { samples, receipts, limits } = fixture();
    expect(fairnessReport(samples, receipts, limits).passed).toBe(true);
  });

  it("does not hide missing deliveries behind a good p95", () => {
    const { samples, receipts, limits } = fixture();
    receipts.delete("load-2");
    const report = fairnessReport(samples, receipts, limits);
    expect(report.quiet.p95Ms).toBe(100);
    expect(report.quiet.pending).toBe(1);
    expect(report.passed).toBe(false);
  });

  it("fails when all busy requests are rejected or quiet traffic misses the burst", () => {
    const { samples, receipts, limits } = fixture();
    samples[samples.length - 1].status = 429;
    expect(fairnessReport(samples, receipts, limits).passed).toBe(false);
    samples[samples.length - 1].status = 201;
    expect(fairnessReport(samples, receipts, { ...limits, busyFinishedAt: 0 }).passed).toBe(false);
  });

  it("fails slow quiet deliveries and counts rejected requests separately", () => {
    const { samples, receipts, limits } = fixture();
    receipts.set("load-2", 5000);
    expect(fairnessReport(samples, receipts, limits).passed).toBe(false);
    samples.push({ tenant: "busy", phase: "load", sentAt: 0, status: 429 });
    const result = summarize(samples, receipts);
    expect(result.rejected).toBe(1);
    expect(result.accepted).toBe(7);
    expect(result.delivered).toBe(7);
  });

  it("fails quiet rejections and uncertain request outcomes", () => {
    const { samples, receipts, limits } = fixture();
    const quiet = samples.find((s) => s.phase === "load" && s.tenant === "quiet")!;
    quiet.status = 429;
    expect(fairnessReport(samples, receipts, limits).passed).toBe(false);
    quiet.status = 201;
    samples[samples.length - 1].error = "response timed out after commit";
    expect(fairnessReport(samples, receipts, limits).passed).toBe(false);
  });
});
