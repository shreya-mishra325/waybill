import { createWebhookReceiver } from "./webhook-receiver";

const tenantId = process.env.RECEIVER_TENANT_ID ?? "";
const secret = process.env.RECEIVER_HMAC_SECRET ?? "";
const handler = createWebhookReceiver(tenantId, secret);
const port = process.env.RECEIVER_PORT ? Number(process.env.RECEIVER_PORT) : 4000;

const server = Bun.serve({
  port,
  idleTimeout: 10,
  fetch: handler,
});

console.log(`receiver listening on :${server.port}`);
