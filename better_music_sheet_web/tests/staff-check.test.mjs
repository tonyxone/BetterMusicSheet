import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// The measurement only; reading the reader's files needs a browser. Tuned
// against past uploads: every page recognition read finds a staff, and the
// photos it found none on - glare, a tilted book, a note-quiz screenshot -
// find none here either.
function load() {
  const source = fs.readFileSync(new URL('../lib/staff-check.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({}) });
  return exports;
}

const { findStaves } = load();

/** A white page, drawn on with dark rules: each [y, left, right, thickness]. */
function page(width, height, draw) {
  const gray = new Uint8Array(width * height).fill(250);
  const rule = (y, left, right, thickness = 2, ink = 30) => {
    for (let x = Math.round(left); x < right; x++) {
      for (let k = 0; k < thickness; k++) {
        const row = Math.round(y + k);
        if (row >= 0 && row < height) gray[row * width + x] = ink;
      }
    }
  };
  draw(rule, gray);
  return { gray, width, height };
}

/** Staves of five lines, `gap` apart, across most of the page. */
function staves(rule, { width, tops, gap, tilt = 0, ink }) {
  for (const top of tops) {
    for (let line = 0; line < 5; line++) {
      // Drawn in short pieces so a tilt moves each one a little lower.
      for (let x = width * 0.08; x < width * 0.92; x += 8) {
        rule(top + line * gap + (x - width * 0.08) * tilt, x, Math.min(x + 8, width * 0.92), 2, ink);
      }
    }
  }
}

const run = ({ gray, width, height }) => findStaves(gray, width, height);

test('finds every staff on a printed page, and the gap between its lines', () => {
  const result = run(page(1200, 1700, (rule) =>
    staves(rule, { width: 1200, tops: [150, 400, 650, 900, 1150], gap: 10 })));
  assert.equal(result.staves.length, 5);
  assert.equal(result.interline, 10);
});

test('finds staves on a photo taken slightly tilted', () => {
  const result = run(page(1600, 1200, (rule) =>
    staves(rule, { width: 1600, tops: [200, 500, 800], gap: 12, tilt: Math.tan((2 * Math.PI) / 180) })));
  assert.equal(result.staves.length, 3);
});

test('finds faint gray staff lines', () => {
  const result = run(page(1200, 900, (rule) =>
    staves(rule, { width: 1200, tops: [200, 500], gap: 9, ink: 170 })));
  assert.equal(result.staves.length, 2);
});

test('finds a staff whose rows are crowded with noteheads between the lines', () => {
  const result = run(page(1170, 222, (rule) => {
    staves(rule, { width: 1170, tops: [150], gap: 7 });
    // A run of sixteenths in one space: its rows come out as dark as a
    // line would at a lenient reading, joining the lines either side.
    for (let x = 100; x < 1080; x += 14) rule(165, x, x + 10, 5);
  }));
  assert.equal(result.staves.length, 1);
});

test('a blank page has no staff', () => {
  assert.equal(run(page(1200, 1700, () => {})).staves.length, 0);
});

test('lined paper is not a staff, however even its rules are', () => {
  const result = run(page(1200, 1700, (rule) => {
    for (let y = 150; y < 1650; y += 40) rule(y, 80, 1120);
  }));
  assert.equal(result.staves.length, 0);
  assert.equal(result.interline, null);
});

test('a staff blown up to fill the screen - a few notes, not a sheet - does not count', () => {
  const result = run(page(1800, 2400, (rule) =>
    staves(rule, { width: 1800, tops: [900], gap: 70 })));
  assert.equal(result.staves.length, 0);
});

test('a short rule pattern in one corner is not a staff across the page', () => {
  const result = run(page(1200, 1700, (rule) => {
    for (let line = 0; line < 5; line++) rule(300 + line * 10, 100, 250);
  }));
  assert.equal(result.staves.length, 0);
});
