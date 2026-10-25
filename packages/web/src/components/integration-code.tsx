"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { INTEGRATION_EXAMPLES, type IntegrationLanguage } from "../lib/integration-examples";
import { Icon } from "./icon";

type CopyState = "idle" | "copying" | "copied" | "failed";

function CodeContent({ code }: { code: string }) {
  const tokens = code.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|await|if|throw|new|import|from|with|as|print)\b)/g);
  return tokens.map((token, index) => index % 2 === 0 ? token : <span className={token.startsWith('"') || token.startsWith("'") ? "integration-string" : "integration-keyword"} key={index}>{token}</span>);
}

export function IntegrationCode() {
  const [active, setActive] = useState<IntegrationLanguage>("curl");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const controls = useRef<(HTMLButtonElement | null)[]>([]);
  const manualCopy = useRef<HTMLTextAreaElement>(null);
  const copyRequest = useRef(0);
  const example = INTEGRATION_EXAMPLES.find(item => item.id === active)!;
  useEffect(() => () => { copyRequest.current += 1; }, []);
  function select(language: IntegrationLanguage) {
    copyRequest.current += 1;
    setActive(language);
    setCopyState("idle");
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowRight": next = (index + 1) % INTEGRATION_EXAMPLES.length; break;
      case "ArrowLeft": next = (index + INTEGRATION_EXAMPLES.length - 1) % INTEGRATION_EXAMPLES.length; break;
      case "Home": next = 0; break;
      case "End": next = INTEGRATION_EXAMPLES.length - 1; break;
      default: return;
    }
    event.preventDefault();
    select(INTEGRATION_EXAMPLES[next]!.id);
    controls.current[next]?.focus();
  }
  async function copy() {
    const request = ++copyRequest.current;
    setCopyState("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(example.code);
      if (request === copyRequest.current) setCopyState("copied");
    } catch {
      if (request === copyRequest.current) setCopyState("failed");
    }
  }
  useEffect(() => {
    if (copyState !== "failed") return;
    manualCopy.current?.focus();
    manualCopy.current?.select();
  }, [copyState]);
  return <figure className="integration-example">
    <div className="integration-editor">
      <div className="integration-toolbar">
        <div className="integration-tabs" role="tablist" aria-label="Code example language">{INTEGRATION_EXAMPLES.map((item, index) => <button type="button" key={item.id} role="tab" id={`integration-tab-${item.id}`} aria-selected={active === item.id} aria-controls={`integration-panel-${item.id}`} tabIndex={active === item.id ? 0 : -1} ref={element => { controls.current[index] = element; }} onClick={() => select(item.id)} onKeyDown={event => navigate(event, index)}>{item.label}</button>)}</div>
        <button type="button" className="integration-copy" disabled={copyState === "copying"} onClick={copy} aria-label={`Copy ${example.label} example`}><Icon name={copyState === "copied" ? "check" : "copy"}/><span>{copyState === "copying" ? "Copying" : copyState === "copied" ? "Copied" : "Copy"}</span></button>
      </div>
      {INTEGRATION_EXAMPLES.map(item => <div className="integration-panel" key={item.id} role="tabpanel" id={`integration-panel-${item.id}`} aria-labelledby={`integration-tab-${item.id}`} hidden={active !== item.id}>
        <div className="integration-fileline"><span>{item.filename}</span><span className="integration-endpoint"><b>POST</b> /events</span></div>
        <pre tabIndex={0} aria-label={`${item.label} request example. Scroll to read the full code.`}><code className={`language-${item.language}`}><CodeContent code={item.code}/></code></pre>
      </div>)}
      <div className="integration-editor-note"><span className="integration-note-dot" aria-hidden="true"/>201 Created confirms persistence, before delivery.</div>
    </div>
    <figcaption>Replace <code>REPLACE_WITH_TENANT_UUID</code> with an existing tenant ID. Webhooks go to the worker’s configured RECEIVER_URL.<span className="integration-scroll-hint"> Swipe or scroll within the code to read long lines.</span></figcaption>
    <p className="integration-copy-status" role="status" aria-live="polite">{copyState === "copied" ? `${example.label} example copied.` : copyState === "failed" ? "Clipboard access is unavailable. The example below is selected for manual copying." : ""}</p>
    <div className="integration-manual-copy" hidden={copyState !== "failed"}><label htmlFor="integration-manual-code">Copy the {example.label} example manually</label><textarea id="integration-manual-code" ref={manualCopy} readOnly value={example.code} rows={5}/></div>
  </figure>;
}
