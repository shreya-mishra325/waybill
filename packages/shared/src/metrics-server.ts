import type { Registry } from "prom-client";

export function metricsServerOptions(
  env: Record<string, string | undefined>,
  defaultPort: number,
  portVariable: "API_METRICS_PORT" | "PUBLISHER_METRICS_PORT" | "WORKER_METRICS_PORT" = "API_METRICS_PORT",
) {
  if (env.METRICS_ENABLED !== "true") return undefined;
  const hostname = env.METRICS_HOST ?? "127.0.0.1";
  if (hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new Error("METRICS_HOST must be a loopback address until private monitoring networking is configured");
  }
  const port = Number(env[portVariable] ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${portVariable} must be an integer from 1 to 65535`);
  }
  return { hostname, port };
}

export function startMetricsServer(registry: Registry, options: { hostname: string; port: number }) {
  return Bun.serve({
    ...options,
    idleTimeout: 5,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path !== "/metrics") return new Response("Not found", { status: 404 });
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
      }
      try {
        return new Response(await registry.metrics(), {
          headers: { "Content-Type": registry.contentType, "Cache-Control": "no-store" },
        });
      } catch (error) {
        console.error("Metrics collection failed", error);
        return new Response("Metrics unavailable", { status: 503 });
      }
    },
  });
}
