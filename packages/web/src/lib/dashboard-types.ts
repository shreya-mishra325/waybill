import type { DeliveryStatus } from "../../../shared/src/delivery-status";

export type { DeliveryStatus };
export type Workspace = { id: string; name: string };
export type DashboardSession = {
  user: { id: string; githubId: string; githubLogin: string };
  tenants: Workspace[];
  csrfToken: string;
  expiresAt: string;
};
export type DeliverySummary = {
  total: number;
  counts: Record<DeliveryStatus, number>;
  completed: number;
  successRatePercent: number | null;
};
export type DeliveryRecord = {
  id: string; eventId: string; tenantId: string; targetUrl: string; status: DeliveryStatus;
  attemptCount: number; createdAt: string; lastAttemptAt: string | null; nextAttemptAt: string | null;
  lastError: string | null; event: { type: string };
};
export type DeliveryHistory = { items: DeliveryRecord[]; nextCursor: string | null };
export const deliveryStatuses = ["PENDING", "IN_FLIGHT", "SUCCEEDED", "FAILED", "DEAD_LETTERED"] as const satisfies readonly DeliveryStatus[];
