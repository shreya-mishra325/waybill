export type Sample = {
  tenant: "busy" | "quiet";
  phase: "baseline" | "load";
  sentAt: number;
  status?: number;
  eventId?: string;
  error?: string;
};

export function summarize(samples: Sample[], receipts: Map<string, number>) {
  const accepted = samples.filter((sample) => sample.status === 201 && sample.eventId);
  const latencies = accepted.flatMap((sample) => {
    const arrived = receipts.get(sample.eventId!);
    return arrived === undefined ? [] : [arrived - sample.sentAt];
  }).sort((a, b) => a - b);
  return {
    submitted: samples.length,
    accepted: accepted.length,
    rejected: samples.filter((sample) => sample.status === 429).length,
    errors: samples.filter((sample) => sample.error ||
      (sample.status !== 201 && sample.status !== 429)).length,
    delivered: latencies.length,
    pending: accepted.length - latencies.length,
    p95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    maxMs: latencies.length ? latencies[latencies.length - 1] : null,
  };
}

export function fairnessReport(
  samples: Sample[],
  receipts: Map<string, number>,
  limits: { busyRequests: number; quietP95Ms: number; busyFinishedAt: number },
) {
  const baseline = summarize(samples.filter((s) => s.phase === "baseline"), receipts);
  const busy = summarize(samples.filter((s) => s.tenant === "busy"), receipts);
  const quietSamples = samples.filter((s) => s.tenant === "quiet" && s.phase === "load");
  const quiet = summarize(quietSamples, receipts);
  const overlappingQuiet = quietSamples.filter((s) => s.sentAt <= limits.busyFinishedAt).length;
  const failures: string[] = [];
  if (baseline.accepted < 3 || baseline.delivered !== baseline.submitted || baseline.errors) {
    failures.push("Baseline did not deliver every request (minimum 3).");
  }
  if (busy.submitted !== limits.busyRequests || busy.accepted === 0 || busy.errors) {
    failures.push("Busy traffic was incomplete, entirely rejected, or had request errors.");
  }
  if (overlappingQuiet < 3) failures.push("Fewer than 3 quiet requests overlapped the busy burst.");
  if (quiet.submitted < 3 || quiet.delivered !== quiet.submitted || quiet.errors) {
    failures.push("Quiet traffic was rejected, failed, or did not finish delivery.");
  }
  if (busy.pending > 0) failures.push("Accepted busy events remain undelivered.");
  if (quiet.p95Ms === null || quiet.p95Ms > limits.quietP95Ms) {
    failures.push("Quiet-tenant p95 exceeded the configured latency limit.");
  }
  return { passed: failures.length === 0, failures, baseline, busy, quiet, overlappingQuiet };
}
