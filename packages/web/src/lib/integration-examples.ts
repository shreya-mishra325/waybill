export const TENANT_PLACEHOLDER = "REPLACE_WITH_TENANT_UUID";
export const INGESTION_URL = "http://127.0.0.1:3000/events";

export const INTEGRATION_EXAMPLES = [
  {
    id: "curl", label: "cURL", filename: "Terminal", language: "shell",
    code: `curl --fail-with-body --max-time 10 \\
  --request POST ${INGESTION_URL} \\
  --header 'Content-Type: application/json' \\
  --data '{
    "tenantId": "${TENANT_PLACEHOLDER}",
    "type": "order.shipped",
    "payload": { "orderId": "order_123" }
  }'`,
  },
  {
    id: "typescript", label: "TypeScript", filename: "send-event.ts · Bun", language: "typescript",
    code: `const response = await fetch("${INGESTION_URL}", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tenantId: "${TENANT_PLACEHOLDER}",
    type: "order.shipped",
    payload: { orderId: "order_123" },
  }),
  signal: AbortSignal.timeout(10_000),
});

if (!response.ok) {
  throw new Error(\`Event rejected: \${response.status}\`);
}
console.log(await response.json());`,
  },
  {
    id: "python", label: "Python", filename: "send_event.py · Python 3", language: "python",
    code: `import json
import urllib.request

body = json.dumps({
    "tenantId": "${TENANT_PLACEHOLDER}",
    "type": "order.shipped",
    "payload": {"orderId": "order_123"},
}).encode("utf-8")

request = urllib.request.Request(
    "${INGESTION_URL}",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=10) as response:
    print(json.load(response))`,
  },
] as const;

export type IntegrationLanguage = typeof INTEGRATION_EXAMPLES[number]["id"];
