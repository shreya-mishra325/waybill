"use client";

import { useEffect, useState } from "react";
import { DashboardApiError, readDeliverySummary, requestDashboardApi } from "../../lib/dashboard-api";
import { useDashboard } from "./provider";

type WorkspaceCount = { status: "ready"; total: number } | { status: "unavailable" };
export function useWorkspaceCounts() {
  const { state, apiOrigin, invalidate } = useDashboard();
  const owner = state.status === "ready" ? state.session.user.id : "";
  const tenantIds = state.status === "ready" ? state.session.tenants.map(tenant => tenant.id).join("|") : "";
  const scope = owner + ":" + tenantIds;
  const [counts, setCounts] = useState<{ scope: string; values: Record<string, WorkspaceCount> }>({ scope: "", values: {} });
  useEffect(() => {
    if (!owner || !tenantIds) return;
    const controller = new AbortController();
    const ids = tenantIds.split("|"); let next = 0;
    setCounts({ scope, values: {} });
    async function worker() {
      while (next < ids.length && !controller.signal.aborted) {
        const id = ids[next++]!;
        let result: WorkspaceCount;
        try {
          const summary = readDeliverySummary(await requestDashboardApi(apiOrigin, `/tenants/${encodeURIComponent(id)}/deliveries/summary`, { signal: controller.signal }));
          result = { status: "ready", total: summary.total };
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof DashboardApiError && error.status === 401) { controller.abort(); invalidate(); return; }
          result = { status: "unavailable" };
        }
        if (!controller.signal.aborted) setCounts(current => current.scope === scope ? { scope, values: { ...current.values, [id]: result } } : current);
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
    return () => controller.abort();
  }, [apiOrigin, owner, tenantIds, scope, invalidate]);
  return counts.scope === scope ? counts.values : {};
}
