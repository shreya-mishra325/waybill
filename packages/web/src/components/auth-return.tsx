"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { oauthReturnKey } from "../lib/dashboard-format";
import { readDashboardSession, requestDashboardApi } from "../lib/dashboard-api";
import styles from "./auth-return.module.css";

function clearReturn() { try { sessionStorage.removeItem(oauthReturnKey); } catch { return false; } return true; }
export function AuthReturn({ apiOrigin }: { apiOrigin: string }) {
  const router = useRouter(); const [failed, setFailed] = useState(false);
  useEffect(() => {
    let expiresAt: number;
    try { expiresAt = Number(sessionStorage.getItem(oauthReturnKey)); } catch { return; }
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { clearReturn(); return; }
    const controller = new AbortController();
    requestDashboardApi(apiOrigin, "/auth/me", { signal: controller.signal }).then(readDashboardSession).then(() => {
      if (!controller.signal.aborted) { clearReturn(); router.replace("/app"); }
    }).catch(() => { if (!controller.signal.aborted) { clearReturn(); setFailed(true); } });
    return () => controller.abort();
  }, [apiOrigin, router]);
  return failed ? <aside className={styles.notice} role="alert"><p>We couldn’t finish opening your workspace.</p><Link href="/app">Open Waybill and try again</Link></aside> : null;
}
