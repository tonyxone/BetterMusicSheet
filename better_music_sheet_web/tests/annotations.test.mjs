import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The editor's pure logic, run from its TypeScript source. Browser-only
// imports (React, the API client, pdf.js) are stubbed: nothing tested here
// touches them.
function load(entry) {
  const cache = new Map();
  const external = {
    react: { useCallback: () => {}, useEffect: () => {}, useRef: () => ({}), useState: () => [] },
    './client-api': { clientApiFetch: async () => { throw new Error('no network in tests'); } },
    './sheet-files': { fetchSheetAssets: async () => null, fetchSheetFile: async () => null },
    './pdfjs': { openPdf: async () => { throw new Error('no pdf.js in tests'); } },
  };
  function require(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const exports = {};
    cache.set(filename, exports);
    const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(js, {
      exports,
      require: (id) => external[id] ?? require(path.resolve(path.dirname(filename), id + '.ts')),
      console,
    });
    return exports;
  }
  return require(path.resolve(__dirname, '..', entry));
}

const labels = load('lib/labels.ts');
const edits = load('lib/edits.ts');
const ink = load('lib/ink.ts');

test('note names parse with either accidental spelling and an optional octave', () => {
  assert.deepEqual({ ...labels.parseNoteName('B♭') }, { step: 6, alter: -1, octave: null });
  assert.deepEqual({ ...labels.parseNoteName('c#4') }, { step: 0, alter: 1, octave: 4 });
  assert.deepEqual({ ...labels.parseNoteName('F𝄪') }, { step: 3, alter: 2, octave: null });
  assert.deepEqual({ ...labels.parseNoteName('G?') }, { step: 4, alter: 0, octave: null });
  assert.equal(labels.parseNoteName('hello'), null);
  assert.equal(labels.parseNoteName(''), null);
});

test('a retyped name moves to the nearest staff position, not across the octave', () => {
  // B3 retyped as C: up one step to C4, not down to C3.
  assert.equal(labels.retypedMidi('C', 'B', 59), 60);
  // C4 retyped as B: down one step to B3.
  assert.equal(labels.retypedMidi('B', 'C', 60), 59);
  // E4 -> E♭4, same letter.
  assert.equal(labels.retypedMidi('E♭', 'E', 64), 63);
  // Printed F♯4 (66) retyped as G♭: the next letter up, same sound.
  assert.equal(labels.retypedMidi('G♭', 'F♯', 66), 66);
  // An explicit octave wins.
  assert.equal(labels.retypedMidi('A2', 'C', 60), 45);
  assert.equal(labels.retypedMidi('xyz', 'C', 60), null);
});

const timeline = {
  measures: [{ index: 0, start_beat: 4, length_beats: 4 }],
  notes: [
    { printed_id: 'n1', source_id: 's1', measure_index: 0, midi: 60, start_beat: 5, duration_beats: 1, hand: 'right' },
    // The same printed note, heard again on a repeat.
    { printed_id: 'n1', source_id: 's1b', measure_index: 0, midi: 60, start_beat: 13, duration_beats: 1, hand: 'right' },
  ],
};
const item = { id: 'L1', group: 'L1', page: 1, x: 0, y: 0, size: 6.5, text: 'C', notes: ['n1'] };

test('retyping a linked name writes a playback correction keeping timing and hand', () => {
  const result = edits.correctionsForRetype(item, 'D', timeline, {});
  assert.equal(result.linked, true);
  assert.equal(result.changed, 1);
  assert.deepEqual({ ...result.corrections.n1 }, { midi: 62, hand: 'right', offset: 1, duration: 1 });
});

test('retyping back to the printed name removes the correction again', () => {
  const corrected = edits.correctionsForRetype(item, 'D', timeline, {}).corrections;
  const back = edits.correctionsForRetype(item, 'C', timeline, corrected);
  assert.equal(back.corrections.n1, undefined);
});

test('text that is not a note name leaves playback alone', () => {
  assert.equal(edits.correctionsForRetype(item, 'slow', timeline, {}), null);
  const unlinked = edits.correctionsForRetype({ ...item, notes: [] }, 'D', timeline, {});
  assert.equal(unlinked.linked, false);
});

test('stored edits are sanitized entry by entry', () => {
  const doc = edits.sanitizeEdits({
    version: 1,
    labels: { a: { dx: 2, dy: 'x', text: 'D' }, b: { nonsense: true }, c: { hidden: true } },
    texts: [{ id: 't', page: 1, x: 1, y: 2, text: 'hi', size: 10, color: '#112233' }, { id: 'bad' }],
    strokes: [{ id: 's', page: 1, tool: 'pen', color: '#000000', width: 1, points: [0, 0, 1, 1] },
      { id: 's2', page: 1, tool: 'laser', color: '#000000', width: 1, points: [0, 0] }],
    corrections: { n1: { midi: 62, hand: null, offset: 0, duration: 1 }, n2: { midi: 999 } },
  });
  assert.deepEqual(Object.keys(doc.labels).sort(), ['a', 'c']);
  assert.deepEqual({ ...doc.labels.a }, { dx: 2, text: 'D' });
  assert.equal(doc.texts.length, 1);
  assert.equal(doc.strokes.length, 1);
  assert.deepEqual(Object.keys(doc.corrections), ['n1']);
  assert.equal(edits.sanitizeEdits(null).version, 1);
});

test('a label resolves to its moved, retyped or hidden form', () => {
  const doc = { ...edits.EMPTY_EDITS, labels: { L1: { dx: 3, dy: -1, text: 'D' } } };
  const moved = edits.resolveLabel({ ...item, x: 10, y: 20 }, doc);
  assert.equal(moved.x, 13);
  assert.equal(moved.y, 19);
  assert.equal(moved.text, 'D');
  assert.equal(edits.resolveLabel(item, { ...doc, labels: { L1: { hidden: true } } }), null);
});

test('stroke thinning keeps the ends and the corners', () => {
  const line = [];
  for (let i = 0; i <= 50; i++) line.push(i, 0);
  for (let i = 1; i <= 50; i++) line.push(50, i);
  const thin = ink.simplify(line);
  assert.deepEqual(Array.from(thin), [0, 0, 50, 0, 50, 50]);
  assert.match(ink.strokePath(thin), /^M 0 0 Q 50 0 50 25 L 50 50$/);
});
