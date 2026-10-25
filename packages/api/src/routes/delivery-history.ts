import { Router } from "express";
import { getDeliveries } from "../controllers/delivery-history";

import { getSummary } from "../controllers/delivery-summary";

export const deliveryHistoryRouter = Router();
deliveryHistoryRouter.get("/tenants/:tenantId/deliveries", getDeliveries);
deliveryHistoryRouter.get("/tenants/:tenantId/deliveries/summary", getSummary);
