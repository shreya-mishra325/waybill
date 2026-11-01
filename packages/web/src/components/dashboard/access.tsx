"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Icon } from "../icon";
import { readWorkspacePreference, selectedWorkspace } from "../../lib/dashboard-format";
import { useDashboard } from "./provider";
import { DashboardArtwork } from "./artwork";
import { WorkspaceArtwork } from "./workspace-artwork";
import { useWorkspaceCounts } from "./workspace-counts";
import { formatCount } from "../../lib/dashboard-format";
import { DashboardBrand, DashboardGlyph, DashboardState } from "./ui";

export function SignInGate() {
  const { signIn } = useDashboard();
  return <div className="dashboard-access"><DashboardArtwork full/><section className="dashboard-signin-card"><DashboardBrand/><h1>Welcome back.</h1><p>Sign in to your workspace to manage<br/> webhook deliveries.</p><button className="dashboard-github-button" type="button" onClick={signIn}><Icon name="github"/>Continue with GitHub</button><p className="dashboard-signin-note">You’ll be redirected to GitHub to authenticate.<br/>We only use your public profile to sign you in.</p><div className="dashboard-divider"><span>or</span></div><button className="dashboard-email-button" type="button" disabled><svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="m3 6 9 7 9-7" stroke="currentColor" strokeWidth="1.5"/></svg>Continue with email<span>Coming soon</span></button><Link className="dashboard-back-link" href="/">Back to the public website</Link></section></div>;
}
export function WorkspaceSelection() {
  const { state, choose } = useDashboard();
  const counts = useWorkspaceCounts();
  useEffect(() => {
    if (state.status !== "ready") return;
    const previous = selectedWorkspace(state.session, readWorkspacePreference()); if (previous) choose(previous.id);
  }, [state]);
  if (state.status !== "ready") return null;
  if (!state.session.tenants.length) return <DashboardState title="No workspaces yet">Your GitHub account has no workspace access. Ask your workspace administrator to add you.</DashboardState>;
  return <section className="dashboard-workspace-page"><WorkspaceArtwork/><header><h1>Choose a workspace</h1><p>Select the workspace you want to access.</p></header><div className="dashboard-workspace-list">{state.session.tenants.map(tenant => { const count = counts[tenant.id]; return <button type="button" key={tenant.id} onClick={() => choose(tenant.id)}><span className="dashboard-workspace-icon"><DashboardGlyph name="workspace"/></span><span className="dashboard-workspace-name"><strong>{tenant.name}</strong><small>{tenant.id}</small></span><span className="dashboard-workspace-count" aria-live="polite">{count?.status === "ready" ? `${formatCount(count.total)} ${count.total === 1 ? "delivery" : "deliveries"}` : count?.status === "unavailable" ? "Count unavailable" : "Loading deliveries…"}</span><DashboardGlyph name="chevron"/></button>; })}</div><p className="dashboard-workspace-help">Don’t see a workspace you expected?<br/>Contact your workspace administrator.</p></section>;
}
