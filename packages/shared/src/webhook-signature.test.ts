import { describe, expect, test } from "bun:test";
import { signWebhook, verifyWebhookSignature } from "./webhook-signature";

describe("webhook signatures", () => {
  const secret = "tenant-test-secret";
  const body = '{"eventId":"event-1","payload":{"message":"hello"}}';

  test("matches the RFC 4231 HMAC-SHA256 test vector", () => {
    expect(signWebhook("Hi There", "\x0b".repeat(20))).toBe(
      "sha256=b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  test("accepts the exact body with the matching tenant secret", () => {
    expect(verifyWebhookSignature(body, signWebhook(body, secret), secret)).toBe(true);
  });

  test("rejects a modified payload and a different tenant secret", () => {
    const signature = signWebhook(body, secret);
    expect(verifyWebhookSignature(body.replace("hello", "changed"), signature, secret)).toBe(false);
    expect(verifyWebhookSignature(body, signature, "another-tenant-secret")).toBe(false);
  });

  test("verifies raw bytes without normalizing JSON whitespace or key order", () => {
    const signature = signWebhook(body, secret);
    expect(verifyWebhookSignature(JSON.stringify(JSON.parse(body), null, 2), signature, secret)).toBe(false);
    expect(verifyWebhookSignature('{"payload":{"message":"hello"},"eventId":"event-1"}', signature, secret)).toBe(false);
    expect(verifyWebhookSignature(new TextEncoder().encode(body), signature, secret)).toBe(true);
  });

  test("preserves Unicode and large payload bytes", () => {
    for (const text of ['{"message":"नमस्ते 🌍"}', "x".repeat(300_000)]) {
      const bytes = new TextEncoder().encode(text);
      expect(signWebhook(bytes, secret)).toBe(signWebhook(text, secret));
      expect(verifyWebhookSignature(bytes, signWebhook(text, secret), secret)).toBe(true);
      expect(verifyWebhookSignature(text + " ", signWebhook(text, secret), secret)).toBe(false);
    }
  });

  test("rejects missing, malformed, or combined signature headers without throwing", () => {
    const signature = signWebhook(body, secret);
    for (const invalid of [null, undefined, "", "sha256=", "sha256=" + "g".repeat(64),
      "sha256=" + "a".repeat(62), "sha256=" + "a".repeat(66), signature.toUpperCase(),
      ` ${signature}`, `${signature}, ${signature}`, signature.replace("sha256", "sha1")]) {
      expect(verifyWebhookSignature(body, invalid, secret)).toBe(false);
    }
  });

  test("rejects empty secrets and supports an empty body", () => {
    expect(() => signWebhook(body, "")).toThrow("must not be empty");
    expect(verifyWebhookSignature(body, signWebhook(body, secret), "")).toBe(false);
    expect(verifyWebhookSignature("", signWebhook("", secret), secret)).toBe(true);
  });
});
