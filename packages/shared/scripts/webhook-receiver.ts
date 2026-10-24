import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "../src/webhook-signature";

export function createWebhookReceiver(tenantId: string, secret: string) {
  if (!tenantId || !secret) throw new Error("Receiver tenant ID and secret are required");

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await req.arrayBuffer());
    } catch {
      return new Response("could not read request body", { status: 400 });
    }
    if (!verifyWebhookSignature(bytes, req.headers.get(WEBHOOK_SIGNATURE_HEADER), secret)) {
      return new Response("invalid signature", { status: 401 });
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return new Response("invalid JSON", { status: 400 });
    }
    if (typeof body !== "object" || body === null || !("tenantId" in body) || body.tenantId !== tenantId) {
      return new Response("unexpected tenant", { status: 403 });
    }
    return Response.json({ ok: true });
  };
}
