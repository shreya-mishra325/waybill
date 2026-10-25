import type { DeliveryStatus } from "@waybill/shared";

export type DeliveryStatusCount = { status: DeliveryStatus; _count: { _all: number } };

export function summarizeDeliveries(rows: DeliveryStatusCount[]) {
  const counts: Record<DeliveryStatus, number> = {
    PENDING: 0, IN_FLIGHT: 0, SUCCEEDED: 0, FAILED: 0, DEAD_LETTERED: 0,
  };
  for (const row of rows) counts[row.status] = row._count._all;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const completed = counts.SUCCEEDED + counts.DEAD_LETTERED;
  return {
    total,
    counts,
    completed,
    successRatePercent: completed === 0 ? null : Math.round(counts.SUCCEEDED / completed * 10_000) / 100,
  };
}
