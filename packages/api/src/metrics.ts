import type { RequestHandler } from "express";
import type { ApiMetrics, HttpMethod, HttpOperation, HttpStatusClass } from "@waybill/shared";

const methods: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function operationFor(method: string, path: string): HttpOperation {
  if (method === "POST" && /^\/events\/?$/i.test(path)) return "ingestion";
  if (method === "GET" || method === "HEAD") {
    if (/^\/health\/?$/i.test(path)) return "health";
    if (/^\/tenants\/[^/]+\/deliveries\/?$/i.test(path)) return "history";
    if (/^\/tenants\/[^/]+\/deliveries\/summary\/?$/i.test(path)) return "summary";
    if (/^\/tenants\/[^/]+\/dead-letters\/?$/i.test(path)) return "dead_letters";
    if (/^\/tenants\/[^/]+\/dead-letters\/[^/]+\/payload\/?$/i.test(path)) return "archive";
  }
  if (method === "POST" && /^\/tenants\/[^/]+\/dead-letters\/[^/]+\/replay\/?$/i.test(path)) return "replay";
  return "unmatched";
}

export function observeApiRequests(metrics: ApiMetrics): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    const method: HttpMethod = methods.includes(req.method) ? req.method as HttpMethod : "OTHER";
    const operation = operationFor(req.method, req.path);
    let recorded = false;
    const record = (aborted: boolean) => {
      if (recorded) return;
      recorded = true;
      const statusClass: HttpStatusClass = aborted ? "aborted"
        : res.statusCode >= 100 && res.statusCode < 600
          ? `${Math.floor(res.statusCode / 100)}xx` as HttpStatusClass : "other";
      metrics.observeHttp(operation, method, statusClass, (performance.now() - started) / 1000);
    };
    res.once("finish", () => record(false));
    res.once("close", () => record(!res.writableFinished));
    next();
  };
}
