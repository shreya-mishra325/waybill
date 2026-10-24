import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from "../src/webhook-signature";

const url = process.env.RECEIVER_URL ?? "http://127.0.0.1:4000/webhook";
const tenantId = process.env.RECEIVER_TENANT_ID;
const secret = process.env.RECEIVER_HMAC_SECRET;
if (!tenantId || !secret) throw new Error("RECEIVER_TENANT_ID and RECEIVER_HMAC_SECRET are required");
const body = JSON.stringify({ tenantId, payload: { hello: "waybill" } });

const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", [WEBHOOK_SIGNATURE_HEADER]: signWebhook(body, secret) },
  body,
  signal: AbortSignal.timeout(5000),
});

const text = await response.text();
console.log(response.status, text);
if (!response.ok) process.exit(1);
