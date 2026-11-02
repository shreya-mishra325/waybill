"use client";

import { useEffect, useId, useRef, useState } from "react";
import { jsonLineTokens } from "../../lib/delivery-details";
import { Icon } from "../icon";

export function ArchivedPayloadViewer({ json }: { json: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const request = useRef(0); const manual = useRef<HTMLTextAreaElement>(null); const id = useId();
  const lines = json.split("\n"); const highlight = json.length <= 160000 && lines.length <= 1500;
  useEffect(() => { request.current++; setStatus("idle"); return () => { request.current++; }; }, [json]);
  useEffect(() => { if (status === "failed") { manual.current?.focus(); manual.current?.select(); } }, [status]);
  async function copy() {
    const current = ++request.current; setStatus("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(json);
      if (current === request.current) setStatus("copied");
    } catch { if (current === request.current) setStatus("failed"); }
  }
  return <div className="dead-payload-viewer"><div className="dead-payload-heading"><div><h3>Archived payload</h3><p>Read from the archived payload API.</p></div><div><span className="dead-json-label">JSON</span><button className="dashboard-button" type="button" disabled={status === "copying"} aria-label="Copy archived payload JSON" onClick={() => void copy()}><Icon name={status === "copied" ? "check" : "copy"}/>{status === "copied" ? "Copied" : status === "copying" ? "Copying" : "Copy"}</button></div></div>
    <pre tabIndex={0} aria-label="Archived payload JSON. Scroll within the viewer to read all content."><code>{highlight ? lines.map((line, index) => <span className="dead-json-line" key={index}><span className="dead-json-number" aria-hidden="true">{index + 1}</span><span>{jsonLineTokens(line).map((token, tokenIndex) => <span className={`dead-json-${token.kind}`} key={tokenIndex}>{token.text}</span>)}</span>{index < lines.length - 1 ? "\n" : ""}</span>) : json}</code></pre>
    {!highlight && <p className="dead-payload-large">Highlighting is disabled for this large archive. The complete JSON remains available to read and copy.</p>}
    <p className="dashboard-sr-only" role="status">{status === "copied" ? "Archived payload copied." : status === "failed" ? "Clipboard unavailable. The JSON below is selected for manual copying." : ""}</p>
    {status === "failed" && <div className="dead-manual-copy"><label htmlFor={id}>Copy archived payload manually</label><textarea ref={manual} id={id} value={json} readOnly rows={5}/></div>}
  </div>;
}
