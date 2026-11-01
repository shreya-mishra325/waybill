"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../icon";
import { useDashboard } from "./provider";
import { DashboardGlyph } from "./ui";
import type { Workspace } from "../../lib/dashboard-types";

function Menu({ label, trigger, children, className = "" }: { label: string; trigger: React.ReactNode; children: (close: () => void) => React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false); const root = useRef<HTMLDivElement>(null); const button = useRef<HTMLButtonElement>(null); const id = useId();
  useEffect(() => {
    if (!open) return;
    const first = root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'); first?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div ref={root} className={`dashboard-menu ${className}`} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); button.current?.focus(); }
    if (event.key === "Tab" && open) { setOpen(false); button.current?.focus(); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); if (!open) { setOpen(true); return; }
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[index]?.focus();
    }
  }}>
    <button ref={button} className="dashboard-menu-trigger" type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{trigger}</button>
    {open && <div className="dashboard-menu-popover" id={id} role="menu" aria-label={label}>{children(() => { setOpen(false); button.current?.focus(); })}</div>}
  </div>;
}
export function WorkspaceMenu({ workspace }: { workspace: Workspace }) {
  const { state, choose } = useDashboard();
  if (state.status !== "ready") return null;
  return <Menu className="dashboard-workspace-menu" label={`Switch workspace, current workspace ${workspace.name}`} trigger={<><span>{workspace.name}</span><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5"/></svg></>}>
    {close => <><p className="dashboard-menu-label">Workspaces</p>{state.session.tenants.map(tenant => <button role="menuitem" type="button" key={tenant.id} onClick={() => { close(); choose(tenant.id); }}><DashboardGlyph name="workspace"/><span>{tenant.name}</span>{tenant.id === workspace.id && <Icon name="check"/>}</button>)}</>}
  </Menu>;
}
export function ProfileMenu({ workspace }: { workspace: Workspace | null }) {
  const { state, switchWorkspace, signOut, signingOut } = useDashboard();
  if (state.status !== "ready") return null;
  const login = state.session.user.githubLogin;
  return <Menu className="dashboard-profile-menu" label={`Account menu for ${login}`} trigger={<span className="dashboard-avatar" aria-hidden="true">{login.slice(0, 1).toUpperCase()}</span>}>
    {close => <><div className="dashboard-profile-identity"><Icon name="github"/><span>{login}</span></div>{workspace && <>
      <button role="menuitem" type="button" disabled title="Not available yet"><DashboardGlyph name="key"/>API Keys</button>
      <button role="menuitem" type="button" onClick={() => { close(); switchWorkspace(); }}><DashboardGlyph name="workspace"/>Switch workspace</button>
    </>}<button role="menuitem" className="dashboard-signout" type="button" disabled={signingOut} onClick={() => { close(); void signOut(); }}><DashboardGlyph name="logout"/>{signingOut ? "Signing out…" : "Sign out"}</button></>}
  </Menu>;
}
