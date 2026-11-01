"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardApiError, readDashboardSession, requestDashboardApi } from "../../lib/dashboard-api";
import { saveWorkspacePreference, oauthReturnKey } from "../../lib/dashboard-format";
import type { DashboardSession } from "../../lib/dashboard-types";

type AuthState = { status: "loading" | "signed-out" | "error"; session: null; error?: string } | { status: "ready"; session: DashboardSession; error?: undefined };
type AppAuth = { apiOrigin: string; state: AuthState; reload: () => Promise<void>; choose: (id: string) => void;
  switchWorkspace: () => void; invalidate: () => void; signIn: () => void; signOut: () => Promise<void>; signingOut: boolean; logoutError: string | null };
const Context = createContext<AppAuth | null>(null);
export function DashboardProvider({ apiOrigin, children }: { apiOrigin: string; children: React.ReactNode }) {
  const router = useRouter(); const [state, setState] = useState<AuthState>({ status: "loading", session: null });
  const [signingOut, setSigningOut] = useState(false); const [logoutError, setLogoutError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null); const generation = useRef(0); const loggingOut = useRef(false);
  const invalidate = useCallback(() => {
    generation.current++; active.current?.abort(); saveWorkspacePreference(null);
    setState({ status: "signed-out", session: null }); router.replace("/app");
  }, [router]);
  const reload = useCallback(async () => {
    if (loggingOut.current) return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const current = ++generation.current; setState(value => value.status === "ready" ? value : { status: "loading", session: null });
    try {
      const session = readDashboardSession(await requestDashboardApi(apiOrigin, "/auth/me", { signal: controller.signal }));
      if (current === generation.current) setState({ status: "ready", session });
    } catch (error) {
      if (controller.signal.aborted || current !== generation.current) return;
      if (error instanceof DashboardApiError && error.status === 401) { saveWorkspacePreference(null); setState({ status: "signed-out", session: null }); }
      else setState({ status: "error", session: null, error: error instanceof Error ? error.message : "Unable to load your session." });
    }
  }, [apiOrigin]);
  useEffect(() => {
    void reload(); const onFocus = () => { if (document.visibilityState === "visible") void reload(); };
    window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onFocus);
    return () => { generation.current++; active.current?.abort(); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [reload]);
  function choose(id: string) {
    if (state.status !== "ready" || !state.session.tenants.some(tenant => tenant.id === id)) return;
    saveWorkspacePreference(id); router.push(`/app/${encodeURIComponent(id)}`);
  }
  function switchWorkspace() { saveWorkspacePreference(null); router.push("/app"); }
  function signIn() {
    try { sessionStorage.setItem(oauthReturnKey, String(Date.now() + 600000)); } catch { setLogoutError("Your browser could not save the return location. You can reopen /app after signing in."); }
    window.location.assign(apiOrigin + "/auth/github");
  }
  async function signOut() {
    if (loggingOut.current) return;
    loggingOut.current = true; generation.current++; active.current?.abort(); setSigningOut(true); setLogoutError(null);
    try {
      const current = readDashboardSession(await requestDashboardApi(apiOrigin, "/auth/me"));
      await requestDashboardApi(apiOrigin, "/auth/logout", { method: "POST", csrfToken: current.csrfToken });
      invalidate();
    } catch (error) {
      if (error instanceof DashboardApiError && error.status === 401) invalidate();
      else setLogoutError(error instanceof Error ? error.message : "Sign out could not be completed. Please try again.");
    } finally { loggingOut.current = false; setSigningOut(false); }
  }
  return <Context.Provider value={{ apiOrigin, state, reload, choose, switchWorkspace, invalidate, signIn, signOut, signingOut, logoutError }}>{children}</Context.Provider>;
}
export function useDashboard() { const value = useContext(Context); if (!value) throw new Error("Dashboard context is required"); return value; }
