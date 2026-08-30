import type { PrismaClient, Event, Outbox } from "@waybill/shared";

export type UnpublishedOutbox = Outbox & { event: Event };

export function listUnpublished(
  db: PrismaClient,
  limit: number,
): Promise<UnpublishedOutbox[]> {
  return db.outbox.findMany({
    where: { published: false },
    include: { event: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

export function markPublished(
  db: PrismaClient,
  id: string,
): Promise<{ count: number }> {
  return db.outbox.updateMany({
    where: { id, published: false },
    data: { published: true, publishedAt: new Date() },
  });
}
