// Turns the timeline's beats into scheduled audio and a highlight stream.
//
// Two clocks, deliberately:
//   - Audio is scheduled ahead of time against the AudioContext clock, using
//     the standard lookahead pattern. JS timers are far too jittery to start
//     notes directly; they only decide *what* to hand the audio clock next.
//   - The keyboard highlight is derived each animation frame from that same
//     audio clock, so it can never drift away from what you're hearing.
//
// Playback runs over a beat window: from somewhere in the piece to somewhere
// later. The whole piece is the widest window; the signed-out preview is a
// narrow one.

import { GRACE_SECONDS, SynthEngine } from "./synth";
import type { Timeline, TimelineNote } from "@/lib/timeline";

const LOOKAHEAD_SECONDS = 0.1;
const SCHEDULER_INTERVAL_MS = 25;
/** Released a little early on the keyboard, so two of the same pitch in a row
 * read as two strikes instead of one held note. Without it the key simply
 * stays lit across the repeat and the re-attack is invisible. */
const HIGHLIGHT_RELEASE_SECONDS = 0.07;

type ScheduledNote = {
  note: TimelineNote;
  /** Seconds from the start of the window. */
  start: number;
  end: number;
};

export type PlayOptions = {
  /** Where to start; defaults to wherever playback was paused. */
  fromBeat?: number;
  /** Stop here instead of at the end of the piece. Used for the signed-out
   * preview: bounding the window means notes past the limit are never
   * scheduled, rather than being cut off once they are already sounding. */
  untilBeat?: number;
};

export type PlaybackCallbacks = {
  /** The notes sounding right now, so callers can colour by hand and mark
   * them on the sheet - not just their pitches. */
  onHighlight: (notes: TimelineNote[]) => void;
  /** Beat position, every frame, for the scrubber. */
  onProgress?: (beat: number) => void;
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

  /** AudioContext time at which the current window begins. */
  private originTime = 0;
  private windowStart = 0;
  private windowEnd = 0;
  private secondsPerBeat = 0.5;

  /** How far into `schedule` the scheduler has got. */
  private cursorIndex = 0;

  private pausedBeat = 0;
  private playing = false;
  private lastHighlight = "";
  private lastOptions: PlayOptions = {};
  private lastSpeed = 1;
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

  /** Beat position right now, or where playback was paused. */
  get currentBeat() {
    if (!this.playing) return this.pausedBeat;
    const elapsed = this.ctx.currentTime - this.originTime;
    if (elapsed < 0) return this.windowStart;
    return this.windowStart + elapsed / this.secondsPerBeat;
  }

  play(speed: number, opts: PlayOptions = {}) {
    this.stopInternal();
    // Remembered so seek() can resume the same window at the same speed.
    this.lastSpeed = speed;
    this.lastOptions = opts;

    const bpm = this.timeline.tempo_bpm_default || 96;
    this.secondsPerBeat = 60 / bpm / (speed || 1);

    const end = opts.untilBeat ?? this.timeline.total_beats;
    // No explicit start means "carry on from the pause", which is what makes
    // resume continue mid-measure instead of restarting one.
    const from = opts.fromBeat ?? this.pausedBeat;
    // Resuming from at or past the end restarts, so a finished piece (or a
    // preview that ran to its limit) plays again rather than doing nothing.
    this.windowStart = from >= end ? 0 : from;
    this.windowEnd = end;

    const spanBeats = Math.max(0.001, this.windowEnd - this.windowStart);

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
    this.cursorIndex = 0;
    this.playing = true;

    this.timer = setInterval(() => this.tick(), SCHEDULER_INTERVAL_MS);
    this.tick();
    this.startHighlightLoop();
  }

  pause() {
    if (!this.playing) return;
    // Freeze the position before tearing down, so the next play resumes here.
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

    while (this.cursorIndex < this.schedule.length && this.schedule[this.cursorIndex].start <= horizon) {
      const s = this.schedule[this.cursorIndex];
      this.synth.noteOn(s.note.midi, this.originTime + s.start, this.originTime + s.end);
      this.cursorIndex++;
    }

    if (this.cursorIndex >= this.schedule.length) {
      const last = this.schedule.length ? this.schedule[this.schedule.length - 1].end : 0;
      if (this.ctx.currentTime - this.originTime > last + 0.2) {
        this.stop();
        this.cb.onEnded?.();
      }
    }
  }

  private emitHighlight(notes: TimelineNote[]) {
    const key = notes.map((n) => `${n.midi}:${n.role}:${n.start_beat}`).join(",");
    // Only push when the set actually changes - otherwise this would set React
    // state 60x a second for no visible difference.
    if (key !== this.lastHighlight) {
      this.lastHighlight = key;
      this.cb.onHighlight(notes);
    }
  }

  /** What is sounding at a given beat, without playing anything - used while
   * scrubbing a paused player so the sheet and keyboard still follow. */
  notesAt(beat: number): TimelineNote[] {
    return this.timeline.notes.filter((n) => {
      const len = n.is_grace || n.duration_beats <= 0 ? 0.25 : n.duration_beats;
      return beat >= n.start_beat - 1e-9 && beat < n.start_beat + len;
    });
  }

  measureAt(beat: number): number | null {
    const m = this.timeline.measures.find(
      (mm) => beat >= mm.start_beat && beat < mm.start_beat + mm.length_beats,
    );
    return m ? m.index : null;
  }

  /** Move the playhead. Keeps playing if it was playing, so dragging the
   * scrubber mid-piece continues from the new spot. */
  seek(beat: number) {
    const wasPlaying = this.playing;
    this.pausedBeat = beat;
    if (wasPlaying) {
      this.play(this.lastSpeed, { ...this.lastOptions, fromBeat: beat });
    } else {
      this.emitHighlight(this.notesAt(beat));
      const m = this.measureAt(beat);
      if (m !== this.lastMeasure) {
        this.lastMeasure = m;
        this.cb.onMeasure?.(m);
      }
      this.cb.onProgress?.(beat);
    }
  }

  private startHighlightLoop() {
    const frame = () => {
      if (!this.playing) return;
      const pos = Math.max(0, this.ctx.currentTime - this.originTime);

      const active: TimelineNote[] = [];
      let measure: number | null = null;
      // The schedule is start-sorted, so anything still sounding lies in a
      // prefix - but a long note can outlast later ones, so scan rather than
      // breaking at the first note that has ended.
      for (const s of this.schedule) {
        if (s.start > pos) break;
        // Never shorten a note to nothing: very fast passages would flicker
        // rather than showing anything at all.
        const lit = Math.max(s.start + 0.02, s.end - HIGHLIGHT_RELEASE_SECONDS);
        if (lit > pos) {
          active.push(s.note);
          if (measure === null) measure = s.note.measure_index;
        }
      }
      active.sort((a, b) => a.midi - b.midi);
      this.emitHighlight(active);
      this.cb.onProgress?.(this.windowStart + pos / this.secondsPerBeat);

      // Between notes (a rest, say) keep showing the measure the playhead is
      // in rather than flickering to nothing.
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
