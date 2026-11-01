import type { DashboardSession, DeliveryRecord, DeliveryStatus } from "./dashboard-types";

export const selectedWorkspaceKey = "waybill:workspace";
export const oauthReturnKey = "waybill:auth-return";
export const statusLabels: Record<DeliveryStatus, string> = {
  PENDING: "Pending", IN_FLIGHT: "In flight", SUCCEEDED: "Delivered", FAILED: "Failed", DEAD_LETTERED: "Dead letter",
};
export function deliveryLabel(row: Pick<DeliveryRecord, "status" | "nextAttemptAt">) {
  return row.status === "FAILED" && row.nextAttemptAt ? "Awaiting retry" : statusLabels[row.status];
}
export function selectedWorkspace(session: DashboardSession, id: string | null | undefined) {
  return session.tenants.find(tenant => tenant.id === id) ?? null;
}
export function formatCount(value: number) { return new Intl.NumberFormat("en-US").format(value); }
export function formatRate(value: number | null) {
  return value === null ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value) + "%";
}
export function formatTimestamp(value: string) {
  const date = new Date(value);
  return { day: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }).format(date),
    time: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).format(date) + " UTC" };
}
export function readWorkspacePreference() {
  try { return localStorage.getItem(selectedWorkspaceKey); } catch { return null; }
}
export function saveWorkspacePreference(id: string | null) {
  try { if (id) localStorage.setItem(selectedWorkspaceKey, id); else localStorage.removeItem(selectedWorkspaceKey); }
  catch { return false; }
  return true;
}
