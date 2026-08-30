import { prisma, type Delivery } from "@waybill/shared";

export async function upsertInFlight(input: {
  eventId: string;
  tenantId: string;
  targetUrl: string;
}): Promise<Delivery> {
  const existing = await prisma.delivery.findFirst({
    where: { eventId: input.eventId, targetUrl: input.targetUrl },
  });

  if (existing) {
    return prisma.delivery.update({
      where: { id: existing.id },
      data: {
        status: "IN_FLIGHT",
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        lastError: null,
      },
    });
  }

  return prisma.delivery.create({
    data: {
      eventId: input.eventId,
      tenantId: input.tenantId,
      targetUrl: input.targetUrl,
      status: "IN_FLIGHT",
      attemptCount: 1,
      lastAttemptAt: new Date(),
    },
  });
}

export function markSucceeded(id: string): Promise<Delivery> {
  return prisma.delivery.update({
    where: { id },
    data: { status: "SUCCEEDED", lastError: null },
  });
}

export function markFailed(id: string, error: string): Promise<Delivery> {
  return prisma.delivery.update({
    where: { id },
    data: { status: "FAILED", lastError: error.slice(0, 500) },
  });
}
