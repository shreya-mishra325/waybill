"use client";

import { useEffect, useId, useRef, useState } from "react";
import { canRequestReplay, deadLetterError, submitDeadLetterReplay, type DeadLetterRecord, type ReplayReceipt } from "../../lib/dead-letters";
import { useDashboard } from "./provider";

type ReplayState = { status: "idle" | "pending" } | { status: "success"; receipt: ReplayReceipt } | { status: "error"; message: string; blocked: boolean };
export function DeadLetterReplay({ row, payloadReady, revision, onBusy, onReplay }: { row: DeadLetterRecord; payloadReady: boolean; revision: number; onBusy: (busy: boolean) => void; onReplay: (receipt: ReplayReceipt) => void }) {
  const { apiOrigin, state, invalidate, reload } = useDashboard();
  const [result, setResult] = useState<ReplayState>({ status: "idle" }); const [confirming, setConfirming] = useState(false);
  const success = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null); const trigger = useRef<HTMLButtonElement>(null); const cancel = useRef<HTMLButtonElement>(null);
  const id = useId(); const pending = useRef(false); const key = useRef<string | null>(null); const active = useRef<AbortController | null>(null); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  useEffect(() => { if (!pending.current) setResult(value => value.status === "error" ? { status: "idle" } : value); }, [revision]);
  useEffect(() => {
    if (confirming && !dialog.current?.open) { dialog.current?.showModal(); cancel.current?.focus(); }
    else if (!confirming && dialog.current?.open) { dialog.current.close(); trigger.current?.focus(); }
  }, [confirming]);
  useEffect(() => { if (result.status === "success" && !confirming) success.current?.focus(); }, [result.status, confirming]);
  const eligibleToRequest = canRequestReplay(row, payloadReady) && result.status !== "success" && !(result.status === "error" && result.blocked);
  async function confirmReplay() {
    if (pending.current || !eligibleToRequest || state.status !== "ready") return;
    pending.current = true; onBusy(true); setResult({ status: "pending" });
    const controller = new AbortController(); active.current = controller;
    try {
      key.current ??= crypto.randomUUID();
      const receipt = await submitDeadLetterReplay(apiOrigin, row, state.session.csrfToken, key.current, controller.signal);
      if (!alive.current) return;
      setResult({ status: "success", receipt }); setConfirming(false); onReplay(receipt);
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      const failure = deadLetterError(error, "replay");
      if (failure.status === 401) invalidate();
      else {
        setResult({ status: "error", message: failure.status === 0 || failure.status === 502 ? `${failure.message} The replay outcome is unconfirmed; retrying uses the same request ID.` : failure.message, blocked: [404, 409, 410].includes(failure.status) });
        setConfirming(false);
        if (failure.status === 403) void reload();
      }
    } finally { pending.current = false; if (alive.current) onBusy(false); }
  }
  return <div className="dead-replay">
    {result.status === "success" && <div className="dead-replay-success" role="status" ref={success} tabIndex={-1}><strong>Replay requested</strong><span>New event: {result.receipt.eventId}</span><small>Delivery has not been confirmed.</small></div>}
    {result.status === "error" && <p className="dead-inline-error" role="alert">{result.message}</p>}
    <div className="dead-replay-action"><p>Requests one new delivery from the archived payload.<span>The server validates eligibility before accepting.</span></p>{eligibleToRequest || result.status === "pending" ? <button ref={trigger} className="dead-replay-button" type="button" disabled={result.status === "pending"} onClick={() => setConfirming(true)}><span aria-hidden="true">▶</span>{result.status === "pending" ? "Requesting replay…" : "Replay this payload"}</button> : <span className="dead-replay-unavailable">{row.replay || result.status === "success" ? "Replay already requested" : !payloadReady ? "Replay unavailable until the archive can be read" : "Refresh to check replay availability"}</span>}</div>
    <dialog className="dead-replay-dialog" ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { if (pending.current) event.preventDefault(); else setConfirming(false); }} onClose={() => { if (!pending.current) setConfirming(false); }}>
      <form onSubmit={event => { event.preventDefault(); void confirmReplay(); }}><h2 id={`${id}-title`}>Replay this payload?</h2><p id={`${id}-description`}>Request a new delivery for <strong>{row.event.type}</strong> using the unchanged archived payload. The backend checks the source, archive, and configured destination before accepting.</p><p className="dead-confirm-destination">{row.targetUrl}</p><div><button ref={cancel} className="dashboard-button" type="button" disabled={result.status === "pending"} onClick={() => setConfirming(false)}>Cancel</button><button className="dead-replay-button" type="submit" disabled={result.status === "pending"}>{result.status === "pending" ? "Requesting replay…" : "Confirm replay"}</button></div><p role="status">{result.status === "pending" ? "Waiting for the backend to confirm the replay request…" : ""}</p></form>
    </dialog>
  </div>;
}
