import type { MeasuredRoute, Sample } from './network';

const midpoint = (a: Sample, b: Sample): Sample => ({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
const distance = (a: Sample, b: Sample) => Math.hypot(a.x - b.x, a.y - b.y);

function flatten(start: Sample, first: Sample, second: Sample, end: Sample, points: Sample[], depth = 0): void {
  const chord = distance(start, end);
  const polygon = distance(start, first) + distance(first, second) + distance(second, end);
  if (depth >= 16 || polygon - chord < 0.002) {
    points.push(end);
    return;
  }
  const a = midpoint(start, first);
  const b = midpoint(first, second);
  const c = midpoint(second, end);
  const d = midpoint(a, b);
  const e = midpoint(b, c);
  const center = midpoint(d, e);
  flatten(start, a, d, center, points, depth + 1);
  flatten(center, e, c, end, points, depth + 1);
}

export function measureNetworkPath(path: string, spacing = 12): MeasuredRoute {
  if (!Number.isFinite(spacing) || spacing <= 0) throw new Error('Path spacing must be positive');
  const tokens = path.match(/[A-Za-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  const vertices: Sample[] = [];
  let index = 0;
  let command = '';
  let current: Sample = {x: 0, y: 0};
  let control = current;
  let previousCommand = '';
  function point(): Sample {
    const x = Number(tokens[index++]);
    const y = Number(tokens[index++]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid network path coordinate');
    return {x, y};
  }
  while (index < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[index]!)) command = tokens[index++]!;
    if (command === 'M' && !vertices.length) {
      current = point();
      vertices.push(current);
      control = current;
    } else if (command === 'C' || command === 'S') {
      const first = command === 'C' ? point() : previousCommand === 'C' || previousCommand === 'S'
        ? {x: 2 * current.x - control.x, y: 2 * current.y - control.y} : current;
      control = point();
      const end = point();
      flatten(current, first, control, end, vertices);
      current = end;
    } else throw new Error('Network paths support one M followed by C or S curves');
    previousCommand = command;
  }
  if (vertices.length < 2) throw new Error('A network path needs a curve');
  const lengths = [0];
  for (let i = 1; i < vertices.length; i++) lengths.push(lengths[i - 1]! + distance(vertices[i - 1]!, vertices[i]!));
  const length = lengths.at(-1)!;
  if (length <= 0) throw new Error('A network path needs a positive length');
  let segment = 1;
  const points = Array.from({length: Math.ceil(length / spacing) + 1}, (_, i) => {
    const position = Math.min(i * spacing, length);
    while (segment < lengths.length - 1 && lengths[segment]! < position) segment++;
    const from = vertices[segment - 1]!;
    const to = vertices[segment]!;
    const span = lengths[segment]! - lengths[segment - 1]!;
    const fraction = span ? (position - lengths[segment - 1]!) / span : 0;
    return {x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction};
  });
  return {points, length, spacing};
}
