import type { Metadata } from "next";
import { DashboardProvider } from "../../components/dashboard/provider";
import { DashboardShell } from "../../components/dashboard/shell";
import { normalizeApiOrigin } from "../../lib/dashboard-api";
import "./dashboard.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Overview | Waybill", robots: { index: false, follow: false } };
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const origin = process.env.AUTH_API_ORIGIN ?? (process.env.NODE_ENV === "development" ? "http://127.0.0.1:3000" : undefined);
  if (!origin) throw new Error("AUTH_API_ORIGIN is required for the authenticated application");
  return <DashboardProvider apiOrigin={normalizeApiOrigin(origin)}><DashboardShell>{children}</DashboardShell></DashboardProvider>;
}
