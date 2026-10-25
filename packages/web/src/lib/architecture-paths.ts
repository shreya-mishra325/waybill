export type Point = { x: number; y: number };
export type Bounds = { x: number; y: number; width: number; height: number };
export type Port = "top" | "right" | "bottom" | "left";

function anchor(box: Bounds, port: Port, fraction: number): Point {
  switch (port) {
    case "top": return { x: box.x + box.width * fraction, y: box.y };
    case "right": return { x: box.x + box.width, y: box.y + box.height * fraction };
    case "bottom": return { x: box.x + box.width * fraction, y: box.y + box.height };
    case "left": return { x: box.x, y: box.y + box.height * fraction };
  }
}

function control(point: Point, port: Port, distance: number): Point {
  return {
    x: point.x + (port === "right" ? distance : port === "left" ? -distance : 0),
    y: point.y + (port === "bottom" ? distance : port === "top" ? -distance : 0),
  };
}

export function connectionPath(from: Bounds, to: Bounds, exit: Port, entry: Port, positions: { exit?: number; entry?: number } = {}): string {
  const start = anchor(from, exit, positions.exit ?? 0.5);
  const end = anchor(to, entry, positions.entry ?? 0.5);
  const sameSide = exit === entry && (exit === "left" || exit === "right");
  if (sameSide) {
    const lane = exit === "left" ? Math.min(start.x, end.x) - 20 : Math.max(start.x, end.x) + 20;
    return `M${start.x} ${start.y}C${lane} ${start.y} ${lane} ${start.y} ${lane} ${start.y + (end.y - start.y) / 2}S${lane} ${end.y} ${end.x} ${end.y}`;
  }
  const distance = Math.max(12, Math.min(70, Math.hypot(end.x - start.x, end.y - start.y) * 0.45));
  const a = control(start, exit, distance);
  const b = control(end, entry, distance);
  return `M${start.x} ${start.y}C${a.x} ${a.y} ${b.x} ${b.y} ${end.x} ${end.y}`;
}
