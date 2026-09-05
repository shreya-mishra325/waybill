import { prisma, type DeadLetter } from "@waybill/shared";

export function createDeadLetter(input: {
  eventId: string;
  deliveryId: string;
  tenantId: string;
  targetUrl: string;
  lastError: string | null;
  attemptCount: number;
  payloadS3Key: string;
}): Promise<DeadLetter> {
  return prisma.deadLetter.upsert({
    where: { deliveryId: input.deliveryId },
    create: input,
    update: {
      lastError: input.lastError,
      attemptCount: input.attemptCount,
      payloadS3Key: input.payloadS3Key,
    },
  });
}
