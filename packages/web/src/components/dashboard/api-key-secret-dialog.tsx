"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { IssuedApiKey } from "../../lib/api-keys";
import { formatTimestamp } from "../../lib/dashboard-format";
import { Icon } from "../icon";

export function ApiKeySecretDialog({ issued, onDismiss }: { issued: IssuedApiKey; onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const input = useRef<HTMLInputElement>(null); const copyButton = useRef<HTMLButtonElement>(null);
  const dismissed = useRef(false); const generation = useRef(0); const id = useId();
  const [copy, setCopy] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  useEffect(() => {
    dismissed.current = false; const node = dialog.current; node?.showModal(); copyButton.current?.focus();
    const leavePage = () => { generation.current++; if (input.current) input.current.value = ""; dismiss(); if (node?.open) node.close(); };
    window.addEventListener("pagehide", leavePage);
    return () => { window.removeEventListener("pagehide", leavePage); dismissed.current = true; generation.current++; if (node?.open) node.close(); };
  }, []);
  function dismiss() { if (!dismissed.current) { dismissed.current = true; onDismiss(); } }
  async function copySecret() {
    const current = ++generation.current; setCopy("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(issued.token);
      if (current === generation.current) setCopy("copied");
    } catch {
      if (current === generation.current) { setCopy("failed"); input.current?.focus(); input.current?.select(); }
    }
  }
  const expiry = formatTimestamp(issued.key.expiresAt);
  return <dialog className="api-key-dialog api-key-secret-dialog" ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); dismiss(); }} onClose={event => { if (!event.currentTarget.open) dismiss(); }}>
    <h2 id={`${id}-title`}>API key created</h2><p id={`${id}-description`}>Copy the secret for <strong>{issued.key.name}</strong> now. It is shown only in this confirmation and cannot be retrieved later.</p>
    <label htmlFor={`${id}-secret`}>New API key secret</label><input ref={input} id={`${id}-secret`} data-api-key-secret="true" value={issued.token} readOnly autoComplete="off" autoCapitalize="none" spellCheck={false} onFocus={event => event.currentTarget.select()}/>
    <p className="api-key-dialog-metadata">Scope: <code>{issued.key.scope}</code><span>Expires {expiry.day}, {expiry.time}</span></p>
    <p role="status" className="api-key-copy-status">{copy === "copied" ? "Secret copied. Store it securely before closing." : copy === "failed" ? "Clipboard access is unavailable. The secret is selected for manual copying." : ""}</p>
    <div className="api-key-dialog-actions"><button ref={copyButton} type="button" className="dashboard-button" disabled={copy === "copying"} onClick={() => void copySecret()}><Icon name={copy === "copied" ? "check" : "copy"}/>{copy === "copied" ? "Copied" : copy === "copying" ? "Copying" : "Copy secret"}</button><button className="api-key-primary" type="button" onClick={dismiss}>Done</button></div>
  </dialog>;
}
