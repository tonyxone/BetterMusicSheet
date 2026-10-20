import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// The meter's arithmetic, from its TypeScript source; the hook that drives it
// needs a browser and isn't run here.
function load() {
  const source = fs.readFileSync(new URL('../lib/usage.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({}) });
  return exports;
}

const { UsageMeter, IDLE_MS, REPEAT_MS } = load();

/** A report as this realm's plain objects: the module runs in its own. */
const plain = (report) => JSON.parse(JSON.stringify(report));

/** A meter after `seconds` one-second ticks from `start`. */
function run(meter, start, seconds, { visible = true, playing = false } = {}) {
  for (let i = 1; i <= seconds; i++) meter.tick(start + i * 1000, visible, playing);
  return start + seconds * 1000;
}

test('nothing happened, nothing to report', () => {
  assert.equal(new UsageMeter(0).take(), null);
});

test('visible and touched lately counts; hidden does not', () => {
  const meter = new UsageMeter(0);
  const now = run(meter, 0, 30);
  run(meter, now, 20, { visible: false });
  assert.deepEqual(plain(meter.take()), { seconds: 30, playing_seconds: 0, events: {} });
  assert.equal(meter.take(), null);
});

test('an untouched page stops counting once idle, unless it is playing', () => {
  const meter = new UsageMeter(0);
  const idle = IDLE_MS / 1000;
  let now = run(meter, 0, idle + 60);
  assert.equal(meter.take().seconds, idle);
  now = run(meter, now, 45, { playing: true });
  assert.deepEqual(plain(meter.take()), { seconds: 45, playing_seconds: 45, events: {} });
  // A touch brings it back.
  meter.input(now);
  run(meter, now, 10);
  assert.equal(meter.take().seconds, 10);
});

test('a long gap between ticks counts only a few seconds', () => {
  const meter = new UsageMeter(0);
  meter.tick(60 * 60 * 1000, true, true);
  assert.equal(meter.take().seconds, 5);
});

test('a control used again straight away counts once', () => {
  const meter = new UsageMeter(0);
  meter.count('speed', 100);
  meter.count('speed', 200);
  meter.count('speed', 100 + REPEAT_MS + 1);
  meter.count('play', 300);
  assert.deepEqual(plain(meter.take()).events, { speed: 2, play: 1 });
});

test('part seconds wait for the next report', () => {
  const meter = new UsageMeter(0);
  meter.tick(1500, true, false);
  assert.equal(meter.take().seconds, 1);
  meter.tick(2000, true, false);
  assert.equal(meter.take().seconds, 1);
});

test('a report that failed goes with the next one, within what the API accepts', () => {
  const meter = new UsageMeter(0);
  let now = run(meter, 0, 40, { playing: true });
  meter.count('play', now);
  const failed = meter.take();
  now = run(meter, now, 20);
  meter.restore(failed);
  assert.deepEqual(plain(meter.take()), { seconds: 60, playing_seconds: 40, events: { play: 1 } });
  // Held over for long enough, it is capped rather than refused.
  meter.restore({ seconds: 500, playing_seconds: 0, events: {} });
  meter.restore({ seconds: 500, playing_seconds: 0, events: {} });
  assert.equal(meter.take().seconds, 600);
});
