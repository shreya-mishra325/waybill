"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useMotionValueEvent, useScroll } from "motion/react";
import { ARCHITECTURE_NODES, type ArchitectureNodeId } from "../lib/architecture";
import { connectionPath, type Bounds, type Port } from "../lib/architecture-paths";
import { Icon, type IconName } from "./icon";

type Edge = { from: ArchitectureNodeId; to: ArchitectureNodeId; exit: Port; entry: Port; exitAt?: number; entryAt?: number; branch?: boolean };
const edges: Edge[] = [
  { from: "application", to: "ingestion", exit: "right", entry: "left" },
  { from: "ingestion", to: "postgres", exit: "top", entry: "bottom", entryAt: 0.25 },
  { from: "postgres", to: "poller", exit: "bottom", entry: "top", exitAt: 0.75 },
  { from: "poller", to: "queue", exit: "right", entry: "left" },
  { from: "queue", to: "workers", exit: "right", entry: "left" },
  { from: "workers", to: "destination", exit: "right", entry: "left" },
  { from: "workers", to: "retry", exit: "bottom", entry: "top", entryAt: 0.25, branch: true },
  { from: "retry", to: "queue", exit: "top", entry: "bottom", exitAt: 0.75, branch: true },
  { from: "workers", to: "dead-letter", exit: "bottom", entry: "top", branch: true },
];
const icons: Record<ArchitectureNodeId, IconName> = {
  application: "code", ingestion: "database", postgres: "database", poller: "arrow", queue: "database",
  workers: "worker", destination: "globe", retry: "worker", "dead-letter": "archive",
};
type Geometry = { width: number; height: number; paths: string[] };

export function ArchitectureDiagram() {
  const canvas = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const motionAllowed = useRef(false);
  const [geometry, setGeometry] = useState<Geometry>();
  const [selected, setSelected] = useState<ArchitectureNodeId>("postgres");
  const id = useId().replaceAll(":", "");
  const { scrollYProgress } = useScroll({ target: canvas, offset: ["start 90%", "end 35%"] });
  function emphasize(value: number) {
    if (!canvas.current || !motionAllowed.current) return;
    const reached = Math.min(6, Math.floor(value * 7));
    canvas.current.querySelectorAll<HTMLElement>("[data-stage]").forEach((node, index) => {
      node.dataset.reached = String(index <= reached && index < 7);
    });
  }
  useMotionValueEvent(scrollYProgress, "change", emphasize);

  useEffect(() => {
    const root = canvas.current;
    const drawing = svg.current;
    if (!root || !drawing) return;
    const compact = window.matchMedia("(max-width: 700px)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const frozen = new URLSearchParams(window.location.search).get("motion") === "off";
    let frame = 0;
    let disposed = false;
    let visible = false;
    function measure() {
      if (disposed) return;
      const rect = root!.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const boxes = new Map<ArchitectureNodeId, Bounds>();
      root!.querySelectorAll<HTMLElement>("[data-stage]").forEach(node => {
        const box = node.getBoundingClientRect();
        boxes.set(node.dataset.stage as ArchitectureNodeId, { x: box.left - rect.left, y: box.top - rect.top, width: box.width, height: box.height });
      });
      setGeometry({ width: rect.width, height: rect.height, paths: edges.map(edge => {
        let exit = edge.exit;
        let entry = edge.entry;
        if (compact.matches) {
          exit = edge.branch ? edge.from === "retry" ? "left" : "right" : "bottom";
          entry = edge.branch ? edge.from === "retry" ? "left" : "right" : "top";
        }
        return connectionPath(boxes.get(edge.from)!, boxes.get(edge.to)!, exit, entry, compact.matches ? {} : { exit: edge.exitAt, entry: edge.entryAt });
      }) });
    }
    function scheduleMeasure() { if (disposed) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); }
    function sync() {
      motionAllowed.current = !frozen && !reduced.matches && !document.hidden && visible;
      root!.dataset.motion = motionAllowed.current ? "running" : "paused";
      if (motionAllowed.current) { drawing!.unpauseAnimations(); emphasize(scrollYProgress.get()); }
      else drawing!.pauseAnimations();
      if (frozen || reduced.matches) {
        drawing!.setCurrentTime(0);
        root!.querySelectorAll<HTMLElement>("[data-reached]").forEach(node => { delete node.dataset.reached; });
      }
    }
    const resize = new ResizeObserver(scheduleMeasure);
    resize.observe(root);
    root.querySelectorAll("[data-stage]").forEach(node => resize.observe(node));
    const intersection = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; sync(); });
    intersection.observe(root);
    reduced.addEventListener("change", sync);
    compact.addEventListener("change", scheduleMeasure);
    document.addEventListener("visibilitychange", sync);
    void document.fonts.ready.then(scheduleMeasure);
    measure();
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      reduced.removeEventListener("change", sync);
      compact.removeEventListener("change", scheduleMeasure);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const current = ARCHITECTURE_NODES.find(node => node.id === selected)!;
  return <figure className="architecture-figure">
    <div ref={canvas} className="architecture-canvas" data-motion="paused">
      <svg ref={svg} className="architecture-connections" viewBox={geometry ? `0 0 ${geometry.width} ${geometry.height}` : undefined} aria-hidden="true" focusable="false">
        <defs><marker id={`${id}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1 7 4 1 7"/></marker></defs>
        {geometry?.paths.map((d, index) => <path id={`${id}-path-${index}`} key={index} d={d} className={`architecture-edge ${edges[index]!.branch ? "architecture-edge-branch" : ""}`} markerEnd={`url(#${id}-arrow)`}/>)}
        {geometry && [0, 3, 5].map((edge, index) => <circle key={edge} className={`architecture-packet architecture-packet-${index}`} r="2.5"><animateMotion dur={`${7 + index}s`} begin={`-${index * 3}s`} repeatCount="indefinite"><mpath href={`#${id}-path-${edge}`}/></animateMotion></circle>)}
      </svg>
      <ol className="architecture-nodes" aria-label="Event delivery architecture, with retry and dead-letter branches">
        {ARCHITECTURE_NODES.map((node, index) => <li key={node.id} className={`architecture-node architecture-node-${node.id}`}>
          <button type="button" data-stage={node.id} aria-pressed={selected === node.id} aria-controls={`${id}-detail`} onClick={() => setSelected(node.id)}>
            {node.id === "retry" ? <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></svg> : <Icon name={icons[node.id]}/>}
            <span className="architecture-node-copy"><strong>{node.title}</strong><span>{node.caption}</span>{node.id === "retry" && <small>Same SQS message</small>}</span>
            <span className="sr-only">{index < 7 ? `Stage ${index + 1}. ` : "Failure branch. "}Show details.</span>
          </button>
        </li>)}
      </ol>
    </div>
    <figcaption>Select a component to inspect its role.</figcaption>
    <div className="architecture-detail" id={`${id}-detail`} role="status" aria-live="polite" aria-atomic="true"><strong>{current.title}</strong><p>{current.detail}</p></div>
    <dl className="architecture-support"><div><dt>S3</dt><dd>Large payload claim-checks & dead-letter archives.</dd></div><div><dt>Redis</dt><dd>Tenant rate limits & destination circuit breakers.</dd></div></dl>
  </figure>;
}
