import { Router } from "express";
import { authControllers } from "../controllers/auth";
import type { AuthService } from "../services/auth";

export function createAuthRouter(service: AuthService) {
  const router = Router();
  const handlers = authControllers(service);
  router.get("/github", handlers.begin);
  router.get("/github/callback", handlers.complete);
  router.get("/me", handlers.me);
  router.post("/logout", handlers.logout);
  return router;
}
