import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADER = "X-Waybill-Signature";

type WebhookBody = string | Uint8Array;

export function signWebhook(body: WebhookBody, secret: string): string {
  if (secret.length === 0) throw new Error("Webhook signing secret must not be empty");
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(
  body: WebhookBody,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!secret || !signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signWebhook(body, secret).slice(7), "hex");
  const supplied = Buffer.from(signature.slice(7), "hex");
  return timingSafeEqual(expected, supplied);
}
