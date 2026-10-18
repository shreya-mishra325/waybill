import type { Prisma, Event, Outbox } from "@waybill/shared";

export type UnpublishedOutbox = Outbox & { event: Event };

export async function listUnpublished(
  db: Prisma.TransactionClient,
  limit: number,
  afterTenantId = "",
): Promise<UnpublishedOutbox[]> {
  // Rank across the entire pending set before applying LIMIT. Reordering only
  // the oldest ten rows would still leave a quiet tenant behind a large burst.
  const selected = await db.$queryRaw<Array<{ id: string }>>`
    WITH pending AS (
      SELECT o.id, e.tenant_id,
        ROW_NUMBER() OVER (
          PARTITION BY e.tenant_id ORDER BY o.created_at, o.id
        ) AS tenant_position
      FROM outbox o
      JOIN events e ON e.id = o.event_id
      WHERE o.published = false
    )
    SELECT id FROM pending
    ORDER BY tenant_position,
      CASE WHEN tenant_id > ${afterTenantId} THEN 0 ELSE 1 END,
      tenant_id
    LIMIT ${limit}
  `;
  if (selected.length === 0) return [];

  const rows = await db.outbox.findMany({
    where: { id: { in: selected.map((row) => row.id) }, published: false },
    include: { event: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return selected.flatMap(({ id }) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

export function markPublished(
  db: Prisma.TransactionClient,
  id: string,
): Promise<{ count: number }> {
  return db.outbox.updateMany({
    where: { id, published: false },
    data: { published: true, publishedAt: new Date() },
  });
}
