import { describe, expect, test } from "bun:test";
import { INTEGRATION_EXAMPLES, INGESTION_URL, TENANT_PLACEHOLDER } from "../src/lib/integration-examples";

const tenantId = "11111111-1111-4111-8111-111111111111";
const expectedBody = {
  tenantId,
  type: "order.shipped",
  payload: { orderId: "order_123" },
};

for (const example of INTEGRATION_EXAMPLES) {
  const available = example.id === "typescript" || Boolean(Bun.which(example.id === "curl" ? "curl" : "python3"));
  describe(`${example.label} ingestion example`, () => {
    async function execute(status: number) {
      const requests: { method: string; path: string; contentType: string | null; authorization: string | null; body: unknown }[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests.push({
            method: request.method,
            path: new URL(request.url).pathname,
            contentType: request.headers.get("Content-Type"),
            authorization: request.headers.get("Authorization"),
            body: await request.json(),
          });
          return Response.json(status === 201 ? { eventId: "test-event", outboxId: "test-outbox", storedIn: "postgres" } : { error: "rate limited" }, { status });
        },
      });
      const code = example.code.replaceAll(TENANT_PLACEHOLDER, tenantId).replaceAll(INGESTION_URL, `http://127.0.0.1:${server.port}/events`);
      const args = example.id === "curl" ? ["sh", "-c", code] : example.id === "python" ? ["python3", "-c", code] : [process.execPath, "-e", code];
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => { child.kill(); }, 8000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return { exitCode, stdout, stderr, requests };
      } finally {
        clearTimeout(timer);
        child.kill();
        await server.stop(true);
      }
    }

    test.skipIf(!available)("sends the documented JSON request without invented authentication", async () => {
      const result = await execute(201);
      expect(result.stderr).not.toContain("SyntaxError");
      expect(result.exitCode).toBe(0);
      expect(result.requests).toEqual([{ method: "POST", path: "/events", contentType: "application/json", authorization: null, body: expectedBody }]);
      expect(result.stdout).toContain("test-event");
    });

    test.skipIf(!available)("reports a rejected request rather than treating it as success", async () => {
      const result = await execute(429);
      expect(result.requests).toHaveLength(1);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("429");
      expect(result.stdout).not.toContain("test-event");
    });
  });
}
