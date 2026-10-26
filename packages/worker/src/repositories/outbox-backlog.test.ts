import { expect, test } from "bun:test";
import { PrismaClient } from "@waybill/shared";
import { createOutboxBacklogReader, outboxSamplerUrl } from "./outbox-backlog";

test("outbox sampler bounds a separate connection while preserving database and TLS settings", () => {
  const url = new URL(outboxSamplerUrl("postgresql://test:test@localhost:15432/webhook_platform?sslmode=require&connection_limit=8"));
  expect(url.searchParams.get("connection_limit")).toBe("1");
  expect(url.searchParams.get("pool_timeout")).toBe("1");
  expect(url.searchParams.get("connect_timeout")).toBe("2");
  expect(url.searchParams.get("socket_timeout")).toBe("5");
  expect(url.searchParams.get("sslmode")).toBe("require");
  for (const invalid of [undefined, "not-a-url", "https://localhost/db", "postgresql://localhost/"]) {
    expect(() => outboxSamplerUrl(invalid)).toThrow();
  }
});

test.skipIf(process.env.RUN_BACKLOG_DB_TESTS !== "1")("outbox sampler counts pending rows and bounds lock waits in isolated Postgres", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "15432" || url.pathname !== "/webhook_platform") {
    throw new Error("Backlog database tests require the isolated local Waybill database");
  }
  const db = new PrismaClient();
  const reader = createOutboxBacklogReader(url.toString());
  const tenantId = crypto.randomUUID();
  const eventIds = [crypto.randomUUID(), crypto.randomUUID()];
  const signal = new AbortController().signal;
  try {
    if (await db.outbox.count({ where: { published: false } }) !== 0) throw new Error("Use an isolated empty outbox for backlog database tests");
    expect(await reader.count(signal)).toBe(0);
    await db.tenant.create({ data: { id: tenantId, name: "backlog-test", hmacSecret: "test-only" } });
    for (const [index, id] of eventIds.entries()) {
      await db.event.create({ data: { id, tenantId, type: "backlog.test", payload: {}, outbox: { create: { published: index === 1 } } } });
    }
    expect(await reader.count(signal)).toBe(1);
    await db.outbox.updateMany({ where: { eventId: eventIds[0] }, data: { published: true } });
    expect(await reader.count(signal)).toBe(0);
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const lock = db.$transaction(async tx => {
      await tx.$executeRaw`LOCK TABLE outbox IN ACCESS EXCLUSIVE MODE`;
      locked();
      await hold;
    }, { timeout: 5000 });
    try {
      await Promise.race([ready, lock.then(() => { throw new Error("Lock transaction ended before the test acquired its lock"); })]);
      const started = performance.now();
      await expect(reader.count(signal)).rejects.toBeDefined();
      expect(performance.now() - started).toBeLessThan(3000);
    } finally {
      release();
      await lock;
    }
    expect(await reader.count(signal)).toBe(0);
  } finally {
    try {
      await db.outbox.deleteMany({ where: { eventId: { in: eventIds } } });
      await db.event.deleteMany({ where: { tenantId } });
      await db.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      await Promise.all([reader.disconnect(), db.$disconnect()]);
    }
  }
}, 15000);
