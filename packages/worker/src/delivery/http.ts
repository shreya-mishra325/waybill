const HTTP_TIMEOUT_MS = 10_000;

export type WebhookResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string };

export async function postWebhook(
  url: string,
  body: unknown,
): Promise<WebhookResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
