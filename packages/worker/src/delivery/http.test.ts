import { describe, expect, test } from "bun:test";
import { createWebhookReceiver } from "../../../shared/scripts/webhook-receiver";
import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from "../../../shared/src/webhook-signature";
import { postWebhook } from "./http";

describe("signed webhook HTTP delivery", () => {
  const tenantId = "tenant-http-test";
  const secret = "local-test-only-secret";

  test("accepts signed envelopes including Unicode, large payloads, and repeated delivery", async () => {
    const handler = createWebhookReceiver(tenantId, secret);
    const bodies: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      bodies.push(await req.clone().text());
      return handler(req);
    } });
    try {
      const url = new URL("/webhook", server.url).toString();
      for (const payload of [{ message: "नमस्ते 🌍" }, { data: "x".repeat(300_000) }]) {
        const body = { eventId: "event-test", tenantId, type: "test", payload };
        expect(await postWebhook(url, body, secret)).toEqual({ ok: true, status: 200 });
        expect(bodies.at(-1)).toBe(JSON.stringify(body));
        expect(await postWebhook(url, body, secret)).toEqual({ ok: true, status: 200 });
      }
      expect(await postWebhook(url, { tenantId }, "another-tenant-secret")).toEqual({
        ok: false, status: 401, error: "receiver returned 401",
      });
      const before = bodies.length;
      expect((await postWebhook(url, { tenantId }, "")).ok).toBe(false);
      expect(bodies.length).toBe(before);
    } finally {
      await server.stop(true);
    }
  });

  test("rejects tampering, missing headers, and a signed unexpected tenant over HTTP", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createWebhookReceiver(tenantId, secret) });
    try {
      const url = new URL("/webhook", server.url);
      const body = JSON.stringify({ tenantId, payload: { value: "original" } });
      const signature = signWebhook(body, secret);
      for (const [sent, header, status] of [
        [body, signature, 200],
        [body.replace("original", "tampered"), signature, 401],
        [body, "", 401],
        [body, "sha256=invalid", 401],
        [JSON.stringify({ tenantId: "other" }), signWebhook(JSON.stringify({ tenantId: "other" }), secret), 403],
        ["{", signWebhook("{", secret), 400],
      ] as const) {
        const response = await fetch(url, { method: "POST", body: sent,
          headers: { [WEBHOOK_SIGNATURE_HEADER]: header }, signal: AbortSignal.timeout(5000) });
        expect(response.status).toBe(status);
        await response.text();
      }
    } finally {
      await server.stop(true);
    }
  });

  test("requires trusted receiver configuration", () => {
    expect(() => createWebhookReceiver("", secret)).toThrow("required");
    expect(() => createWebhookReceiver(tenantId, "")).toThrow("required");
  });
});
