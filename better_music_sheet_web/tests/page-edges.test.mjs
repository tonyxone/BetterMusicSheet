import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Finding and flattening a photographed page, from lib/page-edges.ts.
function load() {
  const source = fs.readFileSync(new URL('../lib/page-edges.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports });
  return exports;
}

const edges = load();
const near = (a, b, tolerance, label) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= tolerance,
  `${label}: (${a.x.toFixed(1)}, ${a.y.toFixed(1)}) is not within ${tolerance} of (${b.x}, ${b.y})`);

function inside(polygon, x, y) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

/** A photo, in grey: a pale page with staves on it, in perspective on a dark
 * table, lit more on one side than the other. */
function photo(width, height, corners) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 60 + ((x * 7 + y * 13) % 11);
      if (inside(corners, x + 0.5, y + 0.5)) {
        // Where on the page this is, to draw staves at fixed places on it.
        const inv = edges.homography(corners, edges.wholeFrame(1, 1));
        const p = edges.project(inv, { x: x + 0.5, y: y + 0.5 });
        const onStaff = p.x > 0.1 && p.x < 0.9 && [0.2, 0.4, 0.6, 0.8].some((s) =>
          [0, 1, 2, 3, 4].some((line) => Math.abs(p.y - (s + line * 0.012)) < 0.002));
        v = onStaff ? 90 : 215 - 40 * (x / width);
      }
      data[y * width + x] = v;
    }
  }
  return { data, width, height };
}

const TILTED = [{ x: 70, y: 60 }, { x: 250, y: 45 }, { x: 275, y: 370 }, { x: 40, y: 385 }];

test('finds the corners of a page photographed at an angle', () => {
  const quad = edges.findPage(photo(320, 420, TILTED));
  assert.ok(quad, 'a page');
  quad.forEach((p, i) => near(p, TILTED[i], 4, ['top left', 'top right', 'bottom right', 'bottom left'][i]));
});

test('finds no page where nothing stands out', () => {
  const flat = { data: new Uint8Array(320 * 420).fill(200), width: 320, height: 420 };
  assert.equal(edges.findPage(flat), null);
  // A page filling the whole photo has no edges in view to cut to.
  assert.equal(edges.findPage(photo(320, 420, edges.wholeFrame(320, 420))), null);
});

test('corners come out top left first, clockwise, whichever way the page lies', () => {
  const portrait = [{ x: 10, y: 0 }, { x: 100, y: 5 }, { x: 95, y: 200 }, { x: 0, y: 190 }];
  const landscape = [{ x: 0, y: 20 }, { x: 400, y: 0 }, { x: 410, y: 150 }, { x: 5, y: 160 }];
  for (const quad of [portrait, landscape]) {
    const shuffled = [quad[2], quad[0], quad[3], quad[1]];
    assert.deepEqual(JSON.parse(JSON.stringify(edges.orderCorners(shuffled))), quad);
  }
});

test('the projective map takes each corner to its place', () => {
  const h = edges.homography(edges.wholeFrame(100, 140), TILTED);
  edges.wholeFrame(100, 140).forEach((p, i) => near(edges.project(h, p), TILTED[i], 1e-6, `corner ${i}`));
});

test('flattening redraws the page as a rectangle', () => {
  // Four colours, one a quarter of the page, photographed tilted.
  const width = 300, height = 400;
  const src = new Uint8ClampedArray(width * height * 4);
  const inv = edges.homography(TILTED, edges.wholeFrame(1, 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = edges.project(inv, { x: x + 0.5, y: y + 0.5 });
      const i = (y * width + x) * 4;
      src[i] = p.x < 0.5 ? 250 : 10;
      src[i + 1] = p.y < 0.5 ? 250 : 10;
      src[i + 3] = 255;
    }
  }
  const out = edges.warp({ data: src, width, height }, TILTED, 100, 140);
  const at = (x, y) => [out[(y * 100 + x) * 4], out[(y * 100 + x) * 4 + 1]];
  assert.deepEqual(at(20, 20), [250, 250]);
  assert.deepEqual(at(80, 20), [10, 250]);
  assert.deepEqual(at(80, 120), [10, 10]);
  assert.deepEqual(at(20, 120), [250, 10]);
});

test('a straight page is only cut out; a tilted one needs flattening', () => {
  const straight = [{ x: 40, y: 30 }, { x: 960.4, y: 33 }, { x: 958, y: 1300 }, { x: 41, y: 1297 }];
  assert.deepEqual({ ...edges.squareCrop(straight, 1000, 1400) }, { x: 41, y: 32, width: 918, height: 1267 });
  assert.equal(edges.squareCrop(TILTED, 320, 420), null);
  // Keystoned: the sides lean in the same amount each way.
  const keystone = [{ x: 60, y: 30 }, { x: 940, y: 30 }, { x: 990, y: 1300 }, { x: 10, y: 1300 }];
  assert.equal(edges.squareCrop(keystone, 1000, 1400), null);
});

test('the flattened size keeps the longer sides, within the limit', () => {
  assert.deepEqual({ ...edges.flatSize(TILTED, 5000) }, { width: 235, height: 326 });
  const capped = edges.flatSize(TILTED, 163);
  assert.equal(Math.max(capped.width, capped.height), 163);
});

test('even lighting brings paper on the dim side up to the bright side', () => {
  const width = 200, height = 100;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Paper from 130 to 230 left to right, with a line of ink across it.
      const v = y === 50 ? 40 : 130 + x / 2;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  edges.evenLighting({ data, width, height });
  const paperLeft = data[(20 * width + 10) * 4], paperRight = data[(20 * width + 190) * 4];
  assert.ok(Math.abs(paperLeft - paperRight) < 15, `paper ${paperLeft} vs ${paperRight}`);
  assert.ok(data[(50 * width + 10) * 4] < 100, 'the ink stays dark');
});
