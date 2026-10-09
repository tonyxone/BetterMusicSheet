import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load() {
  const source = fs.readFileSync(new URL('../lib/names-progress.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({}) });
  return exports;
}

const { namesStage, namesProgress } = load();

test('stages fill the bar in the order a sheet goes through them', () => {
  const order = ['Uploading sheet', 'Waiting for a recognition worker', 'Reading sheet music · about 1 min',
    'Re-reading unclear pages · 2 pages · thanks for your patience', 'Matching pitches to notes',
    'Building playback timeline · 16 measures, 244 notes', 'Drawing the annotated sheet', 'Complete'];
  const starts = order.map((stage) => namesStage(stage).start);
  assert.deepEqual([...starts].sort((a, b) => a - b), starts);
  assert.equal(namesProgress(namesStage('Complete'), 0), 1);
});

test('each page of a long sheet gets its own slice of reading', () => {
  const first = namesStage('Reading sheet music (page 1 of 4) · about 3 min · 1,200 notes to read');
  const third = namesStage('Reading sheet music (page 3 of 4) · about 3 min');
  const whole = namesStage('Reading sheet music');
  assert.equal(first.start, whole.start);
  assert.ok(third.start > first.end - 1e-9);
  assert.ok(Math.abs(third.end - (whole.start + (whole.end - whole.start) * 0.75)) < 1e-9);
  assert.notEqual(first.key, third.key);
});

test('the bar creeps on within a stage but never reaches the next one', () => {
  const stage = namesStage('Matching pitches to notes');
  const now = namesProgress(stage, 0);
  const later = namesProgress(stage, 20);
  const much_later = namesProgress(stage, 3600);
  assert.equal(now, stage.start);
  assert.ok(later > now && much_later > later);
  assert.ok(much_later < stage.end);
});

test('a missing or unfamiliar stage counts as waiting to start', () => {
  assert.equal(namesStage(null).start, namesStage('Waiting for a recognition worker').start);
  assert.equal(namesStage('Something new').start, namesStage('Waiting for a recognition worker').start);
});
