import { prisma } from "../src/prisma";

const API_URL = process.env.API_URL ?? "http://localhost:3000/events";

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirst({
    where: { name: "dev-tenant" },
  });
  if (!tenant) {
    throw new Error("No dev-tenant row. Run bun run seed:tenant first.");
  }

  const body = {
    tenantId: tenant.id,
    type: "order.shipped",
    payload: { orderId: "1" },
  };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  const text = await response.text();
  console.log(response.status, text);

  if (!response.ok) {
    process.exit(1);
  }
}

main()
  .catch((err: unknown) => {
    console.error("post event failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
