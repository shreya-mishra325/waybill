"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MOTION, ROUTES, flightPath, flightSegments, landingRoutes, networkLayout, sampleFlight, sampleRoute, scrollFlightDistance, type MeasuredRoute, type NetworkLayout, type Sample } from "../lib/network";
import { Icon, type IconName } from "./icon";

const labels: {text: string; x: number; y: number; width: number; icon?: IconName; dark?: boolean}[] = [
  {text: "Event", x: 300, y: 132, width: 142, dark: true},
  {text: "Ingestion", x: 650, y: 205, width: 165, icon: "database"},
  {text: "Queue", x: 900, y: 325, width: 138, icon: "database"},
  {text: "Worker", x: 1035, y: 448, width: 149, icon: "worker"},
  {text: "Destination", x: 1310, y: 255, width: 172, icon: "globe"},
  {text: "Dead letter", x: 1300, y: 600, width: 180, icon: "archive", dark: true},
];
type Occlusion = { x: number; y: number; width: number; height: number };
type NetworkNode = { route: number; point: Sample; accent: boolean; phase: number };
type NetworkPacket = { route: number; distance: number; speed: number };
type Scene = { routes: MeasuredRoute[]; nodes: NetworkNode[]; packets: NetworkPacket[]; flight: MeasuredRoute; flightStops: {scroll: number; distance: number}[] };
type View = {layout: NetworkLayout; height: number};
const protectedText = ".site-header, .hero-content, .highlights, .product-copy, .product-preview figcaption, .how-copy, .architecture-tabs, .architecture-detail, .architecture-support, .architecture-figure figcaption, .features-heading, .developer-copy, .integration-example figcaption, .integration-copy-status, .docs-intro";

function measurePath(path: SVGPathElement): MeasuredRoute {
  const length = path.getTotalLength();
  const spacing = 12;
  const points = Array.from({length: Math.ceil(length / spacing) + 1}, (_, index) => {
    const point = path.getPointAtLength(Math.min(index * spacing, length));
    return {x: point.x, y: point.y};
  });
  return {points, length, spacing};
}

export function LandingNetwork() {
  const svg = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ambientCanvas = useRef<HTMLCanvasElement>(null);
  const pulseSprite = useRef<HTMLCanvasElement | null>(null);
  const elapsed = useRef(0);
  const [view, setView] = useState<View>(() => ({layout: networkLayout(1536, 900), height: 1024}));
  const {layout} = view;
  const [occlusions, setOcclusions] = useState<Occlusion[]>([]);
  const [scene, setScene] = useState<Scene>();
  const routes = useMemo(() => landingRoutes(layout), [layout]);
  const flight = useMemo(() => flightPath(layout), [layout]);
  const maskId = `landing-foreground-${useId().replaceAll(":", "")}`;

  useEffect(() => {
    const root = svg.current?.closest<HTMLElement>(".public-site");
    if (!root) return;
    let frame = 0;
    let disposed = false;
    function measure() {
      if (disposed) return;
      const bounds = root!.getBoundingClientRect();
      const next = networkLayout(bounds.width, bounds.height);
      setView(previous => previous.layout.width === next.width && previous.layout.height === next.height && previous.height === window.innerHeight ? previous : {layout: next, height: window.innerHeight});
      const rects: Occlusion[] = [];
      root!.querySelectorAll(protectedText).forEach(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text: Node | null;
        while ((text = walker.nextNode())) {
          if (!text.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          for (const rect of range.getClientRects()) {
            if (!rect.width || !rect.height) continue;
            rects.push({x: (rect.left - bounds.left - 9) / next.scale + next.left, y: (rect.top - bounds.top - 7) / next.scale, width: (rect.width + 18) / next.scale, height: (rect.height + 14) / next.scale});
          }
        }
      });
      setOcclusions(previous => JSON.stringify(previous) === JSON.stringify(rects) ? previous : rects);
    }
    function schedule() { if (disposed || frame) return; frame = requestAnimationFrame(() => {frame = 0; measure();}); }
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    root.querySelectorAll("main > section").forEach(section => resize.observe(section));
    const mutation = new MutationObserver(schedule);
    const main = root.querySelector("main");
    if (main) mutation.observe(main, {childList: true, characterData: true, subtree: true});
    window.addEventListener("resize", schedule, {passive: true});
    void document.fonts.ready.then(schedule);
    measure();
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); window.removeEventListener("resize", schedule); };
  }, []);

  useEffect(() => {
    const root = svg.current;
    if (!root) return;
    function geometry(d: string) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      return measurePath(path);
    }
    const measured = routes.map(geometry);
    const heroLengths = ROUTES.map(d => geometry(d).length);
    const compact = layout.width <= 767;
    const nodes: NetworkNode[] = [];
    measured.forEach((route, routeIndex) => {
      if (compact && (routeIndex === 1 || routeIndex === 4)) return;
      const distances = [0.09, 0.22, 0.37, 0.53, 0.69, 0.84, 0.94].map(fraction => fraction * heroLengths[routeIndex]!);
      for (let distance = heroLengths[routeIndex]! + 140; distance < route.length; distance += 300) distances.push(distance);
      distances.forEach((distance, index) => {
        const point = sampleRoute(route, distance);
        const mobileAccent = compact && index < 7 && index % 2 === 1 && point.x > layout.left + 20 && point.x < layout.left + layout.width / layout.scale - 20;
        nodes.push({route: routeIndex, point, accent: (index + routeIndex) % 4 === 0 || mobileAccent, phase: (index * 0.29 + routeIndex * 0.17) % 1});
      });
    });
    const packets: NetworkPacket[] = [];
    (compact ? [0, 2] : [0, 1, 5]).forEach((route, index) => {
      const gap = compact ? 1000 : 2200;
      const count = Math.max(1, Math.floor(measured[route]!.length / gap));
      for (let packet = 0; packet < count; packet++) packets.push({route, distance: heroLengths[route]! * [0.18, 0.51, 0.76][index]! + packet * gap, speed: heroLengths[route]! / (MOTION.packetSeconds + index * 2)});
    });
    let distance = 0;
    const flightStops = flightSegments(layout).map(segment => {
      distance += geometry(segment.d).length;
      return {scroll: segment.scroll, distance};
    });
    setScene({routes: measured, nodes, packets, flight: geometry(flight), flightStops});
  }, [routes, flight, layout.width, layout.left, layout.scale]);

  useEffect(() => {
    const root = svg.current;
    if (!root || !scene) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(pointer: fine)");
    const frozen = new URLSearchParams(window.location.search).get("motion") === "off";
    const worlds = [...root.querySelectorAll<SVGGElement>(".network-world")];
    const surface = canvas.current;
    const context = surface?.getContext("2d", {alpha: true});
    if (!surface || !context) return;
    const ambientSurface = ambientCanvas.current;
    const ambientContext = ambientSurface?.getContext("2d", {alpha: true});
    if (!ambientSurface || !ambientContext) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    surface.width = Math.ceil(layout.width * ratio);
    surface.height = Math.ceil(view.height * ratio);
    ambientSurface.width = surface.width;
    ambientSurface.height = surface.height;
    const paths = routes.map(d => new Path2D(d));
    const style = getComputedStyle(root);
    const routeColor = style.getPropertyValue("--wb-route").trim();
    const accentColor = style.getPropertyValue("--wb-accent").trim();
    const dotColor = style.getPropertyValue("--wb-ink-on-dark").trim();
    const routeWidth = Number(style.getPropertyValue("--wb-network-width"));
    const routeOpacity = Number(style.getPropertyValue("--wb-network-opacity"));
    const secondaryOpacity = Number(style.getPropertyValue("--wb-network-secondary-opacity"));
    const packetOpacity = Number(style.getPropertyValue("--wb-network-packet-opacity"));
    const plane = root.querySelector<SVGGElement>(".paper-plane")!;
    const trail = root.querySelector<SVGPathElement>(".flight-trail")!;
    root.dataset.renderer = "canvas";
    root.dataset.nodes = String(scene.nodes.length);
    root.dataset.packets = String(scene.packets.length);
    const pulseSize = 60;
    const pulseImage = new Image();
    pulseImage.onload = () => {
      const sprite = document.createElement("canvas");
      sprite.width = 120;
      sprite.height = 120;
      const spriteContext = sprite.getContext("2d");
      if (spriteContext) {
        spriteContext.drawImage(pulseImage, 0, 0, 120, 120);
        pulseSprite.current = sprite;
        root.dataset.pulseAsset = "loaded";
      }
    };
    pulseImage.onerror = () => { root.dataset.pulseAsset = "fallback"; };
    if (!pulseSprite.current) pulseImage.src = "/waybill-delivery-pulse.svg";
    else root.dataset.pulseAsset = "loaded";
    const initial = sampleFlight(scene.flight, 0);
    const next = sampleFlight(scene.flight, 4);
    const initialAngle = Math.atan2(next.y - initial.y, next.x - initial.x) * 180 / Math.PI;
    let frame = 0;
    let previous = 0;
    let scrollDirty = true;
    let scroll = window.scrollY;
    let cursor = {x: -9999, y: -9999};
    function setViewport() {
      const top = scroll / layout.scale;
      const bottom = top + view.height / layout.scale;
      const transform = `translate(0 ${-top})`;
      for (const world of worlds) world.setAttribute("transform", transform);
      const distance = frozen || reduced.matches ? 0 : scrollFlightDistance(scroll, layout.scale, scene!.flight.length, scene!.flightStops);
      const point = sampleFlight(scene!.flight, distance);
      const ahead = sampleFlight(scene!.flight, Math.min(scene!.flight.length, distance + 4));
      const behind = sampleFlight(scene!.flight, Math.max(0, distance - 4));
      const angle = Math.atan2(ahead.y - behind.y, ahead.x - behind.x) * 180 / Math.PI - initialAngle;
      plane.setAttribute("transform", `translate(${point.x} ${point.y}) rotate(${angle})`);
      trail.setAttribute("stroke-dasharray", `${Math.min(115, distance)} ${scene!.flight.length}`);
      trail.setAttribute("stroke-dashoffset", String(-Math.max(0, distance - 115)));
      scrollDirty = false;
    }
    const ambient = [[-24,350,104],[640,94,62],[1460,530,99],[40,835,100],[1287,859,88],[870,710,53]];
    for (let band = 1; band < Math.ceil(layout.height / layout.scale / 900); band++) {
      ambient.push([layout.left + layout.width / layout.scale * 0.12,band * 900 + 210,83], [layout.left + layout.width / layout.scale * 0.88,band * 900 + 610,92]);
    }
    function circle(x: number, y: number, radius: number, color: string, opacity: number, stroke = false) {
      context!.beginPath();
      context!.arc(x, y, radius, 0, Math.PI * 2);
      context!.globalAlpha = opacity;
      if (stroke) {context!.strokeStyle = color; context!.lineWidth = 0.9; context!.stroke();}
      else {context!.fillStyle = color; context!.fill();}
    }
    function render(seconds: number, animated: boolean) {
      if (scrollDirty) {
        setViewport();
        ambientContext!.setTransform(1, 0, 0, 1, 0, 0);
        ambientContext!.clearRect(0, 0, ambientSurface!.width, ambientSurface!.height);
        ambientContext!.setTransform(ratio * layout.scale, 0, 0, ratio * layout.scale, -layout.left * ratio * layout.scale, -scroll * ratio);
        ambientContext!.fillStyle = "#2b7183";
        ambientContext!.globalAlpha = 0.19;
        for (const [x, y, r] of ambient) {
          if (y! + r! < scroll / layout.scale || y! - r! > (scroll + view.height) / layout.scale) continue;
          ambientContext!.beginPath();
          ambientContext!.arc(x!, y!, r!, 0, Math.PI * 2);
          ambientContext!.fill();
        }
      }
      const top = scroll / layout.scale;
      const bottom = top + view.height / layout.scale;
      context!.setTransform(1, 0, 0, 1, 0, 0);
      context!.clearRect(0, 0, surface!.width, surface!.height);
      context!.setTransform(ratio * layout.scale, 0, 0, ratio * layout.scale, -layout.left * ratio * layout.scale, -scroll * ratio);
      const sway = paths.map((path, index) => {
        const amount = animated ? Math.sin(seconds * Math.PI * 2 / MOTION.swaySeconds + index) : 0;
        const offset = {x: amount * 2, y: amount * 3};
        if (layout.width <= 767 && (index === 1 || index === 4)) return offset;
        context!.save();
        context!.translate(offset.x, offset.y);
        context!.strokeStyle = routeColor;
        context!.lineWidth = routeWidth;
        context!.globalAlpha = index === 0 || index === 4 ? secondaryOpacity : routeOpacity;
        context!.setLineDash(index === 0 || index === 4 ? [2,7] : [3,6]);
        context!.stroke(path);
        context!.restore();
        return offset;
      });
      context!.setLineDash([]);
      for (const node of scene!.nodes) {
        const point = node.point;
        if (point.y < top - 40 || point.y > bottom + 40 || point.x < layout.left - 40 || point.x > layout.left + layout.width / layout.scale + 40) continue;
        const offset = sway[node.route]!;
        const x = point.x + offset.x;
        const y = point.y + offset.y;
        const nearby = animated && finePointer.matches ? Math.max(0, 1 - Math.hypot(point.x - cursor.x, point.y - cursor.y) / 170) : 0;
        if (node.accent) {
          const phase = (seconds / MOTION.radiateSeconds + node.phase) % 1;
          if (animated && phase < 0.62) {
            const progress = phase / 0.62;
            const eased = 1 - (1 - progress) ** 2;
            circle(x, y, 10 + eased * 25, "#83b5bc", (1 - progress) ** 1.8 * 0.26, true);
          }
          if (pulseSprite.current) {
            context!.globalAlpha = 0.96 + nearby * 0.04;
            context!.drawImage(pulseSprite.current, x - pulseSize / 2, y - pulseSize / 2, pulseSize, pulseSize);
          } else {
            circle(x, y, 30, "#83b5bc", 0.1);
            circle(x, y, 10, accentColor, 1);
            circle(x, y, 5, "#fffcf5", 1);
          }
        } else circle(x, y, 2.5, dotColor, 0.78);
      }
      for (const packet of scene!.packets) {
        const point = sampleRoute(scene!.routes[packet.route]!, packet.distance + seconds * packet.speed);
        if (point.y < top - 20 || point.y > bottom + 20) continue;
        const offset = sway[packet.route]!;
        circle(point.x + offset.x, point.y + offset.y, 10, accentColor, 0.16 * packetOpacity);
        circle(point.x + offset.x, point.y + offset.y, 4, accentColor, packetOpacity);
        circle(point.x + offset.x, point.y + offset.y, 4, dotColor, packetOpacity, true);
      }
      context!.globalAlpha = 1;
      for (const rect of occlusions) {
        if (rect.y + rect.height < top || rect.y > bottom) continue;
        context!.clearRect(rect.x, rect.y, rect.width, rect.height);
      }
    }
    function tick(timestamp: number) {
      if (previous) elapsed.current += Math.max(0, timestamp - previous) / 1000;
      previous = timestamp;
      const animated = !frozen && !reduced.matches && !document.hidden;
      root!.dataset.motion = animated ? "running" : "paused";
      render(frozen || reduced.matches ? 0 : elapsed.current, animated);
      frame = animated ? requestAnimationFrame(tick) : 0;
    }
    function requestFrame() { if (!frame) frame = requestAnimationFrame(tick); }
    function onScroll() { scroll = window.scrollY; scrollDirty = true; requestFrame(); }
    function sync() {
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
      scroll = window.scrollY;
      scrollDirty = true;
      root!.dataset.motion = !frozen && !reduced.matches && !document.hidden ? "running" : "paused";
      render(frozen || reduced.matches ? 0 : elapsed.current, false);
      if (root!.dataset.motion === "running") requestFrame();
    }
    function onPointer(event: PointerEvent) {
      cursor = {x: event.clientX / layout.scale + layout.left, y: (event.clientY + scroll) / layout.scale};
      if (finePointer.matches) requestFrame();
    }
    reduced.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("scroll", onScroll, {passive: true});
    window.addEventListener("pointermove", onPointer, {passive: true});
    sync();
    return () => {
      cancelAnimationFrame(frame);
      pulseImage.onload = null;
      pulseImage.onerror = null;
      reduced.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointer);
    };
  }, [scene, layout, view.height, routes, occlusions]);

  const worldWidth = layout.width / layout.scale;
  const viewportHeight = view.height / layout.scale;
  return <div className="landing-art" aria-hidden="true" data-ready={Boolean(scene)}>
    <canvas ref={ambientCanvas} className="network-ambient"/>
    <canvas ref={canvas} className="network-canvas"/>
    <svg ref={svg} className="network landing-network" viewBox={`${layout.left} 0 ${worldWidth} ${viewportHeight}`} preserveAspectRatio="none" focusable="false">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={layout.left} y="0" width={worldWidth} height={viewportHeight} style={{maskType: "luminance"}}>
          <rect x={layout.left} y="0" width={worldWidth} height={viewportHeight} fill="white"/>
          <g className="network-world">{occlusions.map((rect, index) => <rect key={index} {...rect} rx="4" fill="black"/>)}</g>
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}><g className="network-world">
        <g className="flight-system"><path className="flight-guide" d={flight}/><path className="flight-trail" d={flight}/>
          <g className="paper-plane"><g transform="scale(1.6)"><image href="/waybill-paper-airplane.svg" x="-21" y="-17" width="42" height="34"/></g></g>
        </g>
      </g></g>
      <g className="network-world"><g className="network-labels">{labels.map(label => <g className={`network-label ${label.dark ? "network-label-dark" : ""} label-${label.text.toLowerCase().replace(" ", "-")}`} key={label.text} transform={`translate(${label.x} ${label.y})`}>
        <rect width={label.width} height="56" rx="7"/>
        {label.icon ? <g transform="translate(17 16)"><Icon name={label.icon} style={{width: 24, height: 24}}/></g> : <text className="event-braces" x="16" y="35">{'{}'}</text>}
        <text x="54" y="34">{label.text}</text>
      </g>)}</g></g>
    </svg>
  </div>;
}
