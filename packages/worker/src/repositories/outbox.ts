import { prisma, type Event, type Outbox } from "@waybill/shared";

export type UnpublishedOutbox = Outbox & { event: Event };

export function listUnpublished(limit: number): Promise<UnpublishedOutbox[]> {
  return prisma.outbox.findMany({
    where: { published: false },
    include: { event: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

export function markPublished(id: string): Promise<{ count: number }> {
  return prisma.outbox.updateMany({
    where: { id, published: false },
    data: { published: true, publishedAt: new Date() },
  });
}
