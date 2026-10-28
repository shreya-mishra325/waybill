import express from "express";
import pinoHttp from "pino-http";
import { createApiMetrics, metricsServerOptions, startMetricsServer } from "@waybill/shared";
import { observeApiRequests } from "./metrics";
import { eventsRouter } from "./routes/events";

import { deliveryHistoryRouter } from "./routes/delivery-history";

import { deadLettersRouter } from "./routes/dead-letters";

import { authConfig } from "./services/auth-config";
import { createAuthService } from "./services/auth";
import { createAuthRouter } from "./routes/auth";
import { authCors, installTenantAuthorization } from "./middleware/auth";

import { createApiKeyService } from "./services/api-keys";
import { createApiKeysRouter } from "./routes/api-keys";

const authentication = createAuthService(authConfig());
if (authentication.config.mode === "development") console.warn("API authentication bypass is enabled for local development");
const apiKeys = createApiKeyService(authentication);
const app = express();
const metricsOptions = metricsServerOptions(process.env, 9100);
if (metricsOptions) {
  const metrics = createApiMetrics();
  app.use(observeApiRequests(metrics));
  try {
    startMetricsServer(metrics.registry, metricsOptions);
    console.log(`API metrics listening on ${metricsOptions.hostname}:${metricsOptions.port}`);
  } catch (error) {
    console.error("API metrics listener failed to start; API will continue", error);
  }
}
app.use(express.json({ limit: "2mb" }));
app.use(pinoHttp({ serializers: {
  req(req) { return { id: req.id, method: req.method, url: typeof req.url === "string" ? req.url.split("?")[0] : undefined }; },
  res(res) { return { statusCode: res.statusCode }; },
} }));
app.use(authCors(authentication));
app.use("/auth", createAuthRouter(authentication));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

installTenantAuthorization(app, authentication, apiKeys);
app.use(createApiKeysRouter(apiKeys));
app.use(eventsRouter);
app.use(deliveryHistoryRouter);
app.use(deadLettersRouter);

const port = process.env.API_PORT ? Number(process.env.API_PORT) : 3000;
app.listen(port, () => {
  console.log(`API listening on :${port}`);
});
