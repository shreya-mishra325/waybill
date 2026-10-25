import { withReplicaRead } from "@waybill/shared";
import type { DeadLetterQuery } from "../services/dead-letter-query";

export function listDeadLetters(query: DeadLetterQuery) {
  return withReplicaRead(tx => tx.deadLetter.findMany({
    where: { tenantId: query.tenantId, ...(query.cursor ? { OR: [
      { createdAt: { lt: query.cursor.createdAt } },
      { createdAt: query.cursor.createdAt, id: { lt: query.cursor.id } },
    ] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: { id: true, eventId: true, deliveryId: true, tenantId: true, targetUrl: true,
      lastError: true, attemptCount: true, createdAt: true, event: { select: { type: true } },
      replay: { select: { id: true, eventId: true, createdAt: true } } },
  }));
}

export function findDeadLetterArchive(tenantId: string, id: string) {
  return withReplicaRead(tx => tx.deadLetter.findFirst({
    where: { tenantId, id },
    select: { id: true, tenantId: true, eventId: true, payloadS3Key: true },
  }));
}
