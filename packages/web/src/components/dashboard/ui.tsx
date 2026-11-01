import Link from "next/link";
import type { DeliveryRecord } from "../../lib/dashboard-types";
import { deliveryLabel } from "../../lib/dashboard-format";

export function DashboardBrand() {
  return <Link className="dashboard-brand" href="/" aria-label="Waybill public website"><span className="dashboard-brand-symbol" aria-hidden="true"><img src="/waybill_logo_navy_transparent.png" width="1254" height="1254" alt=""/></span><span>Waybill</span></Link>;
}
export function DashboardGlyph({ name }: { name: "chevron" | "workspace" | "logout" | "key" | "alert" | "menu" }) {
  const paths = {
    chevron: <path d="m9 5 7 7-7 7"/>,
    workspace: <><path d="m3 10 9-7 9 7v11H3Z"/><path d="M9 21v-8h6v8M9 8h6"/></>,
    logout: <><path d="M10 3H4v18h6m4-15 6 6-6 6M8 12h12"/></>,
    key: <><circle cx="8" cy="9" r="5"/><path d="m12 13 9 9m-3-3 3-3m-6 0 3-3"/></>,
    alert: <><circle cx="12" cy="12" r="10"/><path d="M12 6v7m0 4h.01"/></>,
    menu: <path d="M3 6h18M3 12h18M3 18h18"/>,
  };
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function DashboardState({ title, children, action, busy = false }: { title: string; children?: React.ReactNode; action?: React.ReactNode; busy?: boolean }) {
  return <section className="dashboard-state" role={busy ? "status" : undefined} aria-busy={busy || undefined}><span className={busy ? "dashboard-loader" : "dashboard-state-symbol"} aria-hidden="true">{busy ? "" : <DashboardGlyph name="workspace"/>}</span><h1>{title}</h1>{children && <p>{children}</p>}{action}</section>;
}
export function DashboardPanel({ title, subtitle, actions, children, className = "" }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`dashboard-panel ${className}`}><header className="dashboard-panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{actions}</header>{children}</section>;
}
export function StatusChip({ row }: { row: Pick<DeliveryRecord, "status" | "nextAttemptAt"> }) {
  return <span className={`dashboard-chip dashboard-status-${row.status.toLowerCase()}`}><i aria-hidden="true"/>{deliveryLabel(row)}</span>;
}
export function DeferredLink({ children, className = "", label }: { children: React.ReactNode; className?: string; label?: string }) {
  return <span className={`dashboard-deferred ${className}`} role="link" aria-disabled="true" aria-label={label} title="Not available yet">{children}</span>;
}
