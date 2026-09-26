// Freehand strokes: thinning the raw pointer samples, and the smooth SVG
// path both the page and the exported PDF draw them with.

/** Ramer-Douglas-Peucker on a flat [x0, y0, x1, y1, ...] list. Keeps a
 * stroke's shape while dropping most of the samples a pointer produces,
 * which is what keeps a page of handwriting small enough to save. */
export function simplify(points: number[], tolerance = 0.35): number[] {
  const n = points.length / 2;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = points[a * 2], ay = points[a * 2 + 1], bx = points[b * 2], by = points[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const length = Math.hypot(dx, dy);
    let worst = -1, worstDistance = tolerance;
    for (let i = a + 1; i < b; i++) {
      const px = points[i * 2], py = points[i * 2 + 1];
      const distance = length ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / length : Math.hypot(px - ax, py - ay);
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(round(points[i * 2]), round(points[i * 2 + 1]));
  return out;
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Quadratic curves through the midpoints between samples - smooth, and it
 * passes close enough to every kept sample to read as what was drawn. */
export function strokePath(points: number[]): string {
  const n = points.length / 2;
  if (n === 0) return "";
  const p = (i: number) => `${round(points[i * 2])} ${round(points[i * 2 + 1])}`;
  if (n === 1) return `M ${p(0)} l 0.01 0`;
  if (n === 2) return `M ${p(0)} L ${p(1)}`;
  let d = `M ${p(0)}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = (points[i * 2] + points[i * 2 + 2]) / 2;
    const my = (points[i * 2 + 1] + points[i * 2 + 3]) / 2;
    d += ` Q ${p(i)} ${round(mx)} ${round(my)}`;
  }
  return `${d} L ${p(n - 1)}`;
}
