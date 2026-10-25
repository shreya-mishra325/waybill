import { Router } from "express";
import { getDeadLetterList, getPayload, postReplay } from "../controllers/dead-letters";

export const deadLettersRouter = Router();
deadLettersRouter.get("/tenants/:tenantId/dead-letters", getDeadLetterList);
deadLettersRouter.get("/tenants/:tenantId/dead-letters/:deadLetterId/payload", getPayload);
deadLettersRouter.post("/tenants/:tenantId/dead-letters/:deadLetterId/replay", postReplay);
