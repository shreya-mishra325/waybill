"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { selectedWorkspace } from "../../lib/dashboard-format";
import { useDashboard } from "./provider";
import { DashboardBrand, DashboardGlyph, DashboardState, DeferredLink } from "./ui";
import { ProfileMenu, WorkspaceMenu } from "./menus";
import { SignInGate } from "./access";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const { state, reload, logoutError, switchWorkspace } = useDashboard(); const params = useParams<{ tenantId?: string }>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const workspace = state.status === "ready" ? selectedWorkspace(state.session, params.tenantId) : null;
  return <div className={state.status === "signed-out" ? "dashboard-root dashboard-root-signin" : "dashboard-root"}><div className="dashboard-frame"><a href="#dashboard-main" className="dashboard-skip">Skip to content</a><header className="dashboard-navbar"><DashboardBrand/>
    {workspace && <><button className="dashboard-navigation-toggle" type="button" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} aria-controls="dashboard-navigation" onClick={() => setMobileOpen(value => !value)}><DashboardGlyph name="menu"/></button><nav id="dashboard-navigation" className={mobileOpen ? "dashboard-navigation is-open" : "dashboard-navigation"} aria-label="Workspace navigation"><Link href={`/app/${workspace.id}`} aria-current="page" onClick={() => setMobileOpen(false)}>Overview</Link><DeferredLink>Deliveries</DeferredLink><DeferredLink>Dead letters</DeferredLink><DeferredLink>Observability</DeferredLink></nav></>}
    <div className="dashboard-navbar-tools">{workspace && <WorkspaceMenu workspace={workspace}/>}<ProfileMenu key={(state.status === "ready" ? state.session.user.id : "") + (workspace?.id ?? "selection")} workspace={workspace}/>{state.status === "signed-out" && <nav className="dashboard-public-links" aria-label="Public navigation"><Link href="/#product">Product</Link><Link href="/#features">Features</Link><Link href="/docs">Docs</Link></nav>}</div>
  </header>{logoutError && <p className="dashboard-global-error" role="alert">{logoutError}</p>}<main id="dashboard-main" className="dashboard-main" tabIndex={-1}>
    {state.status === "loading" ? <DashboardState title="Loading your workspace…" busy/> : state.status === "error" ? <DashboardState title="Unable to load your session" action={<button className="dashboard-button" type="button" onClick={() => void reload()}>Try again</button>}>{state.error}</DashboardState> : state.status === "signed-out" ? <SignInGate/> : params.tenantId && !workspace ? <DashboardState title="Workspace unavailable" action={<button className="dashboard-button" type="button" onClick={switchWorkspace}>Choose a workspace</button>}>This workspace is not available to your account.</DashboardState> : <div key={(state.status === "ready" ? state.session.user.id : "") + (workspace?.id ?? "choose")}>{children}</div>}
  </main></div></div>;
}
