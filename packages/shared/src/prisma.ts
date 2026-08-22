import { PrismaClient } from "@prisma/client";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Missing required env var: DATABASE_URL");
  }

  const parsed = new URL(url);
  if (!parsed.searchParams.has("connect_timeout")) {
    parsed.searchParams.set("connect_timeout", "5");
  }
  return parsed.toString();
}

export const prisma = new PrismaClient({
  datasources: {
    db: { url: databaseUrl() },
  },
});
