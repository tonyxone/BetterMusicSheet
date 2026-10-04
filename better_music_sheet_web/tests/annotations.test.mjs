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
    react: { useCallback: () => {}, useEffect: () => {}, useRef: () => ({}), useState: () => [], useSyncExternalStore: () => null },
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
const notation = load('lib/notation.ts');
const timelineLib = load('lib/timeline.ts');

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

test('a colour set on a name (by the iOS app) survives sanitizing and is drawn', () => {
  const doc = edits.sanitizeEdits({ labels: { L1: { color: '#C0392B' }, L2: { color: 'red', dx: 1 } } });
  assert.deepEqual({ ...doc.labels.L1 }, { color: '#C0392B' });
  assert.deepEqual({ ...doc.labels.L2 }, { dx: 1 });
  assert.equal(edits.resolveLabel(item, doc).color, '#C0392B');
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

test('a selection of names, notes and drawings moves together', () => {
  const before = {
    ...edits.EMPTY_EDITS,
    labels: { L1: { dx: 1, text: 'D' } },
    texts: [{ id: 't1', page: 1, x: 10, y: 20, text: 'hi', size: 10, color: '#000000' },
      { id: 't2', page: 1, x: 50, y: 50, text: 'stay', size: 10, color: '#000000' }],
    strokes: [{ id: 's1', page: 2, tool: 'pen', color: '#000000', width: 1, points: [0, 0, 4, 4] }],
  };
  const moved = edits.moveItems(before, [
    { kind: 'label', id: 'L1' }, { kind: 'label', id: 'L2' },
    { kind: 'text', id: 't1' }, { kind: 'stroke', id: 's1' },
  ], 2, -3);
  assert.deepEqual({ ...moved.labels.L1 }, { dx: 3, dy: -3, text: 'D' });
  assert.deepEqual({ ...moved.labels.L2 }, { dx: 2, dy: -3 });
  assert.equal(moved.texts[0].x, 12);
  assert.equal(moved.texts[0].y, 17);
  assert.equal(moved.texts[1].x, 50);
  assert.deepEqual(Array.from(moved.strokes[0].points), [2, -3, 6, 1]);
  // The state it started from is left alone, so undo can return to it.
  assert.equal(before.texts[0].x, 10);
});

test('numbered notation is fixed-do: 1 is always C', () => {
  assert.deepEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B'].map((t) => notation.toNumbered(t)),
    ['1', '2', '3', '4', '5', '6', '7']);
  // Clair de Lune, in D flat major, reads by the keys played - not 1 = D♭.
  assert.deepEqual(['D♭', 'E♭', 'F', 'G♭', 'A♭', 'B♭', 'C'].map((t) => notation.toNumbered(t)),
    ['♭2', '♭3', '4', '♭5', '♭6', '♭7', '1']);
  // A black key keeps its printed sharp or flat.
  assert.equal(notation.toNumbered('F♯'), '♯4');
  assert.equal(notation.toNumbered('G♭'), '♭5');
  // A white key reads as its own number however it is spelled.
  assert.equal(notation.toNumbered('E♯'), '4');
  assert.equal(notation.toNumbered('C♭'), '7');
  assert.equal(notation.toNumbered('B♯'), '1');
  assert.equal(notation.toNumbered('C𝄪'), '2');
  // A double flat on a black key takes a single one.
  assert.equal(notation.toNumbered('F𝄫'), '♭3');
  assert.equal(notation.toNumbered('B𝄪'), '♯1');
  // ASCII labels stay ASCII; octaves drop; the uncertainty mark stays.
  assert.equal(notation.toNumbered('Bb4'), 'b7');
  assert.equal(notation.toNumbered('C#?'), '#1?');
  // Anything that isn't a note name is left as it is.
  assert.equal(notation.toNumbered('rit.'), 'rit.');
});

test('solfège is fixed-do too: do is always C', () => {
  assert.deepEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B'].map((t) => notation.toSolfege(t)),
    ['do', 're', 'mi', 'fa', 'so', 'la', 'si']);
  assert.deepEqual(['D♭', 'E♭', 'F', 'G♭', 'A♭', 'B♭', 'C'].map((t) => notation.toSolfege(t)),
    ['♭re', '♭mi', 'fa', '♭so', '♭la', '♭si', 'do']);
  assert.equal(notation.toSolfege('F♯'), '♯fa');
  assert.equal(notation.toSolfege('G♭'), '♭so');
  assert.equal(notation.toSolfege('E♯'), 'fa');
  assert.equal(notation.toSolfege('C♭'), 'si');
  assert.equal(notation.toSolfege('F𝄫'), '♭mi');
  assert.equal(notation.toSolfege('Bb4'), 'bsi');
  assert.equal(notation.toSolfege('C#?'), '#do?');
  assert.equal(notation.toSolfege('rit.'), 'rit.');
});

test('every letter round-trips through its number to the same piano key', () => {
  const pc = (text) => { const p = labels.parseNoteName(text); return (([0, 2, 4, 5, 7, 9, 11][p.step] + p.alter) % 12 + 12) % 12; };
  for (const letter of 'CDEFGAB') {
    for (const acc of ['𝄫', '♭', '', '♯', '𝄪']) {
      const name = letter + acc;
      const number = notation.toNumbered(name);
      const back = notation.fromNumbered(number, 'X');
      assert.notEqual(back, null, name);
      assert.doesNotMatch(number, /𝄪|𝄫/u, name);
      assert.equal(notation.toNumbered(back), number, name);
      assert.equal(pc(back), pc(name), name);

      const syllable = notation.toSolfege(name);
      const backSolfege = notation.fromSolfege(syllable, 'X');
      assert.notEqual(backSolfege, null, name);
      assert.equal(notation.toSolfege(backSolfege), syllable, name);
      assert.equal(pc(backSolfege), pc(name), name);
    }
  }
});

test('a typed number becomes the letter it means', () => {
  assert.equal(notation.fromNumbered('#4', 'G'), 'F♯');
  assert.equal(notation.fromNumbered('b7', 'G'), 'B♭');
  assert.equal(notation.fromNumbered('4', 'Bb'), 'F');
  // The printed note keeps its printed text, octave and all - also when it
  // is spelled another way than the number (E♯ reads as 4).
  assert.equal(notation.fromNumbered('5', 'G4'), 'G4');
  assert.equal(notation.fromNumbered('4', 'E♯'), 'E♯');
  assert.equal(notation.fromNumbered('F#', 'G'), null);
});

test('a typed solfège syllable becomes the letter it means', () => {
  assert.equal(notation.fromSolfege('#fa', 'G'), 'F♯');
  assert.equal(notation.fromSolfege('bsi', 'G'), 'B♭');
  assert.equal(notation.fromSolfege('fa', 'Bb'), 'F');
  assert.equal(notation.fromSolfege('so', 'G4'), 'G4');
  assert.equal(notation.fromSolfege('fa', 'E♯'), 'E♯');
  assert.equal(notation.fromSolfege('Do', 'C'), 'C');
  assert.equal(notation.fromSolfege('F#', 'G'), null);
});

test('labels read as numbers or solfège, and edits stay letters', () => {
  const item = { id: 'L1', group: 'g', page: 1, x: 0, y: 0, size: 6, text: 'F♯', notes: [] };
  const doc = { ...edits.EMPTY_EDITS, labels: { L1: { text: 'F' } } };
  assert.equal(edits.resolveLabel(item, edits.EMPTY_EDITS, 'numbers').text, '♯4');
  assert.equal(edits.resolveLabel(item, doc, 'numbers').text, '4');
  assert.equal(edits.resolveLabel(item, edits.EMPTY_EDITS, 'solfege').text, '♯fa');
  assert.equal(edits.resolveLabel(item, doc, 'solfege').text, 'fa');
  assert.equal(edits.resolveLabel(item, doc, 'letters').text, 'F');
});

test('falling notes are named as written, or from the pitch once corrected', () => {
  const note = { midi: 66, step: 'F', alter: 1, octave: 4, key_fifths: 1 };
  assert.equal(notation.timelineNoteName(note, 'letters'), 'F♯');
  assert.equal(notation.timelineNoteName(note, 'numbers'), '♯4');
  assert.equal(notation.timelineNoteName(note, 'solfege'), '♯fa');
  // Spelled as written even where the pitch has another name.
  assert.equal(notation.timelineNoteName({ midi: 63, step: 'D', alter: 1, key_fifths: -4 }, 'letters'), 'D♯');
  assert.equal(notation.timelineNoteName({ midi: 63, step: 'D', alter: 1, key_fifths: -4 }, 'numbers'), '♯2');
  // A reader's correction changes the pitch but not the old spelling: then
  // the pitch decides, with flats in a flat key.
  assert.equal(notation.timelineNoteName({ ...note, midi: 68, key_fifths: -4 }, 'letters'), 'A♭');
  assert.equal(notation.timelineNoteName({ ...note, midi: 68 }, 'letters'), 'G♯');
  assert.equal(notation.timelineNoteName({ midi: 60 }, 'numbers'), '1');
  assert.equal(notation.timelineNoteName({ midi: 60 }, 'solfege'), 'do');
});

test('a falling note is named once, across its tied pieces', () => {
  const n = (midi, start, duration, extra = {}) => ({ midi, start_beat: start, duration_beats: duration, is_grace: false, ...extra });
  const notes = [
    n(75, 0, 2), n(63, 0, 0.5), n(63, 0, 0.5), // a second voice on the same key
    n(63, 1, 0.5), // struck again: named again
    n(75, 2, 2, { tie_stop: true }), n(75, 4, 1, { tie_stop: true }), // tied on
    n(75, 5, 1), // a new strike right after the tie ends
  ];
  assert.deepEqual(Array.from(timelineLib.nameSpans(notes, 0.12)), [5, 0.5, -1, 1.5, -1, -1, 6]);
});

test('an unnamed note stops being flagged once the reader writes a name beside it', () => {
  const unnamed = [{ page: 1, x: 100, y: 50, w: 6 }, { page: 1, x: 200, y: 50, w: 6 }, { page: 2, x: 100, y: 50, w: 6 }];
  // Where "Add name" puts a note: just right of the head, on a baseline
  // that centres it on the head.
  const named = { page: 1, x: 104.2, y: 52.3, size: 6.5 };
  assert.deepEqual(Array.from(labels.stillUnnamed(unnamed, [named]), (u) => `${u.page}@${u.x}`), ['1@200', '2@100']);
  // A note elsewhere - another page, another staff, far along - names nothing.
  const elsewhere = [{ page: 2, x: 104, y: 90, size: 6.5 }, { page: 1, x: 150, y: 50, size: 6.5 }];
  assert.equal(labels.stillUnnamed(unnamed, elsewhere).length, 3);
});

test('naming one note of a chord leaves the rest of the chord ringed', () => {
  // Three heads a staff step apart, as in a whole-note chord.
  const chord = [{ page: 1, x: 100, y: 45.5, w: 6 }, { page: 1, x: 100, y: 50, w: 6 }, { page: 1, x: 100, y: 54.5, w: 6 }];
  const middle = { page: 1, x: 104.2, y: 50 + 6.5 * 0.35, size: 6.5 };
  assert.deepEqual(Array.from(labels.stillUnnamed(chord, [middle]), (u) => u.y), [45.5, 54.5]);
  const lowest = { page: 1, x: 104.2, y: 54.5 + 6.5 * 0.35, size: 6.5 };
  assert.deepEqual(Array.from(labels.stillUnnamed(chord, [middle, lowest]), (u) => u.y), [45.5]);
});
