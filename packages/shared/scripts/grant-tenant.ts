import { createSingleConnectionPrisma } from "../src/prisma";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("bun run grant:tenant --github-id <numeric GitHub ID> --tenant <tenant UUID> [--revoke]");
} else {
  let githubId: string | undefined;
  let tenantId: string | undefined;
  let revoke = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--github-id" && !githubId) githubId = args[++index];
    else if (args[index] === "--tenant" && !tenantId) tenantId = args[++index];
    else if (args[index] === "--revoke" && !revoke) revoke = true;
    else throw new Error("Use grant:tenant --help");
  }
  if (!githubId || !/^[1-9][0-9]{0,19}$/.test(githubId) || !tenantId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error("Supply the immutable numeric GitHub user ID and an existing tenant UUID");
  }
  const db = createSingleConnectionPrisma();
  try {
    const result = await db.$transaction(async tx => {
      const user = await tx.user.findUniqueOrThrow({ where: { githubId } });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const key = { userId: user.id, tenantId: tenant.id };
      if (revoke) await tx.tenantMembership.deleteMany({ where: key });
      else await tx.tenantMembership.upsert({ where: { userId_tenantId: key }, create: key, update: {} });
      return { githubId: user.githubId, githubLogin: user.githubLogin, tenantId: tenant.id, revoked: revoke };
    }, { maxWait: 5000, timeout: 10000 });
    console.log(JSON.stringify(result));
  } finally { await db.$disconnect(); }
}
