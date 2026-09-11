import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Execute the actual TypeScript against a deterministic audio clock. No
// browser/audio device is needed, and no copy of player logic lives here.
function modules(external = {}) {
  const cache = new Map();
  const frames = new Map();
  let frameId = 0;
  function load(filename) {
    filename = path.resolve(__dirname, '..', filename);
    if (cache.has(filename)) return cache.get(filename);
    const exports = {};
    cache.set(filename, exports);
    const source = fs.readFileSync(filename, 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext(js, {
      exports,
      require: (id) => external[id] ?? load(id.startsWith('@/') ? id.slice(2) + '.ts' : path.resolve(path.dirname(filename), id + '.ts')),
      setInterval: () => 1, clearInterval() {},
      requestAnimationFrame: (f) => { frames.set(++frameId, f); return frameId; },
      cancelAnimationFrame: (id) => frames.delete(id),
    }, { filename });
    return exports;
  }
  return { load, frame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((f) => f()); } };
}

const note = (start, duration, midi = 60, extra = {}) => ({ source_id: `${start}:${midi}`, start_beat: start, duration_beats: duration,
  midi, role: 0, measure_index: 0, is_grace: false, bbox_pt: null, ...extra });

function sampleEngine() {
  const instruments = [];
  const create = () => {
    let resolve, reject;
    const ready = new Promise((a,b) => { resolve=a; reject=b; });
    const instrument = { ready, resolve, reject, calls:[], disposed:false, stopped:0,
      start(event) { this.calls.push(event); }, stop() { this.stopped++; }, dispose() { this.disposed=true; } };
    instruments.push(instrument); return instrument;
  };
  const lib = { SplendidGrandPiano:create, ElectricPiano:create, Soundfont:create,
    HttpStorage:{fetch(){}}, CacheStorage:()=>({fetch(){}}) };
  const { SynthEngine } = modules({smplr:lib}).load('app/play/synth.ts');
  const param = () => ({value:0,setTargetAtTime(){}});
  const node = () => ({gain:param(),threshold:param(),knee:param(),ratio:param(),connect(){},disconnect(){}});
  const engine = new SynthEngine({currentTime:0,createGain:node,createDynamicsCompressor:node,destination:{}});
  return {engine,instruments};
}

test('sample loading waits for readiness and gives repeated pitches distinct voices', async () => {
  const {engine,instruments} = sampleEngine();
  const ready=engine.load('grand',[60]); await new Promise(setImmediate);
  assert.equal(engine.instrumentId,'basic');
  instruments[0].resolve(); await ready;
  assert.equal(engine.instrumentId,'grand');
  engine.noteOn(60,1,2,40); engine.noteOn(60,1.5,3,100);
  assert.notEqual(instruments[0].calls[0].stopId,instruments[0].calls[1].stopId);
  assert.equal(instruments[0].calls[1].duration,1.5);
  assert.equal(instruments[0].calls[0].velocity,40);
  engine.dispose(); assert.equal(instruments[0].disposed,true);
});

test('fractional recognition velocity is normalized across piano sample-layer boundaries', async () => {
  const {engine,instruments}=sampleEngine();
  const ready=engine.load('grand',[42]); await new Promise(setImmediate);
  instruments[0].resolve(); await ready;
  engine.noteOn(42,1,2,100.666666666667);
  assert.equal(instruments[0].calls[0].velocity,101);
  engine.dispose();
});

test('a stale instrument load cannot replace a newer selection', async () => {
  const {engine,instruments} = sampleEngine();
  const first=engine.load('grand',[60]); await new Promise(setImmediate);
  const second=engine.load('electric',[60]); await new Promise(setImmediate);
  instruments[1].resolve(); await second;
  instruments[0].resolve(); await first;
  assert.equal(engine.instrumentId,'electric');
  assert.equal(instruments[0].disposed,true);
  engine.dispose();
});

test('failed samples can be retried or replaced with the offline preset', async () => {
  const {engine,instruments} = sampleEngine();
  const first=engine.load('grand',[60]); await new Promise(setImmediate);
  instruments[0].reject(new Error('network')); await assert.rejects(first);
  const retry=engine.load('grand',[60]); await new Promise(setImmediate);
  instruments[1].resolve(); await retry;
  await engine.load('basic',[60]);
  assert.equal(engine.instrumentId,'basic');
  assert.equal(instruments[1].disposed,true);
  engine.dispose();
});

test('organ releases follow the written tie chain rather than piano pedal', () => {
  const t=score([note(0,1,60)],4,{audio_notes:[note(0,4,60,{segment_ids:['0:60']})]});
  const x=player(t); x.p.synth.usesPianoPedal=false; x.p.play(1);
  assert.equal(x.p.schedule[0].end,1);
});
const score = (notes, total = 8, extra = {}) => ({ version: 2, tempo_bpm_default: 60, total_beats: total, notes,
  measures: [{ index: 0, start_beat: 0, length_beats: total, label: '1', page: 1, bbox_pt: null, distinct_midis: [] }], ...extra });
function player(timeline) {
  const runtime = modules();
  const { Playback } = runtime.load('app/play/playback.ts');
  const ctx = { currentTime: 0 };
  const sounds = [], highlights = [], progress = [];
  let ended = 0;
  const p = new Playback(timeline, { allOff() {}, noteOn(...args) { sounds.push(args); } }, ctx,
    { onHighlight: (n) => highlights.push(n), onProgress: (b) => progress.push(b), onEnded: () => ended++ });
  return { p, ctx, sounds, highlights, progress, ended: () => ended, frame: runtime.frame };
}

test('resume schedules the remaining part of an overlapping note', () => {
  const { p } = player(score([note(0, 4)], 4));
  p.play(1, { fromBeat: 2 });
  assert.equal(p.schedule.length, 1);
  assert.equal(p.schedule[0].start, 0);
  assert.equal(p.schedule[0].end, 2);
});

test('later short treble notes do not cut off a sustained bass', () => {
  const x = player(score([note(0, 8, 48), note(1, 1, 72)]));
  x.p.play(1); x.ctx.currentTime = x.p.originTime + 2.3; x.p.tick();
  assert.equal(x.ended(), 0);
  x.ctx.currentTime = x.p.originTime + 8; x.p.tick();
  assert.equal(x.ended(), 1);
});

test('trailing rests remain in the playback window', () => {
  const x = player(score([note(0, 1)], 4));
  x.p.play(1); x.ctx.currentTime = x.p.originTime + 1.3; x.p.tick();
  assert.equal(x.ended(), 0);
  x.ctx.currentTime = x.p.originTime + 4; x.p.tick();
  assert.equal(x.ended(), 1);
  assert.equal(x.progress.at(-1), 4);
});

test('preview boundary clips long sustains and schedules nothing beyond it', () => {
  const x = player(score([note(0, 8), note(5, 1, 62)]));
  x.p.play(1, { untilBeat: 4 });
  assert.equal(x.p.schedule.length, 1);
  assert.equal(x.p.schedule[0].end, 4);
});

test('tempo changes integrate and invert exactly', () => {
  const { tempoClock } = modules().load('app/play/tempo.ts');
  const clock = tempoClock(score([], 8, { tempo_map: [{ start_beat: 0, bpm: 60 }, { start_beat: 4, bpm: 120 }] }));
  assert.equal(clock.secondsAt(8), 6);
  for (const beat of [-4, 0, 2, 4, 5, 8]) assert.equal(clock.beatAt(clock.secondsAt(beat)), beat);
});

test('printed dotted-quarter BPM displays 68 and retains its sounding tempo', () => {
  const { tempoControl, tempoClock } = modules().load('app/play/tempo.ts');
  const t = score([], 6, { tempo_map: [{ start_beat: 0, bpm: 102, beat_unit_quarters: 1.5 }] });
  const control = tempoControl(t);
  assert.equal(control.bpm, 68);
  assert.equal(control.unit, 'dotted quarter note');
  assert.equal(control.toQuarterBpm(68), 102);
  assert.equal(tempoControl(t, control.toQuarterBpm(60)).bpm, 60);
  assert.ok(Math.abs(tempoClock(t, 1, control.toQuarterBpm(68)).secondsAt(6) - 4 * 60 / 68) < 1e-9);
  assert.equal(tempoClock(t, 1, control.toQuarterBpm(60)).secondsAt(6), 4);
});

test('legacy tempo data defaults to quarter-note BPM', () => {
  const { tempoControl } = modules().load('app/play/tempo.ts');
  const control = tempoControl(score([], 4));
  assert.equal(control.bpm, 60);
  assert.equal(control.toQuarterBpm(80), 80);
});

test('note spanning a tempo change uses both tempo segments', () => {
  const x = player(score([note(2, 4)], 8, { tempo_map: [{ start_beat: 0, bpm: 60 }, { start_beat: 4, bpm: 120 }] }));
  x.p.play(1);
  assert.equal(x.p.schedule[0].end - x.p.schedule[0].start, 3);
});

test('speed changes resume an active note and keep the preview limit', () => {
  const x = player(score([note(0, 8)]));
  x.p.play(1, { untilBeat: 6 }); x.ctx.currentTime = x.p.originTime + 2;
  x.p.setSpeed(2);
  assert.equal(x.p.windowStart, 2);
  assert.equal(x.p.windowEnd, 6);
  assert.equal(x.p.schedule[0].end, 2);
});

test('tied written segments highlight separately with only one audio attack', () => {
  const notes = [note(0, 4), note(4, 4, 60, { measure_index: 1 })];
  const x = player(score(notes, 8, { audio_notes: [note(0, 8)], measures: [
    { index: 0, start_beat: 0, length_beats: 4 }, { index: 1, start_beat: 4, length_beats: 4 }] }));
  x.p.play(1);
  assert.equal(x.p.schedule.length, 1);
  assert.equal(x.p.notesAt(5)[0].measure_index, 1);
  assert.equal(x.p.measureAt(5), 1);
});

test('pedal-only sustain does not show a physically held key', () => {
  const x = player(score([note(0, 1, 60, { key_duration_beats: .5 })], 4, { audio_notes: [note(0, 4)] }));
  x.p.play(1);
  assert.equal(x.p.notesAt(2).length, 0);
  assert.equal(x.p.schedule[0].end, 4);
});

test('count-in preserves the falling-note descent without early highlights', () => {
  const x = player(score([note(0, 1)]));
  x.p.play(1);
  assert.equal(x.p.leadBeat, -4);
  assert.equal(x.p.currentBeat, 0);
  assert.equal(x.highlights.flat().length, 0);
  x.ctx.currentTime = x.p.originTime; x.frame();
  assert.equal(x.highlights.at(-1).length, 1);
  x.p.pause();
  assert.equal(x.highlights.at(-1).length, 0);
});

test('recognition velocity is passed to the synth', () => {
  const x = player(score([note(0, 4)], 4, { audio_notes: [note(0, 4, 60, { velocity: 42 })] }));
  x.p.play(1); x.ctx.currentTime = x.p.originTime; x.p.tick();
  assert.equal(x.sounds[0][3], 42);
});

test('a suspended tab skips expired notes instead of replaying a burst', () => {
  const x = player(score([note(0, 1), note(1, 1, 62), note(2, 5, 64)]));
  x.p.play(1); x.ctx.currentTime = x.p.originTime + 4; x.p.tick();
  assert.equal(x.sounds.length, 1);
  assert.equal(x.sounds[0][0], 64);
  assert.equal(x.sounds[0][1], x.ctx.currentTime);
});

test('printed correction applies to every repeated occurrence', () => {
  const { applyCorrections } = modules().load('lib/corrections.ts');
  const original = score([note(0, 1, 60, { printed_id: 'a', source_id: '0:a' }), note(4, 1, 60, { printed_id: 'a', source_id: '1:a', measure_index: 1 })], 8, {
    audio_notes: [note(0, 1, 60, { source_id: '0:a' }), note(4, 1, 60, { source_id: '1:a' })],
    measures: [{ index: 0, start_beat: 0, length_beats: 4 }, { index: 1, start_beat: 4, length_beats: 4 }] });
  const changed = applyCorrections(original, { a: { midi: 62, hand: 'left', offset: 1, duration: 2 } });
  assert.equal(changed.notes[0].midi, 62); assert.equal(changed.notes[1].midi, 62);
  assert.equal(changed.notes[1].start_beat, 5); assert.equal(changed.audio_notes[1].duration_beats, 2);
  assert.equal(changed.notes[0].role, 1); assert.equal(original.notes[0].midi, 60);
});

test('correcting a tied continuation changes its whole sounding chain', () => {
  const { applyCorrections } = modules().load('lib/corrections.ts');
  const original = score([note(0, 4, 60, { source_id: 'a', printed_id: 'a' }), note(4, 4, 60, { source_id: 'b', printed_id: 'b', measure_index: 1 })], 8, {
    audio_notes: [note(0, 8, 60, { source_id: 'a', segment_ids: ['a', 'b'] })],
    measures: [{ index: 0, start_beat: 0, length_beats: 4 }, { index: 1, start_beat: 4, length_beats: 4 }] });
  const changed = applyCorrections(original, { b: { midi: 65, hand: null, offset: 0, duration: 4 } });
  assert.equal(changed.audio_notes[0].midi, 65);
  assert.equal(changed.notes[0].midi, 65);
});
