// A photographed page, found and flattened: where its four corners are in the
// photo, and the photo redrawn so that page fills a rectangle - as if it had
// been scanned flat and straight on.
//
// Recognition reads staff lines as straight, evenly spaced and level. A page
// photographed at an angle has none of that: its staves converge, tilt and
// bend away into the distance, and the photo's background - a table, a lamp,
// the next page - is more for it to make sense of. Prod's photos that came back
// as "no music" were of real music, taken like that.
//
// Everything here is plain arithmetic on pixel arrays, so it runs (and is
// tested) without a browser. lib/page-photo.ts feeds it a photo's pixels.

export type Point = { x: number; y: number };
/** Top left, top right, bottom right, bottom left. */
export type Quad = [Point, Point, Point, Point];
/** One grey level a pixel, row by row. */
export type Gray = { data: ArrayLike<number>; width: number; height: number };
/** Four bytes a pixel (RGBA), row by row - a canvas's ImageData. */
export type Rgba = { data: Uint8ClampedArray; width: number; height: number };

/** The long side findPage works at: enough to place a corner within a few
 * pixels of a phone photo's, and quick to search. */
export const FIND_SIZE = 480;

// A page is at least this much of the photo; less is more likely something
// else that happens to be bright. One that fills nearly all of it has no
// edges in view worth cutting to.
const MIN_AREA = 0.12;
const MAX_AREA = 0.97;
// A page's corners, however steeply photographed, stay well away from flat
// or folded back.
const MIN_ANGLE = 40, MAX_ANGLE = 140;
// How much of the quad the bright region found must cover: ink makes holes in
// it, but a quad mostly over background isn't the page.
const MIN_FILL = 0.55;
// How much brighter the page must be than what's around it, in grey levels.
const MIN_CONTRAST = 18;

/** Where a page's corners are in `gray`, in its pixels, or null when no page
 * stands out from the background clearly enough to say. */
export function findPage(gray: Gray): Quad | null {
  const { width, height } = gray;
  if (width < 16 || height < 16) return null;
  const smooth = blur(gray, 2);
  const level = otsu(smooth);
  const page = largestRegion(smooth, width, height, level);
  if (!page) return null;
  const hull = convexHull(page.edge);
  if (hull.length < 4) return null;
  let quad = largestQuad(simplify(hull, 48));
  if (!quad) return null;
  quad = refineSides(quad, page.edge, Math.hypot(width, height));
  const area = polygonArea(quad);
  if (area < MIN_AREA * width * height || area > MAX_AREA * width * height) return null;
  if (!anglesPlausible(quad)) return null;
  if (page.count / area < MIN_FILL) return null;
  if (contrast(smooth, width, height, quad) < MIN_CONTRAST) return null;
  return quad;
}

/** The four points in Quad order: top left, top right, bottom right, bottom
 * left - clockwise around their middle, from the one nearest the top left, so
 * a page photographed at any tilt short of 45° keeps its top at the top. */
export function orderCorners(points: Point[]): Quad {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  // Clockwise on screen, where y runs down.
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  sorted.forEach((p, i) => { if (p.x + p.y < sorted[first].x + sorted[first].y) first = i; });
  return [0, 1, 2, 3].map((i) => sorted[(first + i) % 4]) as Quad;
}

/** The whole picture, as a quad: what to flatten when no page was found. */
export function wholeFrame(width: number, height: number): Quad {
  return [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
}

/** The 3x3 projective map (row by row, last entry 1) taking each corner of
 * `from` to the same corner of `to`. */
export function homography(from: Quad, to: Quad): number[] {
  // Eight equations, two a corner, in the eight unknowns h0..h7:
  //   X = (h0 x + h1 y + h2) / (h6 x + h7 y + 1), likewise Y with h3..h5.
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: X, y: Y } = to[i];
    rows.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
    rows.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  }
  const h = solve(rows);
  return [...h, 1];
}

export function project(h: number[], p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

// Straighter than this, a page is only cut out, not redrawn. Redrawing moves
// every pixel by some fraction of one, which softens a staff line one or two
// pixels thick - measured on a prod photo already taken straight on, it cost
// recognition a fifth of its notes - while recognition straightens a slight
// tilt by itself.
const SQUARE_DEGREES = 1.5;
const SQUARE_SIDES = 0.02;

/** The box to cut the page out with, when `quad` is that box near enough -
 * its sides level and upright, its opposite sides the same length - or null
 * when it needs flattening. Whole pixels, inside `width` x `height`. */
export function squareCrop(quad: Quad, width: number, height: number) {
  const [tl, tr, br, bl] = quad;
  const tilt = (a: Point, b: Point, vertical: boolean) => {
    const degrees = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    return Math.abs(vertical ? Math.abs(degrees) - 90 : degrees > 90 ? 180 - degrees : degrees < -90 ? -180 - degrees : degrees);
  };
  const sides = [tilt(tl, tr, false), tilt(bl, br, false), tilt(tl, bl, true), tilt(tr, br, true)];
  if (sides.some((t) => Math.abs(t) > SQUARE_DEGREES)) return null;
  const across = distance(tl, tr) / distance(bl, br), down = distance(tl, bl) / distance(tr, br);
  if (Math.abs(1 - across) > SQUARE_SIDES || Math.abs(1 - down) > SQUARE_SIDES) return null;
  const left = Math.max(0, Math.round((tl.x + bl.x) / 2)), right = Math.min(width, Math.round((tr.x + br.x) / 2));
  const top = Math.max(0, Math.round((tl.y + tr.y) / 2)), bottom = Math.min(height, Math.round((bl.y + br.y) / 2));
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The flattened page's size: as long as its longer opposite sides, so no
 * part of it is shrunk, scaled down to `longSide` at most. */
export function flatSize(quad: Quad, longSide: number) {
  const [tl, tr, br, bl] = quad;
  const width = Math.max(distance(tl, tr), distance(bl, br));
  const height = Math.max(distance(tl, bl), distance(tr, br));
  const scale = Math.min(1, longSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The part of `src` inside `quad`, redrawn as a `width` x `height`
 * rectangle: each pixel read from where it lies on the photographed page,
 * from the 4 x 4 pixels around that spot (Catmull-Rom). Bicubic rather than
 * bilinear: a pixel landing between two others otherwise averages them, and a
 * staff line one pixel thick comes out two pixels at half its darkness. */
export function warp(src: Rgba, quad: Quad, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const h = homography(wholeFrame(width, height), quad);
  const out = new Uint8ClampedArray(width * height * 4);
  const { data, width: sw, height: sh } = src;
  const maxX = sw - 1, maxY = sh - 1;
  const wx = new Float64Array(4), wy = new Float64Array(4);
  const xs = new Int32Array(4), ys = new Int32Array(4);
  let o = 0;
  for (let v = 0; v < height; v++) {
    const cy = v + 0.5;
    // Along a row every term is linear in u, so step it rather than multiply.
    let nx = h[0] * 0.5 + h[1] * cy + h[2];
    let ny = h[3] * 0.5 + h[4] * cy + h[5];
    let nw = h[6] * 0.5 + h[7] * cy + h[8];
    for (let u = 0; u < width; u++) {
      const x = Math.min(maxX, Math.max(0, nx / nw - 0.5));
      const y = Math.min(maxY, Math.max(0, ny / nw - 0.5));
      const x0 = Math.floor(x), y0 = Math.floor(y);
      catmullRom(x - x0, wx);
      catmullRom(y - y0, wy);
      for (let i = 0; i < 4; i++) {
        xs[i] = Math.min(maxX, Math.max(0, x0 - 1 + i)) * 4;
        ys[i] = Math.min(maxY, Math.max(0, y0 - 1 + i)) * sw * 4;
      }
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < 4; j++) {
        const row = ys[j], wj = wy[j];
        for (let i = 0; i < 4; i++) {
          const p = row + xs[i], w = wj * wx[i];
          r += data[p] * w;
          g += data[p + 1] * w;
          b += data[p + 2] * w;
        }
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
      o += 4;
      nx += h[0];
      ny += h[3];
      nw += h[6];
    }
  }
  return out;
}

/** The weights of the four pixels around a point `t` of the way from the
 * second to the third. */
function catmullRom(t: number, w: Float64Array) {
  const t2 = t * t, t3 = t2 * t;
  w[0] = (-t3 + 2 * t2 - t) / 2;
  w[1] = (3 * t3 - 5 * t2 + 2) / 2;
  w[2] = (-3 * t3 + 4 * t2 + t) / 2;
  w[3] = (t3 - t2) / 2;
}

/** Paper made evenly white, in place: each pixel brightened by how much
 * darker than white the paper around it is. A lamp to one side or a page
 * curving into shadow otherwise leaves part of it grey enough to read as ink,
 * or its ink too faint to read at all. */
export function evenLighting(img: Rgba) {
  const { data, width, height } = img;
  // The paper's own brightness, on a coarse grid: the brightest pixel of each
  // cell is paper even where the cell is mostly ink, and the grid is then
  // spread and smoothed so a note cluster or a thick beam doesn't dip it.
  const cell = Math.max(1, Math.round(Math.max(width, height) / 160));
  const gw = Math.ceil(width / cell), gh = Math.ceil(height / cell);
  let grid: Float32Array = new Float32Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / cell) * gw;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const g = row + Math.floor(x / cell);
      if (l > grid[g]) grid[g] = l;
    }
  }
  grid = maxFilter(grid, gw, gh, 2);
  grid = boxBlur(boxBlur(grid, gw, gh, 3), gw, gh, 3);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(gy), y1 = Math.min(gh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(gw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(gx), x1 = Math.min(gw - 1, x0 + 1), fx = gx - x0;
      const top = grid[y0 * gw + x0] + (grid[y0 * gw + x1] - grid[y0 * gw + x0]) * fx;
      const bottom = grid[y1 * gw + x0] + (grid[y1 * gw + x1] - grid[y1 * gw + x0]) * fx;
      // Floored, so a nearly black patch isn't stretched into noise.
      const paper = Math.max(48, top + (bottom - top) * fy);
      const gain = 255 / paper;
      const i = (y * width + x) * 4;
      data[i] = data[i] * gain;
      data[i + 1] = data[i + 1] * gain;
      data[i + 2] = data[i + 2] * gain;
    }
  }
}

// ---- finding the page ----

/** Box blur of `radius`, twice: near enough a Gaussian to wash thin ink -
 * staff lines, stems - into the paper around it. */
function blur(gray: Gray, radius: number): Float32Array {
  const values = Float32Array.from(gray.data as ArrayLike<number>);
  return boxBlur(boxBlur(values, gray.width, gray.height, radius), gray.width, gray.height, radius);
}

function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const across = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let k = Math.max(0, x - radius); k <= Math.min(width - 1, x + radius); k++) { sum += src[y * width + k]; n++; }
      across[y * width + x] = sum / n;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0, n = 0;
      for (let k = Math.max(0, y - radius); k <= Math.min(height - 1, y + radius); k++) { sum += across[k * width + x]; n++; }
      out[y * width + x] = sum / n;
    }
  }
  return out;
}

function maxFilter(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let best = 0;
      for (let j = Math.max(0, y - radius); j <= Math.min(height - 1, y + radius); j++) {
        for (let k = Math.max(0, x - radius); k <= Math.min(width - 1, x + radius); k++) {
          if (src[j * width + k] > best) best = src[j * width + k];
        }
      }
      out[y * width + x] = best;
    }
  }
  return out;
}

/** The grey level that best splits the picture into a dark and a light part
 * (Otsu's method): here, paper from what it lies on. */
function otsu(values: Float32Array): number {
  const histogram = new Float64Array(256);
  for (const v of values) histogram[Math.min(255, Math.max(0, Math.round(v)))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let below = 0, belowSum = 0, best = 0, level = 128;
  for (let t = 0; t < 256; t++) {
    below += histogram[t];
    if (!below) continue;
    const above = total - below;
    if (!above) break;
    belowSum += t * histogram[t];
    const between = below * above * (belowSum / below - (sum - belowSum) / above) ** 2;
    if (between > best) { best = between; level = t; }
  }
  return level;
}

/** The largest connected region brighter than `level`: its size, and the
 * pixels on its outline - the outermost of each row and of each column, all a
 * convex hull or a fitted side needs. */
function largestRegion(values: Float32Array, width: number, height: number, level: number) {
  const label = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  let best = { id: 0, count: 0 };
  let id = 0;
  for (let start = 0; start < values.length; start++) {
    if (label[start] || values[start] <= level) continue;
    id++;
    let top = 0, count = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const i = stack[--top];
      count++;
      const x = i % width;
      if (x > 0 && !label[i - 1] && values[i - 1] > level) { label[i - 1] = id; stack[top++] = i - 1; }
      if (x < width - 1 && !label[i + 1] && values[i + 1] > level) { label[i + 1] = id; stack[top++] = i + 1; }
      if (i >= width && !label[i - width] && values[i - width] > level) { label[i - width] = id; stack[top++] = i - width; }
      if (i < values.length - width && !label[i + width] && values[i + width] > level) { label[i + width] = id; stack[top++] = i + width; }
    }
    if (count > best.count) best = { id, count };
  }
  if (!best.count) return null;
  const edge: Point[] = [];
  for (let y = 0; y < height; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < width; x++) {
      if (label[y * width + x] === best.id) { if (first < 0) first = x; last = x; }
    }
    if (first >= 0) edge.push({ x: first, y: y + 0.5 }, { x: last + 1, y: y + 0.5 });
  }
  for (let x = 0; x < width; x++) {
    let first = -1, last = -1;
    for (let y = 0; y < height; y++) {
      if (label[y * width + x] === best.id) { if (first < 0) first = y; last = y; }
    }
    if (first >= 0) edge.push({ x: x + 0.5, y: first }, { x: x + 0.5, y: last + 1 });
  }
  return { count: best.count, edge };
}

/** Andrew's monotone chain: the convex hull, clockwise on screen. */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [], upper: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** At most `most` of the hull's corners: the ones that bend it most, as the
 * largest quad needs only the hull's real corners to choose from. */
function simplify(hull: Point[], most: number): Point[] {
  let points = hull;
  while (points.length > most) {
    // Drop the point whose removal loses the least area.
    let weakest = 0, least = Infinity;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i - 1 + points.length) % points.length], b = points[i], c = points[(i + 1) % points.length];
      const loss = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
      if (loss < least) { least = loss; weakest = i; }
    }
    points = points.filter((_, i) => i !== weakest);
  }
  return points;
}

/** The four hull corners enclosing the most area. */
function largestQuad(points: Point[]): Quad | null {
  const n = points.length;
  if (n < 4) return null;
  let best: Point[] | null = null, most = 0;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          const quad = [points[a], points[b], points[c], points[d]];
          const area = polygonArea(quad);
          if (area > most) { most = area; best = quad; }
        }
      }
    }
  }
  return best && orderCorners(best);
}

/** Each side fitted to the outline points along it, and the corners moved to
 * where the fitted sides meet: a hull corner is often a page's corner rounded
 * off, dog-eared, or under a thumb, while its sides run straight. */
function refineSides(quad: Quad, edge: Point[], diagonal: number): Quad {
  const near = Math.max(2, diagonal * 0.015);
  const lines: { point: Point; dir: Point }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const length = distance(a, b);
    if (!length) return quad;
    const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
    // Points along the side, away from the corners, close to the line.
    const along = edge.filter((p) => {
      const t = (p.x - a.x) * dx + (p.y - a.y) * dy;
      const off = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx);
      return t > length * 0.1 && t < length * 0.9 && off < near;
    });
    lines.push(along.length >= 8 ? fitLine(along) : { point: a, dir: { x: dx, y: dy } });
  }
  const corners: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const meet = intersect(lines[(i + 3) % 4], lines[i]);
    // A fit that runs off somewhere strange keeps the hull's corner.
    corners.push(meet && distance(meet, quad[i]) < diagonal * 0.06 ? meet : quad[i]);
  }
  return corners as Quad;
}

/** The line through `points` that keeps them closest (total least squares). */
function fitLine(points: Point[]) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n, my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { point: { x: mx, y: my }, dir: { x: Math.cos(theta), y: Math.sin(theta) } };
}

function intersect(l1: { point: Point; dir: Point }, l2: { point: Point; dir: Point }): Point | null {
  const det = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((l2.point.x - l1.point.x) * l2.dir.y - (l2.point.y - l1.point.y) * l2.dir.x) / det;
  return { x: l1.point.x + t * l1.dir.x, y: l1.point.y + t * l1.dir.y };
}

function anglesPlausible(quad: Quad) {
  for (let i = 0; i < 4; i++) {
    const p = quad[i], a = quad[(i + 3) % 4], b = quad[(i + 1) % 4];
    const v1 = { x: a.x - p.x, y: a.y - p.y }, v2 = { x: b.x - p.x, y: b.y - p.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
    const degrees = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (degrees < MIN_ANGLE || degrees > MAX_ANGLE) return false;
  }
  // Convex: every turn the same way.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    const turn = Math.sign((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
    if (sign && turn !== sign) return false;
    sign = turn;
  }
  return true;
}

/** Mean brightness inside the quad less the mean of a band just outside it. */
function contrast(values: Float32Array, width: number, height: number, quad: Quad): number {
  const center = {
    x: quad.reduce((s, p) => s + p.x, 0) / 4,
    y: quad.reduce((s, p) => s + p.y, 0) / 4,
  };
  const grown = quad.map((p) => ({ x: center.x + (p.x - center.x) * 1.08, y: center.y + (p.y - center.y) * 1.08 }));
  const shrunk = quad.map((p) => ({ x: center.x + (p.x - center.x) * 0.92, y: center.y + (p.y - center.y) * 0.92 }));
  let inSum = 0, inN = 0, outSum = 0, outN = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (inside(shrunk, p)) { inSum += values[y * width + x]; inN++; }
      else if (inside(grown, p) && !inside(quad, p)) { outSum += values[y * width + x]; outN++; }
    }
  }
  // Nothing around it in view: the page runs off the photo on every side.
  if (!outN) return 0;
  return inSum / Math.max(1, inN) - outSum / outN;
}

function inside(polygon: Point[], p: Point) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

function polygonArea(points: Point[]) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Gaussian elimination with partial pivoting on an augmented n x (n+1) system. */
function solve(rows: number[][]): number[] {
  const n = rows.length;
  const m = rows.map((r) => [...r]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / p;
      if (!f) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((r, i) => r[n] / (m[i][i] || 1e-12));
}
