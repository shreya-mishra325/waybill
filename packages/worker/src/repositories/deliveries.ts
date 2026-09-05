import { prisma, type Delivery } from "@waybill/shared";

export function findByEventAndUrl(
  eventId: string,
  targetUrl: string,
): Promise<Delivery | null> {
  return prisma.delivery.findFirst({
    where: { eventId, targetUrl },
  });
}

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
        nextAttemptAt: null,
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

export function markFailed(
  id: string,
  error: string,
  nextAttempt: Date,
): Promise<Delivery> {
  return prisma.delivery.update({
    where: { id },
    data: {
      status: "FAILED",
      lastError: error.slice(0, 500),
      nextAttemptAt: nextAttempt,
    },
  });
}

export function markDeadLettered(
  id: string,
  error: string,
): Promise<Delivery> {
  return prisma.delivery.update({
    where: { id },
    data: {
      status: "DEAD_LETTERED",
      lastError: error.slice(0, 500),
      nextAttemptAt: null,
    },
  });
}
