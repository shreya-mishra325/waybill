"use client";

import { useEffect, useId, useRef, useState } from "react";
import { apiKeyError, apiKeyStatus, revokeApiKey, type ApiKeyRecord } from "../../lib/api-keys";
import { useDashboard } from "./provider";

export function ApiKeyRevokeDialog({ row, onDismiss, onRevoked }: { row: ApiKeyRecord; onDismiss: () => void; onRevoked: (key: ApiKeyRecord) => void }) {
  const { apiOrigin, state, invalidate, reload } = useDashboard();
  const dialog = useRef<HTMLDialogElement>(null); const cancel = useRef<HTMLButtonElement>(null); const active = useRef<AbortController | null>(null);
  const busy = useRef(false); const alive = useRef(true); const id = useId();
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => { alive.current = true; const node = dialog.current; node?.showModal(); cancel.current?.focus(); return () => { alive.current = false; active.current?.abort(); if (node?.open) node.close(); }; }, []);
  function dismiss() { if (!busy.current && alive.current) onDismiss(); }
  async function submit() {
    if (busy.current || state.status !== "ready") return;
    if (apiKeyStatus(row) !== "Active") { setError("This key is no longer active. Refresh the list to check its status."); return; }
    busy.current = true; setPending(true); setError(null); const controller = new AbortController(); active.current = controller;
    try {
      const revoked = await revokeApiKey(apiOrigin, row, state.session.csrfToken, controller.signal);
      if (alive.current) onRevoked(revoked);
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      const failure = apiKeyError(error, "revoke");
      if (failure.status === 401) invalidate();
      else { setError(failure.status === 0 || failure.status === 502 ? "Revocation could not be confirmed. Refresh the list or retry this request." : failure.message); if (failure.status === 403) void reload(); }
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  return <dialog className="api-key-dialog api-key-revoke-dialog" ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); dismiss(); }} onClose={event => { if (!event.currentTarget.open) dismiss(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}><h2 id={`${id}-title`}>Revoke this API key?</h2><p id={`${id}-description`}>New event-ingestion requests using <strong>{row.name}</strong> will be rejected. Already accepted deliveries are unaffected.</p><p className="api-key-dialog-id">{row.id}</p>{error && <p className="api-key-operation-error" role="alert">{error}</p>}<div className="api-key-dialog-actions"><button ref={cancel} className="dashboard-button" type="button" disabled={pending} onClick={dismiss}>Cancel</button><button className="api-key-primary" type="submit" disabled={pending || apiKeyStatus(row) !== "Active"}>{pending ? "Revoking…" : "Revoke key"}</button></div><p className="api-key-dialog-status" role="status">{pending ? "Waiting for the backend to confirm revocation…" : ""}</p></form>
  </dialog>;
}
