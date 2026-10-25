import { describe, expect, test } from "bun:test";
import { createReplicaReader, readReplicaUrl } from "./read-replica";

describe("read replica configuration", () => {
  test("requires an explicit replica URL without falling back to the primary", () => {
    for (const value of [undefined, "", "   "]) {
      expect(() => createReplicaReader(value)).toThrow("READ_REPLICA_DATABASE_URL is required");
    }
  });

  test("rejects malformed URLs, other protocols, and missing database names", () => {
    for (const value of ["not-a-url", "https://replica.example/db", "postgresql://replica.example/"]) {
      expect(() => readReplicaUrl(value)).toThrow("READ_REPLICA_DATABASE_URL");
    }
  });

  test("preserves database and TLS settings while bounding connection and query waits", () => {
    const url = new URL(readReplicaUrl("postgresql://reader:test@replica.example/waybill?sslmode=require&socket_timeout=0"));
    expect(url.hostname).toBe("replica.example");
    expect(url.pathname).toBe("/waybill");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("connect_timeout")).toBe("5");
    expect(url.searchParams.get("pool_timeout")).toBe("5");
    expect(url.searchParams.get("socket_timeout")).toBe("10");
  });

  test("does not echo credentials from invalid connection URLs", () => {
    const secret = "test-password-must-not-appear";
    try {
      readReplicaUrl(`https://reader:${secret}@replica.example/db`);
      throw new Error("Expected configuration rejection");
    } catch (error) {
      expect(error instanceof Error && error.message.includes(secret)).toBe(false);
    }
  });
});
