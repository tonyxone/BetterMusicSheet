// Turns the timeline's beats into scheduled audio and a highlight stream.
//
// Two clocks, deliberately:
//   - Audio is scheduled ahead of time against the AudioContext clock, using
//     the standard lookahead pattern. JS timers are far too jittery to start
//     notes directly; they only decide *what* to hand the audio clock next.
//   - The keyboard highlight is derived each animation frame from that same
//     audio clock, so it can never drift away from what you're hearing.
//
// Playback always runs over a beat window. The whole piece is just the widest
// window; looping one measure is a narrow one with loop turned on.

import { GRACE_SECONDS, SynthEngine } from "./synth";
import type { Timeline, TimelineNote } from "@/lib/timeline";

const LOOKAHEAD_SECONDS = 0.1;
const SCHEDULER_INTERVAL_MS = 25;
/** Silence between repeats, so a looped measure doesn't run into itself. */
const LOOP_GAP_BEATS = 0.25;

type ScheduledNote = {
  note: TimelineNote;
  /** Seconds from the start of a cycle. */
  start: number;
  end: number;
};

export type PlayOptions = {
  /** Where to start; defaults to wherever playback was paused. */
  fromBeat?: number;
  /** Beat window to repeat. Omit to play through to the end once. */
  loop?: { startBeat: number; endBeat: number };
  /** Stop here instead of at the end of the piece. Used for the signed-out
   * preview: bounding the window means notes past the limit are never
   * scheduled, rather than being cut off once they are already sounding. */
  untilBeat?: number;
};

export type PlaybackCallbacks = {
  onHighlight: (midis: number[]) => void;
  /** Index of the measure currently sounding, or null between/after notes. */
  onMeasure?: (index: number | null) => void;
  onEnded?: () => void;
};

export class Playback {
  private timeline: Timeline;
  private synth: SynthEngine;
  private ctx: AudioContext;
  private cb: PlaybackCallbacks;

  private schedule: ScheduledNote[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private raf: number | null = null;

  /** AudioContext time at which the current window's first cycle begins. */
  private originTime = 0;
  private windowStart = 0;
  private windowEnd = 0;
  private cycleSeconds = 0;
  private looping = false;
  private secondsPerBeat = 0.5;

  /** Scheduling cursor: which cycle, and how far into `schedule`. */
  private cursorCycle = 0;
  private cursorIndex = 0;

  private pausedBeat = 0;
  private playing = false;
  private lastHighlight = "";
  private lastMeasure: number | null = null;

  constructor(timeline: Timeline, synth: SynthEngine, ctx: AudioContext, cb: PlaybackCallbacks) {
    this.timeline = timeline;
    this.synth = synth;
    this.ctx = ctx;
    this.cb = cb;
  }

  get isPlaying() {
    return this.playing;
  }

  get isLooping() {
    return this.looping;
  }

  /** Beat position right now, or where playback was paused. */
  get currentBeat() {
    if (!this.playing) return this.pausedBeat;
    const elapsed = this.ctx.currentTime - this.originTime;
    if (elapsed < 0) return this.windowStart;
    if (this.looping && this.cycleSeconds > 0) {
      return this.windowStart + (elapsed % this.cycleSeconds) / this.secondsPerBeat;
    }
    return this.windowStart + elapsed / this.secondsPerBeat;
  }

  play(speed: number, opts: PlayOptions = {}) {
    this.stopInternal();

    const bpm = this.timeline.tempo_bpm_default || 96;
    this.secondsPerBeat = 60 / bpm / (speed || 1);
    this.looping = !!opts.loop;

    if (opts.loop) {
      this.windowStart = opts.loop.startBeat;
      this.windowEnd = opts.loop.endBeat;
    } else {
      const end = opts.untilBeat ?? this.timeline.total_beats;
      const from = opts.fromBeat ?? this.pausedBeat;
      // Resuming from at or past the end restarts, so a paused preview that
      // already ran to its limit plays again rather than doing nothing.
      this.windowStart = from >= end ? 0 : from;
      this.windowEnd = end;
    }

    const spanBeats = Math.max(0.001, this.windowEnd - this.windowStart);
    this.cycleSeconds = (spanBeats + (this.looping ? LOOP_GAP_BEATS : 0)) * this.secondsPerBeat;

    this.schedule = this.timeline.notes
      .filter((n) => n.start_beat >= this.windowStart - 1e-9 && n.start_beat < this.windowEnd - 1e-9)
      .map((n) => {
        const start = (n.start_beat - this.windowStart) * this.secondsPerBeat;
        const beats = n.is_grace || n.duration_beats <= 0 ? 0 : n.duration_beats;
        const dur = beats > 0
          ? Math.min(beats, spanBeats - (n.start_beat - this.windowStart)) * this.secondsPerBeat
          : GRACE_SECONDS;
        return { note: n, start, end: start + Math.max(GRACE_SECONDS, dur) };
      })
      .sort((a, b) => a.start - b.start);

    // A small offset so the first notes aren't scheduled in the past.
    this.originTime = this.ctx.currentTime + 0.06;
    this.cursorCycle = 0;
    this.cursorIndex = 0;
    this.playing = true;

    this.timer = setInterval(() => this.tick(), SCHEDULER_INTERVAL_MS);
    this.tick();
    this.startHighlightLoop();
  }

  pause() {
    if (!this.playing) return;
    this.pausedBeat = this.currentBeat;
    this.stopInternal();
    this.emitHighlight([]);
    this.cb.onMeasure?.(null);
  }

  stop() {
    this.pausedBeat = 0;
    this.stopInternal();
    this.emitHighlight([]);
    this.cb.onMeasure?.(null);
  }

  dispose() {
    this.stopInternal();
  }

  private stopInternal() {
    this.playing = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.synth.allOff();
    this.lastHighlight = "";
    this.lastMeasure = null;
  }

  private tick() {
    if (!this.playing) return;
    const horizon = this.ctx.currentTime - this.originTime + LOOKAHEAD_SECONDS;

    // Walk forward through cycles; without looping there is only cycle 0.
    for (;;) {
      if (this.cursorIndex >= this.schedule.length) {
        if (!this.looping) break;
        this.cursorCycle++;
        this.cursorIndex = 0;
        continue;
      }
      const s = this.schedule[this.cursorIndex];
      const at = this.cursorCycle * this.cycleSeconds + s.start;
      if (at > horizon) break;
      this.synth.noteOn(s.note.midi, this.originTime + at, this.originTime + this.cursorCycle * this.cycleSeconds + s.end);
      this.cursorIndex++;
    }

    if (!this.looping && this.cursorIndex >= this.schedule.length) {
      const last = this.schedule.length ? this.schedule[this.schedule.length - 1].end : 0;
      if (this.ctx.currentTime - this.originTime > last + 0.2) {
        this.stop();
        this.cb.onEnded?.();
      }
    }
  }

  private emitHighlight(midis: number[]) {
    const key = midis.join(",");
    // Only push when the set actually changes - otherwise this would set React
    // state 60x a second for no visible difference.
    if (key !== this.lastHighlight) {
      this.lastHighlight = key;
      this.cb.onHighlight(midis);
    }
  }

  private startHighlightLoop() {
    const frame = () => {
      if (!this.playing) return;
      const elapsed = Math.max(0, this.ctx.currentTime - this.originTime);
      const pos = this.looping && this.cycleSeconds > 0 ? elapsed % this.cycleSeconds : elapsed;

      const active: number[] = [];
      let measure: number | null = null;
      // The schedule is start-sorted, so anything still sounding lies in a
      // prefix - but a long note can outlast later ones, so scan rather than
      // breaking at the first note that has ended.
      for (const s of this.schedule) {
        if (s.start > pos) break;
        if (s.end > pos) {
          active.push(s.note.midi);
          if (measure === null) measure = s.note.measure_index;
        }
      }
      active.sort((a, b) => a - b);
      this.emitHighlight(active);

      // Between notes (a rest, or the gap between loop repeats) keep showing
      // the measure the playhead is in rather than flickering to nothing.
      if (measure === null) {
        const beat = this.windowStart + pos / this.secondsPerBeat;
        const m = this.timeline.measures.find(
          (mm) => beat >= mm.start_beat && beat < mm.start_beat + mm.length_beats,
        );
        measure = m ? m.index : null;
      }
      if (measure !== this.lastMeasure) {
        this.lastMeasure = measure;
        this.cb.onMeasure?.(measure);
      }

      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
}
