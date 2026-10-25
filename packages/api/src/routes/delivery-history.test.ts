import { expect, test } from "bun:test";
import express from "express";
import pinoHttp from "pino-http";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { PrismaClient, createS3Client, disconnectReadReplica } from "@waybill/shared";
import type { summarizeDeliveries } from "../services/delivery-summary-values";
import { deadLettersRouter } from "./dead-letters";
import { deliveryHistoryRouter } from "./delivery-history";

const enabled = process.env.RUN_REPLICA_TESTS === "1";

test.skipIf(!enabled)("delivery history and summary HTTP reads isolate tenants, paginate ties, and observe replica lag", async () => {
  const primaryUrl = new URL(process.env.DATABASE_URL ?? "");
  const replicaUrl = new URL(process.env.READ_REPLICA_DATABASE_URL ?? "");
  for (const url of [primaryUrl, replicaUrl]) {
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/webhook_platform") {
      throw new Error("Replica integration tests require the local Waybill databases");
    }
  }
  if (primaryUrl.port !== "15432" || replicaUrl.port !== "15433") throw new Error("Expected local primary and replica ports");
  primaryUrl.searchParams.set("socket_timeout", "10");
  primaryUrl.searchParams.set("connect_timeout", "5");
  const adminUrl = new URL(primaryUrl);
  adminUrl.port = "15433";
  const db = new PrismaClient({ datasources: { db: { url: primaryUrl.toString() } } });
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  const app = express();
  app.use(pinoHttp({ enabled: false }));
  app.use(deliveryHistoryRouter);
  app.use(deadLettersRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local HTTP address");
  const tenantId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const secret = crypto.randomUUID();
  const deliveryIds = Array.from({ length: 3 }, () => crypto.randomUUID()).sort().reverse();
  const eventIds = Array.from({ length: 4 }, () => crypto.randomUUID());
  const deadLetterIds = Array.from({ length: 3 }, () => crypto.randomUUID()).sort().reverse();
  const archiveKeys = [`dead-letters/${eventIds[0]}.json`, `events/${tenantId}/${eventIds[1]}.json`, `dead-letters/${eventIds[2]}.json`];
  const liveArchives = process.env.RUN_ARCHIVE_TESTS === "1";
  const uploadedKeys = new Set<string>();
  let pauseRequested = false;
  const url = `http://127.0.0.1:${address.port}/tenants/${tenantId}/deliveries`;
  async function get(target: string) {
    const response = await fetch(target, { signal: AbortSignal.timeout(15000) });
    const body = await response.json() as { items: { id: string; tenantId: string }[]; nextCursor: string | null; error?: string };
    return { status: response.status, body };
  }
  async function payload(target: string) {
    const response = await fetch(target, { signal: AbortSignal.timeout(20000) });
    const body = await response.json() as { payload?: unknown; error?: string };
    return { status: response.status, body, cacheControl: response.headers.get("Cache-Control") };
  }
  const deadUrl = url.replace("/deliveries", "/dead-letters");
  async function summary(target = url + "/summary") {
    const response = await fetch(target, { signal: AbortSignal.timeout(15000) });
    const body = await response.json() as ReturnType<typeof summarizeDeliveries> & { error?: string };
    return { status: response.status, body };
  }
  async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Bun.sleep(100);
    }
    throw new Error("Replica test timed out");
  }
  try {
    await db.$transaction(async tx => {
      await tx.tenant.createMany({ data: [tenantId, otherId].map(id => ({ id, name: "history-test", hmacSecret: secret })) });
      await tx.event.createMany({ data: eventIds.map((id, i) => ({id, tenantId: i === 3 ? otherId : tenantId,
        type: "history.test", payload: { privateMarker: secret }})) });
      await tx.delivery.createMany({ data: eventIds.map((eventId, i) => ({
        id: deliveryIds[i] ?? crypto.randomUUID(), eventId, tenantId: i === 3 ? otherId : tenantId,
        targetUrl: "http://127.0.0.1:4000/webhook", status: i === 2 ? "FAILED" : "SUCCEEDED",
        createdAt: new Date(i === 2 ? "2026-10-24T00:00:00Z" : "2026-10-25T00:00:00Z"),
      })) });
    });
    await waitFor(async () => (await get(url)).body.items?.length === 3);
    const page1 = await get(url + "?limit=1");
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((row: { id: string }) => row.id)).toEqual([deliveryIds[0]]);
    const page2 = await get(url + "?limit=1&cursor=" + page1.body.nextCursor);
    expect(page2.body.items.map((row: { id: string }) => row.id)).toEqual([deliveryIds[1]]);
    const page3 = await get(url + "?limit=1&cursor=" + page2.body.nextCursor);
    expect(page3.body.items.map((row: { id: string }) => row.id)).toEqual([deliveryIds[2]]);
    expect(page3.body.nextCursor).toBeNull();
    const all = await get(url);
    expect(all.body.items.every((row: { tenantId: string }) => row.tenantId === tenantId)).toBe(true);
    expect(JSON.stringify(all.body)).not.toContain(secret);
    expect(JSON.stringify(all.body)).not.toContain("hmacSecret");
    expect((await get(url + "?status=FAILED")).body.items.length).toBe(1);
    expect((await get(url + "?limit=101")).status).toBe(400);
    expect((await get(url.replace(tenantId, "invalid"))).status).toBe(400);
    expect((await get(url.replace(tenantId, otherId) + "?cursor=" + page1.body.nextCursor)).status).toBe(400);
    expect((await get(url.replace(tenantId, crypto.randomUUID()))).body.items).toEqual([]);

    expect((await summary()).body).toEqual({ total: 3, completed: 2, successRatePercent: 100,
      counts: { PENDING: 0, IN_FLIGHT: 0, SUCCEEDED: 2, FAILED: 1, DEAD_LETTERED: 0 } });
    expect((await summary(url.replace(tenantId, otherId) + "/summary")).body.total).toBe(1);
    expect((await summary(url.replace(tenantId, crypto.randomUUID()) + "/summary")).body).toEqual({
      total: 0, completed: 0, successRatePercent: null,
      counts: { PENDING: 0, IN_FLIGHT: 0, SUCCEEDED: 0, FAILED: 0, DEAD_LETTERED: 0 },
    });
    expect((await summary(url + "/summary?status=FAILED")).status).toBe(400);
    expect((await summary(url.replace(tenantId, "invalid") + "/summary")).status).toBe(400);
    for (const status of ["PENDING", "IN_FLIGHT", "DEAD_LETTERED"] as const) {
      const eventId = crypto.randomUUID();
      await db.event.create({ data: {id: eventId, tenantId, type: "summary.test", payload: {}} });
      await db.delivery.create({ data: {eventId, tenantId, status, targetUrl: "http://127.0.0.1:4000/webhook"} });
    }
    await waitFor(async () => (await summary()).body.total === 6);
    const totals = await summary();
    expect(totals.status).toBe(200);
    expect(totals.body).toEqual({ total: 6, completed: 3, successRatePercent: 66.67,
      counts: { PENDING: 1, IN_FLIGHT: 1, SUCCEEDED: 2, FAILED: 1, DEAD_LETTERED: 1 } });

    await db.deadLetter.createMany({ data: [0, 1, 2].map(i => ({
      id: deadLetterIds[i], tenantId, eventId: eventIds[i]!, deliveryId: deliveryIds[i]!,
      targetUrl: "http://127.0.0.1:4000/webhook", attemptCount: 8, lastError: "test failure",
      payloadS3Key: archiveKeys[i]!, createdAt: new Date("2026-10-25T00:00:00Z"),
    })) });
    await waitFor(async () => (await get(deadUrl)).body.items?.length === 3);
    const deadPage1 = await get(deadUrl + "?limit=1");
    expect(deadPage1.body.items[0]?.id).toBe(deadLetterIds[0]);
    const deadPage2 = await get(deadUrl + "?limit=1&cursor=" + deadPage1.body.nextCursor);
    expect(deadPage2.body.items[0]?.id).toBe(deadLetterIds[1]);
    const deadPage3 = await get(deadUrl + "?limit=1&cursor=" + deadPage2.body.nextCursor);
    expect(deadPage3.body.items[0]?.id).toBe(deadLetterIds[2]);
    expect(deadPage3.body.nextCursor).toBeNull();
    expect((await get(deadUrl.replace(tenantId, otherId))).body.items).toEqual([]);
    expect(JSON.stringify((await get(deadUrl)).body)).not.toContain("payloadS3Key");
    expect((await get(deadUrl + "?cursor=" + page1.body.nextCursor)).status).toBe(400);
    const payloadUrl = deadUrl + "/" + deadLetterIds[0] + "/payload";
    expect((await payload(payloadUrl.replace(tenantId, otherId))).status).toBe(404);
    expect((await payload(deadUrl + "/" + crypto.randomUUID() + "/payload")).status).toBe(404);
    expect((await payload(payloadUrl + "?key=override")).status).toBe(400);
    if (liveArchives) {
      const s3 = createS3Client();
      await s3.send(new DeleteObjectCommand({Bucket: process.env.S3_BUCKET_NAME,
        Key: `dead-letters/permission-check-${crypto.randomUUID()}.json`}), {abortSignal: AbortSignal.timeout(10000)});
      const manifestPath = `logs/archive-test-${tenantId}.json`;
      await mkdir("logs", { recursive: true });
      await Bun.write(manifestPath, JSON.stringify({ bucket: process.env.S3_BUCKET_NAME,
        keys: archiveKeys.slice(0, 2), cleanupComplete: false }, null, 2));
      let archiveTestError: unknown;
      const expectedPayloads = [{ message: "नमस्ते 🌍", testId: tenantId }, { blob: "x".repeat(270000) }];
      try {
        for (let i = 0; i < 2; i++) {
          uploadedKeys.add(archiveKeys[i]!);
          await s3.send(new PutObjectCommand({Bucket: process.env.S3_BUCKET_NAME, Key: archiveKeys[i],
            Body: JSON.stringify(expectedPayloads[i]), ContentType: "application/json", Metadata: { "waybill-test": "phase7-dead-letter-api" }}), {abortSignal: AbortSignal.timeout(15000)});
          const result = await payload(deadUrl + "/" + deadLetterIds[i] + "/payload");
          expect(result.status).toBe(200);
          expect(result.body.payload).toEqual(expectedPayloads[i]);
          expect(result.cacheControl).toBe("no-store");
        }
        expect((await payload(deadUrl + "/" + deadLetterIds[2] + "/payload")).status).toBe(410);
        await s3.send(new PutObjectCommand({Bucket: process.env.S3_BUCKET_NAME, Key: archiveKeys[0], Body: "{"}),
          {abortSignal: AbortSignal.timeout(15000)});
        expect((await payload(payloadUrl)).status).toBe(502);
      } catch (error) {
        archiveTestError = error;
        throw error;
      } finally {
        const results = await Promise.allSettled([...uploadedKeys].map(Key => s3.send(
          new DeleteObjectCommand({Bucket: process.env.S3_BUCKET_NAME, Key}), {abortSignal: AbortSignal.timeout(15000)})));
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
        await Bun.write(manifestPath, JSON.stringify({ bucket: process.env.S3_BUCKET_NAME,
          keys: [...uploadedKeys], cleanupComplete: failures.length === 0 }, null, 2));
        if (failures.length) throw new AggregateError(archiveTestError === undefined ? failures : [archiveTestError, ...failures],
          `Archive test object cleanup failed; object keys recorded in ${manifestPath}`);
      }
    }

    const state = await admin.$queryRaw<{ standby: boolean; paused: boolean }[]>`
      SELECT pg_is_in_recovery() AS standby, pg_is_wal_replay_paused() AS paused
    `;
    if (!state[0]?.standby || state[0].paused) throw new Error("Expected an unpaused standby");
    pauseRequested = true;
    await admin.$queryRaw`SELECT pg_wal_replay_pause()::text`;
    await waitFor(async () => {
      const rows = await admin.$queryRaw<{ state: string }[]>`SELECT pg_get_wal_replay_pause_state() AS state`;
      return rows[0]?.state === "paused";
    });
    await db.delivery.update({ where: { id: deliveryIds[2] }, data: { status: "SUCCEEDED" } });
    expect((await db.delivery.findUniqueOrThrow({ where: { id: deliveryIds[2] } })).status).toBe("SUCCEEDED");
    expect((await get(url + "?status=FAILED")).body.items.length).toBe(1);
    expect((await summary()).body.successRatePercent).toBe(66.67);
    await db.deadLetter.update({where: {id: deadLetterIds[0]}, data: {lastError: "updated on primary"}});
    const pausedDeadLetters = await fetch(deadUrl, {signal: AbortSignal.timeout(15000)});
    const pausedBody = await pausedDeadLetters.json() as {items: {id: string; lastError: string}[]};
    expect(pausedBody.items.find(row => row.id === deadLetterIds[0])?.lastError).toBe("test failure");
    await admin.$queryRaw`SELECT pg_wal_replay_resume()::text`;
    pauseRequested = false;
    await waitFor(async () => (await get(url + "?status=FAILED")).body.items.length === 0);
    await waitFor(async () => (await summary()).body.successRatePercent === 75);
    expect((await summary()).body.counts.FAILED).toBe(0);
    const configuredReplica = process.env.READ_REPLICA_DATABASE_URL;
    await disconnectReadReplica();
    try {
      process.env.READ_REPLICA_DATABASE_URL = primaryUrl.toString();
      const unavailable = await get(url);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.error).toBe("Delivery history is temporarily unavailable");
      expect(Object.keys(unavailable.body)).toEqual(["error"]);
      expect((await get(deadUrl)).status).toBe(503);
      expect((await payload(payloadUrl)).status).toBe(503);
      const unavailableSummary = await summary();
      expect(unavailableSummary.status).toBe(503);
      expect(unavailableSummary.body.error).toBe("Delivery summary is temporarily unavailable");
      expect(Object.keys(unavailableSummary.body)).toEqual(["error"]);
    } finally {
      await disconnectReadReplica();
      process.env.READ_REPLICA_DATABASE_URL = configuredReplica;
    }

  } finally {
    try {
      if (pauseRequested) await admin.$queryRaw`SELECT pg_wal_replay_resume()::text`;
    } finally {
      try {
        await db.$transaction(async tx => {
          await tx.deadLetter.deleteMany({ where: { tenantId: { in: [tenantId, otherId] } } });
          await tx.delivery.deleteMany({ where: { tenantId: { in: [tenantId, otherId] } } });
          await tx.event.deleteMany({ where: { tenantId: { in: [tenantId, otherId] } } });
          await tx.tenant.deleteMany({ where: { id: { in: [tenantId, otherId] } } });
        });
      } finally {
        await Promise.all([disconnectReadReplica(), db.$disconnect(), admin.$disconnect()]);
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  }
}, 90000);
