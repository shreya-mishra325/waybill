import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from "../../../shared/src/webhook-signature";

const HTTP_TIMEOUT_MS = 10_000;

export type WebhookResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string };

export async function postWebhook(
  url: string,
  body: unknown,
  secret: string,
): Promise<WebhookResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const serialized = JSON.stringify(body);
    if (serialized === undefined) throw new Error("Webhook body must be JSON serializable");
    const signature = signWebhook(serialized, secret);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [WEBHOOK_SIGNATURE_HEADER]: signature },
      body: serialized,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `receiver returned ${response.status}`,
      };
    }

    return { ok: true, status: response.status };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        status: null,
        error: `webhook POST timed out after ${HTTP_TIMEOUT_MS}ms`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}
