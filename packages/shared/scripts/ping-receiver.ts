const url = process.env.RECEIVER_URL ?? "http://127.0.0.1:4000/webhook";

const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ hello: "waybill" }),
  signal: AbortSignal.timeout(5000),
});

const text = await response.text();
console.log(response.status, text);

if (!response.ok) {
  process.exit(1);
}
