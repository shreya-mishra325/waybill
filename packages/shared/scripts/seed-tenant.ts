import { prisma } from "../src/prisma";

const DEV_TENANT_NAME = "dev-tenant";

async function main(): Promise<void> {
  const existing = await prisma.tenant.findFirst({
    where: { name: DEV_TENANT_NAME },
  });

  if (existing) {
    console.log("tenant already exists", { tenantId: existing.id });
    return;
  }

  const tenant = await prisma.tenant.create({
    data: {
      name: DEV_TENANT_NAME,
      hmacSecret: crypto.randomUUID(),
    },
  });

  console.log("tenant created", { tenantId: tenant.id });
}

main()
  .catch((err: unknown) => {
    console.error("seed tenant failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
