"use client";

import { useEffect, useId, useRef, useState } from "react";
import { apiKeyError, createApiKey, validateApiKeyInput, type ApiKeyRecord, type IssuedApiKey } from "../../lib/api-keys";
import { useDashboard } from "./provider";
import { DashboardGlyph } from "./ui";
import { ApiKeySecretDialog } from "./api-key-secret-dialog";

type FormErrors = { name?: string; expiresInDays?: string };
export function ApiKeyCreate({ tenantId, onCreated, onRefresh }: { tenantId: string; onCreated: (key: ApiKeyRecord) => void; onRefresh: () => void }) {
  const { apiOrigin, state, invalidate, reload } = useDashboard();
  const [name, setName] = useState(""); const [choice, setChoice] = useState("90"); const [customDays, setCustomDays] = useState("90");
  const [errors, setErrors] = useState<FormErrors>({}); const [error, setError] = useState<string | null>(null); const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null); const [notice, setNotice] = useState("");
  const busy = useRef(false); const revealOpen = useRef(false); const alive = useRef(true); const active = useRef<AbortController | null>(null);
  const createButton = useRef<HTMLButtonElement>(null); const nameInput = useRef<HTMLInputElement>(null); const expiryInput = useRef<HTMLInputElement>(null); const id = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  useEffect(() => { if (!issued && notice) createButton.current?.focus(); }, [issued, notice]);
  async function submit() {
    if (busy.current || revealOpen.current || state.status !== "ready") return;
    const validated = validateApiKeyInput(name, choice === "custom" ? customDays : choice); setErrors(validated.errors); setError(null); setNotice("");
    if (!validated.valid) { if (validated.errors.name) nameInput.current?.focus(); else expiryInput.current?.focus(); return; }
    if (!state.session.tenants.some(tenant => tenant.id === tenantId)) return;
    busy.current = true; setPending(true); const controller = new AbortController(); active.current = controller;
    try {
      const created = await createApiKey(apiOrigin, tenantId, state.session.csrfToken, validated.input, controller.signal);
      if (!alive.current) return;
      revealOpen.current = true; setIssued(created); setName(""); setChoice("90"); setCustomDays("90"); onCreated(created.key);
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      const failure = apiKeyError(error, "create");
      if (failure.status === 401) invalidate();
      else { setError(failure.message); if ([0, 502, 503].includes(failure.status)) onRefresh(); if (failure.status === 403) void reload(); }
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  function dismissSecret() { revealOpen.current = false; setIssued(null); setNotice("Key created. Its secret is no longer displayed."); createButton.current?.focus(); }
  return <section className="api-key-create dashboard-panel" aria-labelledby={`${id}-heading`}><h2 id={`${id}-heading`}>Create a new API key</h2><p className="api-key-create-intro">Generate a credential for an application to send events to your workspace.</p>
    <form noValidate onSubmit={event => { event.preventDefault(); void submit(); }} aria-busy={pending}>
      <label htmlFor={`${id}-name`}>Key name</label><input id={`${id}-name`} ref={nameInput} value={name} maxLength={80} placeholder="e.g. orders-service" autoComplete="off" disabled={pending || issued !== null} aria-invalid={!!errors.name} aria-describedby={`${id}-name-hint${errors.name ? ` ${id}-name-error` : ""}`} onChange={event => { setName(event.target.value); setErrors(value => ({ ...value, name: undefined })); }}/><small id={`${id}-name-hint`}>1–80 characters</small>{errors.name && <p className="api-key-field-error" id={`${id}-name-error`} role="alert">{errors.name}</p>}
      <label htmlFor={`${id}-expiry`}>Expires in</label><select id={`${id}-expiry`} value={choice} disabled={pending || issued !== null} onChange={event => { setChoice(event.target.value); setErrors(value => ({ ...value, expiresInDays: undefined })); }} aria-describedby={`${id}-expiry-hint`}>{[1, 7, 30, 90, 180, 365].map(days => <option key={days} value={days}>{days} {days === 1 ? "day" : "days"}{days === 90 ? " (default)" : ""}</option>)}<option value="custom">Custom duration</option></select>
      {choice === "custom" && <><label className="api-key-custom-label" htmlFor={`${id}-custom`}>Expiration in days</label><input id={`${id}-custom`} ref={expiryInput} type="number" min={1} max={365} step={1} value={customDays} disabled={pending || issued !== null} aria-invalid={!!errors.expiresInDays} aria-describedby={`${id}-expiry-hint${errors.expiresInDays ? ` ${id}-expiry-error` : ""}`} onChange={event => { setCustomDays(event.target.value); setErrors(value => ({ ...value, expiresInDays: undefined })); }}/></>}
      <small id={`${id}-expiry-hint`}>Choose a duration from 1 to 365 days</small>{errors.expiresInDays && <p className="api-key-field-error" id={`${id}-expiry-error`} role="alert">{errors.expiresInDays}</p>}
      <div className="api-key-scope"><DashboardGlyph name="alert"/><span>Fixed permission for all keys: <code>events:write</code></span></div>
      {error && <p className="api-key-operation-error" role="alert">{error}</p>}<button ref={createButton} className="api-key-primary api-key-create-submit" type="submit" disabled={pending || issued !== null}>{pending ? "Creating API key…" : "Create API key"}</button><p className="api-key-operation-notice" role="status">{notice}</p>
    </form>
    <section className="api-key-security" aria-labelledby={`${id}-security`}><h3 id={`${id}-security`}>Keep your key secure</h3><div><DashboardGlyph name="key"/><p><strong>One-time secret reveal</strong>After a successful creation, Waybill displays the secret in a confirmation dialog. Copy it and store it securely. Existing secrets cannot be viewed again.</p></div><small>Key metadata remains visible here. The secret itself is never listed.</small></section>
    {issued && <ApiKeySecretDialog issued={issued} onDismiss={dismissSecret}/>}
  </section>;
}
