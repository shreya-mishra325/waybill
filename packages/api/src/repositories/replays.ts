import { prisma, type Prisma } from "@waybill/shared";

const replaySelect = {
  id: true, tenantId: true, sourceDeadLetterId: true, eventId: true, createdAt: true,
  sourceDeadLetter: { select: { eventId: true } },
} satisfies Prisma.ReplaySelect;

const sourceSelect = {
  id: true, tenantId: true, payloadS3Key: true, targetUrl: true,
  event: { select: { id: true, type: true } },
  delivery: { select: { status: true } },
  replay: { select: { id: true } },
} satisfies Prisma.DeadLetterSelect;

function primaryRead<T>(read: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(read, { maxWait: 5000, timeout: 10_000 });
}

export function findReplayByKey(tenantId: string, idempotencyKey: string) {
  return primaryRead(tx => tx.replay.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } }, select: replaySelect,
  }));
}

export function findReplaySource(tenantId: string, id: string) {
  return primaryRead(tx => tx.deadLetter.findFirst({where: {tenantId, id}, select: sourceSelect}));
}

export function createReplay(input: { tenantId: string; deadLetterId: string; idempotencyKey: string;
  archiveKey: string; targetUrl: string }) {
  return prisma.$transaction(async tx => {
    const existing = await tx.replay.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey } },
      select: replaySelect,
    });
    if (existing) return { kind: "existing" as const, replay: existing };
    const source = await tx.deadLetter.findFirst({
      where: { id: input.deadLetterId, tenantId: input.tenantId }, select: sourceSelect,
    });
    if (!source) return { kind: "missing" as const };
    if (source.delivery.status !== "DEAD_LETTERED" || source.targetUrl !== input.targetUrl ||
        source.payloadS3Key !== input.archiveKey) return { kind: "conflict" as const };
    const event = await tx.event.create({data: {
      tenantId: source.tenantId, type: source.event.type, payloadS3Key: source.payloadS3Key,
    }});
    await tx.outbox.create({data: {eventId: event.id}});
    const replay = await tx.replay.create({data: {
      tenantId: input.tenantId, sourceDeadLetterId: source.id, eventId: event.id, idempotencyKey: input.idempotencyKey,
    }, select: replaySelect});
    return { kind: "created" as const, replay };
  }, { maxWait: 5000, timeout: 10_000 });
}
