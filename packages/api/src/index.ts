import express from "express";
import pinoHttp from "pino-http";
import { createApiMetrics, metricsServerOptions, startMetricsServer } from "@waybill/shared";
import { observeApiRequests } from "./metrics";
import { eventsRouter } from "./routes/events";

import { deliveryHistoryRouter } from "./routes/delivery-history";

import { deadLettersRouter } from "./routes/dead-letters";

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
app.use(pinoHttp());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use(eventsRouter);
app.use(deliveryHistoryRouter);
app.use(deadLettersRouter);

const port = process.env.API_PORT ? Number(process.env.API_PORT) : 3000;
app.listen(port, () => {
  console.log(`API listening on :${port}`);
});
