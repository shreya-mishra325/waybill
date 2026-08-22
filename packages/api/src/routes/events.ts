import { Router } from "express";
import { postEvent } from "../controllers/events";

export const eventsRouter = Router();

eventsRouter.post("/events", postEvent);
