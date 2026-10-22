import { describe, expect, it } from "bun:test";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { listUnpublished, markPublished } from "./outbox";

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("outbox publication (Postgres)", () => {
  it("rotates across tenants, preserves selection order, and only marks confirmed sends", async () => {
    const { createSingleConnectionPrisma } = await import("@waybill/shared");
    const { publishOne } = await import("../outbox-poller");
    const db = createSingleConnectionPrisma();
    const rollback = new Error("rollback outbox test fixtures");
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
        if (await tx.outbox.count({ where: { published: false } }) !== 0) {
          throw new Error("Drain pending development outbox rows before RUN_DB_TESTS=1");
        }
        const tenantIds = Array.from({ length: 12 }, () => crypto.randomUUID()).sort();
        await tx.tenant.createMany({ data: tenantIds.map((id) => ({ id, name: "outbox-test", hmacSecret: "test-only" })) });
        const records = tenantIds.flatMap((tenantId, tenantIndex) =>
          Array.from({ length: tenantIndex === 0 ? 25 : 2 }, () => ({
            id: crypto.randomUUID(), tenantId, type: "outbox.test", payload: {},
          })),
        );
        await tx.event.createMany({ data: records });
        const outboxRows = records.map((event, index) => ({
          id: crypto.randomUUID(), eventId: event.id,
          createdAt: new Date(event.tenantId === tenantIds[0] ? "2020-01-01" : "2021-01-01"),
          published: index === 0,
        }));
        await tx.outbox.createMany({ data: outboxRows });

        const all = await listUnpublished(tx, 100);
        expect(all.length).toBe(records.length - 1);
        expect(all.some((row) => row.id === outboxRows[0].id)).toBe(false);
        const expectedBusy = outboxRows.slice(1, 25).map((row) => row.id).sort();
        expect(all.filter((row) => row.event.tenantId === tenantIds[0]).map((row) => row.id)).toEqual(expectedBusy);

        const first = await listUnpublished(tx, 10);
        expect(first.map((row) => row.event.tenantId)).toEqual(tenantIds.slice(0, 10));
        for (const row of first) await markPublished(tx, row.id);
        const second = await listUnpublished(tx, 10, first.at(-1)!.event.tenantId);
        expect(second.slice(0, 2).map((row) => row.event.tenantId)).toEqual(tenantIds.slice(10));
        expect(new Set([...first, ...second].map((row) => row.event.tenantId)).size).toBe(12);

        const row = second[0];
        const sqs = new SQSClient({ region: "ap-southeast-2" });
        const failure = new Error("simulated SQS failure");
        sqs.send = (async () => { throw failure; }) as typeof sqs.send;
        try {
          await expect(publishOne(tx, row, sqs)).rejects.toBe(failure);
          expect((await tx.outbox.findUniqueOrThrow({ where: { id: row.id } })).published).toBe(false);
          const groups: string[] = [];
          sqs.send = (async (command: SendMessageCommand) => {
            const body = JSON.parse(command.input.MessageBody!) as { eventId: string; tenantId: string };
            expect(command.input.MessageGroupId).toBe(body.tenantId);
            expect(command.input.MessageAttributes?.tenantId.StringValue).toBe(body.tenantId);
            const selected = second.find((candidate) => candidate.eventId === body.eventId)!;
            expect((await tx.outbox.findUniqueOrThrow({ where: { id: selected.id } })).published).toBe(false);
            groups.push(command.input.MessageGroupId!);
            return { MessageId: "test-confirmed", $metadata: {} };
          }) as typeof sqs.send;
          await publishOne(tx, row, sqs);
          expect((await tx.outbox.findUniqueOrThrow({ where: { id: row.id } })).published).toBe(true);
          await publishOne(tx, second[1], sqs);
          expect(groups).toEqual([row.event.tenantId, second[1].event.tenantId]);
          expect(groups[0]).not.toBe(groups[1]);
        } finally {
          sqs.destroy();
        }
        throw rollback;
      }, { maxWait: 5000, timeout: 20_000 });
    } catch (err) {
      if (err !== rollback) throw err;
    } finally {
      await db.$disconnect();
    }
  }, 30_000);
});
