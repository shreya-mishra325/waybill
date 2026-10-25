import { expect, test } from "bun:test";
import { PrismaClient, createSingleConnectionPrisma } from "@waybill/shared";
import { createReplay, findReplayByKey } from "./replays";

test.skipIf(process.env.RUN_REPLAY_TESTS !== "1")("replay commits one durable outbox command under concurrent requests", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "15432") throw new Error("Local replay test only");
  url.searchParams.set("socket_timeout", "10");
  const db = new PrismaClient({datasources: {db: {url: url.toString()}}});
  const lock = createSingleConnectionPrisma();
  let locked = false;
  const tenantId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const deadLetterId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const targetUrl = "http://127.0.0.1:4000/webhook";
  const archiveKey = `dead-letters/${eventId}.json`;
  try {
    const rows = await lock.$queryRaw<{locked: boolean}[]>`SELECT pg_try_advisory_lock(728401) AS locked`;
    locked = rows[0]?.locked === true;
    if (!locked) throw new Error("Stop the outbox poller before replay database tests");
    await db.$transaction(async tx => {
      await tx.tenant.create({data: {id: tenantId, name: "replay-test", hmacSecret: "test-only"}});
      await tx.event.create({data: {id: eventId, tenantId, type: "replay.test", payload: {value: 1}}});
      await tx.delivery.create({data: {id: deliveryId, eventId, tenantId, targetUrl,
        status: "DEAD_LETTERED", attemptCount: 8, lastError: "original failure"}});
      await tx.deadLetter.create({data: {id: deadLetterId, deliveryId, eventId, tenantId,
        targetUrl, attemptCount: 8, lastError: "original failure", payloadS3Key: archiveKey}});
    });
    const input = {tenantId, deadLetterId, idempotencyKey, archiveKey, targetUrl};
    const wrongTenant = await createReplay({...input, tenantId: crypto.randomUUID()});
    expect(wrongTenant.kind).toBe("missing");
    expect((await createReplay({...input, archiveKey: "changed"})).kind).toBe("conflict");
    expect(await db.replay.count({where: {tenantId}})).toBe(0);
    const raced = await Promise.allSettled([createReplay(input), createReplay(input)]);
    expect(raced.some(result => result.status === "fulfilled" && result.value.kind === "created")).toBe(true);
    const persisted = await findReplayByKey(tenantId, idempotencyKey);
    expect(persisted).not.toBeNull();
    expect((await createReplay(input)).kind).toBe("existing");
    const conflicting = await Promise.allSettled([createReplay({...input, idempotencyKey: crypto.randomUUID()})]);
    expect(conflicting[0]?.status).toBe("rejected");
    expect(await db.replay.count({where: {tenantId}})).toBe(1);
    expect(await db.event.count({where: {tenantId}})).toBe(2);
    expect(await db.outbox.count({where: {event: {tenantId}}})).toBe(1);
    const replayEvent = await db.event.findUniqueOrThrow({where: {id: persisted!.eventId},include: {outbox: true}});
    expect(replayEvent.id).not.toBe(eventId);
    expect(replayEvent.payload).toBeNull();
    expect(replayEvent.payloadS3Key).toBe(archiveKey);
    expect(replayEvent.outbox?.published).toBe(false);
    const original = await db.delivery.findUniqueOrThrow({where: {id: deliveryId}});
    expect(original.status).toBe("DEAD_LETTERED");
    expect(original.attemptCount).toBe(8);
    expect(original.lastError).toBe("original failure");
  } finally {
    try {
      await db.$transaction(async tx => {
        await tx.replay.deleteMany({where: {tenantId}});
        await tx.outbox.deleteMany({where: {event: {tenantId}}});
        await tx.deadLetter.deleteMany({where: {tenantId}});
        await tx.delivery.deleteMany({where: {tenantId}});
        await tx.event.deleteMany({where: {tenantId}});
        await tx.tenant.deleteMany({where: {id: tenantId}});
      });
    } finally {
      if (locked) await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`;
      await Promise.all([lock.$disconnect(), db.$disconnect()]);
    }
  }
}, 60000);
