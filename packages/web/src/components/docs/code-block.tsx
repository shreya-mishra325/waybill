"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../icon";

export function DocsCode({ code, label = "Terminal" }: { code: string; label?: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const request = useRef(0);
  const manual = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEffect(() => { request.current += 1; setStatus("idle"); return () => { request.current += 1; }; }, [code]);
  useEffect(() => { if (status === "failed") { manual.current?.focus(); manual.current?.select(); } }, [status]);
  async function copy() {
    const current = ++request.current;
    setStatus("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(code);
      if (current === request.current) setStatus("copied");
    } catch {
      if (current === request.current) setStatus("failed");
    }
  }
  return <div className="docs-code-block">
    <div className="docs-code-toolbar"><span>{label}</span><button type="button" onClick={copy} disabled={status === "copying"} aria-label={`Copy ${label}`}><Icon name={status === "copied" ? "check" : "copy"}/>{status === "copied" ? "Copied" : status === "copying" ? "Copying" : "Copy"}</button></div>
    <pre tabIndex={0} aria-label={`${label}. Scroll to read the full code.`}><code>{code}</code></pre>
    <span className="sr-only" role="status">{status === "copied" ? `${label} copied.` : status === "failed" ? "Clipboard unavailable. The text below is selected for manual copying." : ""}</span>
    {status === "failed" && <div className="docs-manual-copy"><label htmlFor={id}>Copy {label} manually</label><textarea id={id} ref={manual} value={code} readOnly rows={4}/></div>}
  </div>;
}
