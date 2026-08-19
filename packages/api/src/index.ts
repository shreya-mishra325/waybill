// Phase 0 entrypoint (Bun runtime — this file runs directly, no build step).
// Just prove the container/service boots and can report its own health.
// Routes/controllers/services get filled in starting Phase 1 — do not add
// business logic here yet.

import express from "express";
import pinoHttp from "pino-http";

const app = express();
app.use(express.json());
app.use(pinoHttp());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

const port = process.env.API_PORT ? Number(process.env.API_PORT) : 3000;
app.listen(port, () => {
  console.log(`API listening on :${port}`);
});
