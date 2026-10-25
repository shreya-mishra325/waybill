import { withReplicaRead } from "@waybill/shared";

export function countDeliveriesByStatus(tenantId: string) {
  return withReplicaRead(tx => tx.delivery.groupBy({
    by: ["status"],
    where: { tenantId },
    _count: { _all: true },
  }));
}
