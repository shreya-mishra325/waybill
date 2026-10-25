"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { DATA_FLOW, DELIVERY_GUARANTEES } from "../lib/architecture";
import { ArchitectureDiagram } from "./architecture-diagram";

const tabs = [
  { id: "architecture", label: "Architecture" },
  { id: "data-flow", label: "Data flow" },
  { id: "guarantees", label: "Guarantees" },
] as const;
type TabId = typeof tabs[number]["id"];

export function HowItWorks() {
  const [active, setActive] = useState<TabId>("architecture");
  const controls = useRef<(HTMLButtonElement | null)[]>([]);
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowRight": next = (index + 1) % tabs.length; break;
      case "ArrowLeft": next = (index + tabs.length - 1) % tabs.length; break;
      case "Home": next = 0; break;
      case "End": next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    setActive(tabs[next]!.id);
    controls.current[next]?.focus();
  }
  return <section className="how-section" id="how-it-works" aria-labelledby="how-title" tabIndex={-1}>
    <div className="site-container how-layout">
      <div className="how-copy">
        <p className="how-eyebrow">How it works<span aria-hidden="true"/></p>
        <h2 id="how-title">A reliable path<br/> for every event.</h2>
        <p className="how-description">From the first database write to delivery or recovery, follow the components that carry each event.</p>
      </div>
      <div className="architecture-explorer">
        <div className="architecture-tabs" role="tablist" aria-label="Explore how Waybill works">
          {tabs.map((tab, index) => <button type="button" key={tab.id} id={`how-tab-${tab.id}`} role="tab" aria-selected={active === tab.id} aria-controls={`how-panel-${tab.id}`} tabIndex={active === tab.id ? 0 : -1} ref={element => { controls.current[index] = element; }} onClick={() => setActive(tab.id)} onKeyDown={event => navigate(event, index)}>{tab.label}</button>)}
        </div>
        <div className="architecture-panel" id="how-panel-architecture" role="tabpanel" aria-labelledby="how-tab-architecture" hidden={active !== "architecture"} tabIndex={0}>
          <ArchitectureDiagram/>
        </div>
        <div className="architecture-panel" id="how-panel-data-flow" role="tabpanel" aria-labelledby="how-tab-data-flow" hidden={active !== "data-flow"} tabIndex={0}>
          <ol className="architecture-flow">{DATA_FLOW.map((step, index) => <li key={step.title}><span className="architecture-step-number" aria-hidden="true">0{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>)}</ol>
        </div>
        <div className="architecture-panel" id="how-panel-guarantees" role="tabpanel" aria-labelledby="how-tab-guarantees" hidden={active !== "guarantees"} tabIndex={0}>
          <ul className="architecture-guarantees">{DELIVERY_GUARANTEES.map(item => <li key={item.title}><h3>{item.title}</h3><p>{item.text}</p></li>)}</ul>
          <p className="architecture-contract">Delivery semantics: at-least-once, with bounded retries. Receivers must tolerate duplicates.</p>
        </div>
      </div>
    </div>
  </section>;
}
