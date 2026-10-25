export const ROUTES = [
  "M-90 176 C80 55 172 183 282 121 S489 39 564 121 S688 253 795 220 S976 148 1103 202 S1354 73 1615 221",
  "M-70 249 C62 99 146 285 308 208 S479 88 566 190 S719 293 802 278 S931 494 1046 419 S1157 193 1326 224 S1466 379 1610 328",
  "M-90 325 C90 397 130 491 60 596 S-31 728 95 721 C260 715 281 817 450 734 S635 779 734 654 S913 539 1018 632 S1192 639 1315 600 S1511 694 1615 587",
  "M-65 710 C118 765 278 659 439 704 S628 803 783 744 S975 695 1104 751 S1300 737 1400 815 S1530 850 1610 875",
  "M783 175 C933 74 1104 297 1207 168 S1402 112 1542 207",
  "M1030 474 C1172 531 1240 293 1394 358 S1514 584 1436 651 S1461 748 1610 725",
] as const;

export const HERO_FLIGHT_PATH = "M1252 517 C1322 452 1430 478 1410 563 C1388 656 1208 690 1126 629 C1072 589 1097 536 1124 551 C1167 577 1110 625 1096 590 C1082 554 1198 581 1272 655 C1340 723 1408 773 1398 860";
export const MOTION = { swaySeconds: 18, packetSeconds: 11, radiateSeconds: 4.6 } as const;
export type Sample = { x: number; y: number };

export function samplePosition(points: readonly Sample[], progress: number): Sample {
  if (points.length < 2) throw new Error("A motion path needs at least two samples");
  const position = ((progress % 1 + 1) % 1) * (points.length - 1);
  const index = Math.floor(position);
  const next = Math.min(index + 1, points.length - 1);
  const fraction = position - index;
  return {x: points[index]!.x + (points[next]!.x - points[index]!.x) * fraction,
    y: points[index]!.y + (points[next]!.y - points[index]!.y) * fraction};
}

export type NetworkLayout = { width: number; height: number; scale: number; left: number };
export type MeasuredRoute = { points: readonly Sample[]; length: number; spacing: number };

const ROUTE_ENDS: readonly Sample[] = [
  {x: 1615, y: 221}, {x: 1610, y: 328}, {x: 1615, y: 587},
  {x: 1610, y: 875}, {x: 1542, y: 207}, {x: 1610, y: 725},
];

export function networkLayout(width: number, height: number): NetworkLayout {
  const heroHeight = width <= 767 ? 800 : width >= 1600 ? 960 : 900;
  const scale = Math.max(width * (width > 767 && width <= 1100 ? 1.3 : 1) / 1536, heroHeight / 900);
  return {width, height, scale, left: (1536 - width / scale) / 2};
}

export function landingRoutes(layout: NetworkLayout): string[] {
  const left = layout.left - 90;
  const right = layout.left + layout.width / layout.scale + 90;
  const height = layout.height / layout.scale;
  return ROUTES.map((original, index) => {
    const end = ROUTE_ENDS[index]!;
    let y = 930 + index * 110;
    let x = right;
    let d = `${original} C${end.x + 80} ${end.y + 120} ${right + 90} ${y - 160} ${right} ${y}`;
    let towardsLeft = true;
    let band = 0;
    while (y < height + 900) {
      const target = towardsLeft ? left : right;
      const span = target - x;
      const phase = index * 0.91 + band * 1.4;
      const crest = 125 + Math.sin(phase) * 115;
      const trough = 165 + Math.cos(phase) * 120;
      const bend = Math.sin(phase + 0.7) * 145;
      d += ` C${x + span * 0.12} ${y - crest} ${x + span * 0.24} ${y + trough} ${x + span * 0.43} ${y + bend}`;
      d += ` C${x + span * 0.61} ${y - trough} ${x + span * 0.79} ${y + crest} ${target} ${y + 160}`;
      const outside = towardsLeft ? -140 : 140;
      d += ` C${target + outside} ${y + 260} ${target + outside * 0.65} ${y + 750} ${target} ${y + 900}`;
      x = target;
      y += 900;
      towardsLeft = !towardsLeft;
      band += 1;
    }
    return d;
  });
}

export function sampleRoute(route: MeasuredRoute, distance: number): Sample {
  if (route.points.length < 2 || route.length <= 0 || route.spacing <= 0) throw new Error("A measured route needs a positive length, spacing and at least two samples");
  const position = (distance % route.length + route.length) % route.length;
  const index = Math.min(Math.floor(position / route.spacing), route.points.length - 2);
  const next = route.points[index + 1]!;
  const point = route.points[index]!;
  const fraction = (position - index * route.spacing) / Math.min(route.spacing, route.length - index * route.spacing);
  return {x: point.x + (next.x - point.x) * fraction, y: point.y + (next.y - point.y) * fraction};
}

export function flightSegments(layout: NetworkLayout): {d: string; scroll: number}[] {
  const compact = layout.width <= 767;
  const dx = compact ? -540 : layout.width <= 1100 ? -220 : 0;
  const dy = layout.width <= 1100 ? 105 : 0;
  let coordinate = 0;
  const hero = HERO_FLIGHT_PATH.replace(/-?\d+(?:\.\d+)?/g, value => String(Number(value) + (coordinate++ % 2 === 0 ? dx : dy)));
  const segments = [{d: hero, scroll: 343}];
  const right = layout.left + layout.width / layout.scale - 100;
  const left = layout.left + 100;
  let x = 1398 + dx;
  let y = 860 + dy;
  for (let band = 0; y < layout.height / layout.scale + 1200; band++) {
    const target = band % 2 === 0 ? left : right;
    const span = target - x;
    const d = `M${x} ${y} C${x} ${y + 220} ${x + span * 0.2} ${y + 440} ${x + span * 0.55} ${y + 410} C${target} ${y + 380} ${target} ${y + 670} ${target} ${y + 820}`;
    segments.push({d, scroll: 343 + (band + 1) * 820});
    x = target;
    y += 820;
  }
  return segments;
}

export function flightPath(layout: NetworkLayout): string {
  return flightSegments(layout).map((segment, index) => index === 0 ? segment.d : segment.d.replace(/^M[^C]+/, "")).join(" ");
}

export function scrollFlightDistance(scroll: number, scale: number, length: number, stops?: readonly {scroll: number; distance: number}[]): number {
  const position = Math.max(0, scroll) / Math.max(0.01, scale);
  if (!stops?.length) return Math.min(Math.max(0, length), position * 1.15);
  let previous = {scroll: 0, distance: 0};
  for (const stop of stops) {
    if (position <= stop.scroll) return Math.min(length, previous.distance + (stop.distance - previous.distance) * (position - previous.scroll) / (stop.scroll - previous.scroll));
    previous = stop;
  }
  return length;
}

export function sampleFlight(route: MeasuredRoute, distance: number): Sample {
  if (distance <= 0) return route.points[0]!;
  if (distance >= route.length) return route.points[route.points.length - 1]!;
  return sampleRoute(route, distance);
}
