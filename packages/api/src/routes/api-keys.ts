import { Router } from "express";
import { apiKeyControllers } from "../controllers/api-keys";
import type { ApiKeyService } from "../services/api-keys";

export function createApiKeysRouter(service: ApiKeyService) {
  const router = Router();
  const handlers = apiKeyControllers(service);
  router.get("/tenants/:tenantId/api-keys", handlers.list);
  router.post("/tenants/:tenantId/api-keys", handlers.issue);
  router.post("/tenants/:tenantId/api-keys/:keyId/revoke", handlers.revoke);
  return router;
}
