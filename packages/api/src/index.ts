import express from "express";
import pinoHttp from "pino-http";
import { eventsRouter } from "./routes/events";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(pinoHttp());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use(eventsRouter);

const port = process.env.API_PORT ? Number(process.env.API_PORT) : 3000;
app.listen(port, () => {
  console.log(`API listening on :${port}`);
});
