import { withReplicaRead } from "@waybill/shared";
import type { DeliveryHistoryQuery } from "../services/delivery-history-query";

export function listDeliveryHistory(query: DeliveryHistoryQuery) {
  return withReplicaRead(tx => tx.delivery.findMany({
    where: {
      tenantId: query.tenantId,
      status: query.status,
      ...(query.cursor ? { OR: [
        { createdAt: { lt: query.cursor.createdAt } },
        { createdAt: query.cursor.createdAt, id: { lt: query.cursor.id } },
      ] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: {
      id: true, eventId: true, tenantId: true, targetUrl: true,
      status: true, attemptCount: true, createdAt: true,
      lastAttemptAt: true, nextAttemptAt: true, lastError: true,
      event: { select: { type: true } },
    },
  }));
}
