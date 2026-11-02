"use client";

import { useEffect, useId, useRef, useState } from "react";
import { deliveryRecordJson, jsonLineTokens } from "../../lib/delivery-details";
import type { DeliveryRecord } from "../../lib/dashboard-types";
import { Icon } from "../icon";

export function DeliveryRecordViewer({ record }: { record: DeliveryRecord }) {
  const json = deliveryRecordJson(record);
  const lines = json.split("\n");
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const manual = useRef<HTMLTextAreaElement>(null);
  const request = useRef(0);
  const id = useId();
  useEffect(() => { request.current++; setStatus("idle"); return () => { request.current++; }; }, [json]);
  useEffect(() => { if (status === "failed") { manual.current?.focus(); manual.current?.select(); } }, [status]);
  async function copy() {
    const current = ++request.current;
    setStatus("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(json);
      if (current === request.current) setStatus("copied");
    } catch { if (current === request.current) setStatus("failed"); }
  }
  return <section className="details-record dashboard-panel" aria-labelledby={`${id}-heading`}>
    <header><h2 id={`${id}-heading`}>Delivery record</h2><div><span className="details-record-badge">JSON · read-only</span><button className="dashboard-button" type="button" aria-label="Copy delivery record JSON" disabled={status === "copying"} onClick={() => void copy()}><Icon name={status === "copied" ? "check" : "copy"}/>{status === "copied" ? "Copied" : status === "copying" ? "Copying" : "Copy"}</button></div></header>
    <pre tabIndex={0} aria-label="Delivery record JSON. Scroll horizontally to read long lines."><code>{lines.map((line, index) => <span className="details-code-line" key={index}><span className="details-line-number" aria-hidden="true">{index + 1}</span><span>{jsonLineTokens(line).map((token, tokenIndex) => <span key={tokenIndex} className={`details-json-${token.kind}`}>{token.text}</span>)}</span>{index < lines.length - 1 ? "\n" : ""}</span>)}</code></pre>
    <p className="dashboard-sr-only" role="status">{status === "copied" ? "Delivery record copied." : status === "failed" ? "Clipboard unavailable. Use the selected JSON below to copy manually." : ""}</p>
    {status === "failed" && <div className="details-manual-copy"><label htmlFor={`${id}-manual`}>Copy delivery record manually</label><textarea ref={manual} id={`${id}-manual`} value={json} readOnly rows={5}/></div>}
  </section>;
}
