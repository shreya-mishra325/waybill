"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DATA_FLOW } from "../lib/architecture";
import { Icon } from "./icon";

const route = "M100 50C180 10 220 90 300 50S420 90 500 50S620 90 700 50S820 90 900 50";

export function DataFlowDiagram() {
  const [selected, setSelected] = useState(0);
  const root = useRef<HTMLElement>(null);
  const drawing = useRef<SVGSVGElement>(null);
  const id = useId().replaceAll(":", "");
  const step = DATA_FLOW[selected]!;

  useEffect(() => {
    const figure = root.current;
    const svg = drawing.current;
    if (!figure || !svg) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const compact = matchMedia("(max-width: 700px)");
    const frozen = new URLSearchParams(location.search).get("motion") === "off";
    let visible = false;
    function sync() {
      const running = visible && !document.hidden && !reduced.matches && !compact.matches && !frozen;
      figure!.dataset.motion = running ? "running" : "paused";
      if (running) svg!.unpauseAnimations();
      else svg!.pauseAnimations();
    }
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; sync(); });
    observer.observe(figure);
    reduced.addEventListener("change", sync);
    compact.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      observer.disconnect();
      reduced.removeEventListener("change", sync);
      compact.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return <figure ref={root} className="data-flow-diagram" data-motion="paused">
    <div className="data-flow-summary"><span>Event delivery</span><span>Five stages, one event</span></div>
    <div className="data-flow-journey">
      <svg ref={drawing} className="data-flow-route" viewBox="0 0 1000 100" preserveAspectRatio="none" fill="none" aria-hidden="true" focusable="false">
        <path id={`${id}-route`} d={route} vectorEffect="non-scaling-stroke"/>
        <circle className="data-flow-packet" r="3"><animateMotion dur="9s" repeatCount="indefinite"><mpath href={`#${id}-route`}/></animateMotion></circle>
      </svg>
      <ol className="data-flow-stages" aria-label="Event delivery stages">
        {DATA_FLOW.map((item, index) => <li key={item.id} className={`data-flow-step data-flow-step-${item.id}`}>
          <button type="button" aria-pressed={selected === index} aria-controls={`${id}-detail`} onClick={() => setSelected(index)}>
            <span className="data-flow-icon"><Icon name={item.icon}/><span className="data-flow-number" aria-hidden="true">0{index + 1}</span></span>
            <strong>{item.title}</strong>
            <span className="data-flow-protocol">{item.protocol}</span>
            <span className="sr-only">Step {index + 1}. Show details.</span>
          </button>
        </li>)}
      </ol>
    </div>
    <figcaption>Select a stage to inspect its data flow.</figcaption>
    <div className="data-flow-detail" id={`${id}-detail`} role="status" aria-live="polite" aria-atomic="true">
      <span className="data-flow-detail-number" aria-hidden="true">0{selected + 1}</span>
      <div><h3>{step.title}</h3><p>{step.text}</p>
        {step.id === "outcome" && <ul className="data-flow-outcomes" aria-label="Possible delivery outcomes">
          <li><Icon name="check"/>Delivered</li><li><Icon name="retry"/>Retry same message</li><li><Icon name="archive"/>Dead letter</li>
        </ul>}
      </div>
    </div>
  </figure>;
}
