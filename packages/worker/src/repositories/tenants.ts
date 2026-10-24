import { prisma } from "@waybill/shared";

export async function findTenantSigningSecret(tenantId: string): Promise<string> {
  const tenant = await prisma.$transaction(
    (tx) => tx.tenant.findUnique({
      where: { id: tenantId },
      select: { hmacSecret: true },
    }),
    { maxWait: 5000, timeout: 10_000 },
  );
  if (!tenant?.hmacSecret) throw new Error("Tenant signing secret is unavailable");
  return tenant.hmacSecret;
}
