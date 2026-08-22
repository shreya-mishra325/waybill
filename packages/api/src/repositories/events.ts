import { Prisma, prisma, type Event, type Outbox } from "@waybill/shared";

export type CreateEventRecord = {
  id: string;
  tenantId: string;
  type: string;
  payload: Prisma.InputJsonValue | null;
  payloadS3Key: string | null;
};

export function findTenantById(id: string) {
  return prisma.tenant.findUnique({ where: { id } });
}

export function createEvent(
  tx: Prisma.TransactionClient,
  input: CreateEventRecord,
): Promise<Event> {
  return tx.event.create({
    data: {
      id: input.id,
      tenantId: input.tenantId,
      type: input.type,
      payload: input.payload === null ? Prisma.DbNull : input.payload,
      payloadS3Key: input.payloadS3Key,
    },
  });
}

export function createOutbox(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<Outbox> {
  return tx.outbox.create({
    data: { eventId },
  });
}
