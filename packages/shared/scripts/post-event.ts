import { prisma } from "../src/prisma";

const API_URL = process.env.API_URL ?? "http://localhost:3000/events";
const SQS_MAX_MESSAGE_BYTES = 262144;

async function main(): Promise<void> {
  const large = process.argv.includes("--large");

  const tenant = await prisma.tenant.findFirst({
    where: { name: "dev-tenant" },
  });
  if (!tenant) {
    throw new Error("No dev-tenant row. Run bun run seed:tenant first.");
  }

  const payload = large
    ? { blob: "x".repeat(SQS_MAX_MESSAGE_BYTES) }
    : { orderId: "1" };

  const body = {
    tenantId: tenant.id,
    type: large ? "order.archived" : "order.shipped",
    payload,
  };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(large ? 30_000 : 8_000),
  });

  const text = await response.text();
  console.log(response.status, text);

  if (!response.ok) {
    process.exit(1);
  }

  const result = JSON.parse(text) as { eventId: string; storedIn: string };
  const event = await prisma.event.findUniqueOrThrow({
    where: { id: result.eventId },
    select: { payload: true, payloadS3Key: true },
  });

  console.log({
    storedIn: result.storedIn,
    payloadIsNull: event.payload === null,
    payloadS3Key: event.payloadS3Key,
  });
}

main()
  .catch((err: unknown) => {
    console.error("post event failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
