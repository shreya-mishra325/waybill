export type LoadRequest = {
  sequence: number;
  tenantId: string;
  scheduledAt: number;
  sentAt?: number;
  finishedAt?: number;
  status?: number;
  eventId?: string;
  error?: string;
  busyPendingAtSubmission?: number;
};

export type LoadReceipt = { tenantId: string; at: number; calls: number };
export type LoadOutcome = { eventId: string; tenantId: string; status: string; attemptCount: number };
export type LoadLimits = {
  planned: number; p95Ms: number; maxMs: number; maxScheduleLagMs: number; requireAllAccepted: boolean;
  preload?: { expected: number; published: number; visible: number; inFlight: number; delayed: number; receiptsBeforeStart: number };
  fairness?: { busyTenantId: string; quietTenantIds: string[]; busyRequests: number; quietRequestsPerTenant: number;
    busyP95Ms: number; busyMaxMs: number; minBusyPending: number; minOverlappingRequests: number };
};

export function loadTenantIndex(sequence: number, tenantCount: number, busyRate?: number): number {
  if (busyRate === undefined) return sequence % tenantCount;
  const slot = sequence % (busyRate + tenantCount - 1);
  return slot < busyRate ? 0 : slot - busyRate + 1;
}

export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function loadReport(requests: LoadRequest[], receipts: Map<string, LoadReceipt>, outcomes: LoadOutcome[], limits: LoadLimits) {
  const accepted = requests.filter(request => request.status === 201 && request.eventId);
  const acceptedById = new Map(accepted.map(request => [request.eventId!, request]));
  const ids = new Set(acceptedById.keys());
  const rejected = requests.filter(request => request.status === 429).length;
  const errors = requests.filter(request => request.error || (request.status !== 201 && request.status !== 429) ||
    (request.status === 201 && !request.eventId)).length;
  const tenants = [...new Set(requests.map(request => request.tenantId))].map(tenantId => {
    const admitted = accepted.filter(request => request.tenantId === tenantId);
    const times = admitted.flatMap(request => {
      const receipt = receipts.get(request.eventId!);
      return receipt?.tenantId === tenantId && request.sentAt !== undefined ? [receipt.at - request.sentAt] : [];
    });
    const arrivals = admitted.flatMap(request => {
      const receipt = receipts.get(request.eventId!);
      return receipt?.tenantId === tenantId ? [receipt.at] : [];
    });
    const starts = admitted.flatMap(request => request.sentAt === undefined ? [] : [request.sentAt]);
    const overlappedBusy = limits.fairness ? admitted.filter(request => (request.busyPendingAtSubmission ?? 0) >= limits.fairness!.minBusyPending).length : 0;
    return { tenantId, role: limits.fairness ? tenantId === limits.fairness.busyTenantId ? "busy" : "quiet" : "balanced",
      overlappedBusy, completionMs: arrivals.length && starts.length ? Math.max(...arrivals) - Math.min(...starts) : null,
      submitted: requests.filter(request => request.tenantId === tenantId).length,
      accepted: admitted.length, delivered: times.length, pending: admitted.length - times.length,
      p95Ms: percentile(times, 0.95), maxMs: percentile(times, 1) };
  });
  const latencies = accepted.flatMap(request => {
    const receipt = receipts.get(request.eventId!);
    return receipt?.tenantId === request.tenantId && request.sentAt !== undefined ? [receipt.at - request.sentAt] : [];
  });
  const owned = outcomes.filter(outcome => ids.has(outcome.eventId));
  const statuses: Record<string, number> = {};
  for (const outcome of owned) statuses[outcome.status] = (statuses[outcome.status] ?? 0) + 1;
  const scheduleLag = requests.flatMap(request => request.sentAt === undefined ? [] : [Math.max(0, request.sentAt - request.scheduledAt)]);
  const httpLatencies = requests.flatMap(request => request.sentAt === undefined || request.finishedAt === undefined ? [] : [request.finishedAt - request.sentAt]);
  const failures: string[] = [];
  if (requests.length !== limits.planned || requests.some(request => request.sentAt === undefined)) failures.push("The generator did not submit every scheduled request.");
  if (errors) failures.push("Requests had unexpected or uncertain outcomes.");
  if (!accepted.length || (limits.requireAllAccepted && accepted.length !== limits.planned)) failures.push("The required request volume was not accepted.");
  if (ids.size !== accepted.length) failures.push("Accepted event IDs were not unique.");
  if (latencies.length !== accepted.length) failures.push("Accepted work is missing a verified receiver receipt.");
  if (owned.length !== accepted.length || new Set(owned.map(outcome => outcome.eventId)).size !== accepted.length ||
      owned.some(outcome => outcome.status !== "SUCCEEDED" || outcome.tenantId !== acceptedById.get(outcome.eventId)?.tenantId)) {
    failures.push("Accepted work is missing a matching durable successful outcome.");
  }
  if (tenants.some(tenant => {
    const busy = tenant.tenantId === limits.fairness?.busyTenantId;
    const p95Limit = busy ? limits.fairness!.busyP95Ms : limits.p95Ms;
    const maxLimit = busy ? limits.fairness!.busyMaxMs : limits.maxMs;
    return tenant.accepted && (tenant.p95Ms === null || tenant.p95Ms > p95Limit || tenant.maxMs === null || tenant.maxMs > maxLimit);
  })) {
    failures.push("A tenant exceeded the declared delivery latency limits.");
  }
  if (limits.preload) {
    const preload = limits.preload;
    if (preload.expected < 1001 || preload.published !== preload.expected || preload.visible < preload.expected ||
        preload.inFlight !== 0 || preload.delayed !== 0 || preload.receiptsBeforeStart !== 0) {
      failures.push("The complete accepted backlog was not confirmed before worker startup.");
    }
  }
  if (limits.fairness) {
    const fairness = limits.fairness;
    if (tenants.find(tenant => tenant.tenantId === fairness.busyTenantId)?.accepted !== fairness.busyRequests) {
      failures.push("The declared busy request volume was not accepted.");
    }
    if (fairness.quietTenantIds.some(id => {
      const tenant = tenants.find(entry => entry.tenantId === id);
      return !tenant || tenant.accepted !== fairness.quietRequestsPerTenant || tenant.overlappedBusy < fairness.minOverlappingRequests;
    })) failures.push("Quiet tenants did not submit the declared volume while accepted busy work remained outstanding.");
  }
  if ((percentile(scheduleLag, 1) ?? Infinity) > limits.maxScheduleLagMs) failures.push("The generator could not maintain the declared request schedule.");
  return { passed: failures.length === 0, failures, planned: limits.planned, submitted: requests.filter(request => request.sentAt !== undefined).length,
    accepted: accepted.length, rejected, errors, delivered: latencies.length, pending: accepted.length - latencies.length,
    p95Ms: percentile(latencies, 0.95), maxMs: percentile(latencies, 1), httpP95Ms: percentile(httpLatencies, 0.95),
    maxScheduleLagMs: percentile(scheduleLag, 1), duplicateCalls: [...receipts.values()].reduce((sum, receipt) => sum + Math.max(0, receipt.calls - 1), 0),
    maxBusyPendingAtSubmission: Math.max(0, ...requests.map(request => request.busyPendingAtSubmission ?? 0)), statuses, tenants };
}
