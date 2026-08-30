const port = process.env.RECEIVER_PORT ? Number(process.env.RECEIVER_PORT) : 4000;

const server = Bun.serve({
  port,
  idleTimeout: 10,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }

    const body = await req.text();
    console.log("webhook received", {
      bytes: Buffer.byteLength(body, "utf8"),
      preview: body.slice(0, 200),
    });

    return Response.json({ ok: true });
  },
});

console.log(`receiver listening on :${server.port}`);
