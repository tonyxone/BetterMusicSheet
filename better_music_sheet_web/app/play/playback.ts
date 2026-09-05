// Turns the timeline's beats into scheduled audio and a highlight stream.
//
// Two clocks, deliberately:
//   - Audio is scheduled ahead of time against the AudioContext clock, using
//     the standard lookahead pattern. JS timers are far too jittery to start
//     notes directly; they only decide *what* to hand the audio clock next.
//   - The keyboard highlight is derived each animation frame from that same
//     audio clock, so it can never drift away from what you're hearing.

import { GRACE_SECONDS, SynthEngine } from "./synth";
import type { Timeline, TimelineNote } from "@/lib/timeline";

const LOOKAHEAD_SECONDS = 0.1;
const SCHEDULER_INTERVAL_MS = 25;

type ScheduledNote = {
  note: TimelineNote;
  start: number; // seconds from the piece's start
  end: number;
};

export type PlaybackCallbacks = {
  onHighlight: (midis: number[]) => void;
  onBeat?: (beat: number) => void;
  onEnded?: () => void;
};

export class Playback {
  private timeline: Timeline;
  private synth: SynthEngine;
  private ctx: AudioContext;
  private cb: PlaybackCallbacks;

  private schedule: ScheduledNote[] = [];
  private nextIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private raf: number | null = null;
  /** AudioContext time that corresponds to `startedAtBeat`. */
  private originTime = 0;
  private startedAtBeat = 0;
  private secondsPerBeat = 0.5;
  private lastHighlight = "";
  private playing = false;

  constructor(timeline: Timeline, synth: SynthEngine, ctx: AudioContext, cb: PlaybackCallbacks) {
    this.timeline = timeline;
    this.synth = synth;
    this.ctx = ctx;
    this.cb = cb;
  }

  get isPlaying() {
    return this.playing;
  }

  /** Beat position right now (or where we paused). */
  get currentBeat() {
    if (!this.playing) return this.startedAtBeat;
    return this.startedAtBeat + (this.ctx.currentTime - this.originTime) / this.secondsPerBeat;
  }

  play(speed: number, fromBeat?: number) {
    if (this.playing) return;
    const bpm = this.timeline.tempo_bpm_default || 96;
    this.secondsPerBeat = 60 / bpm / (speed || 1);
    this.startedAtBeat = fromBeat ?? this.startedAtBeat;
    if (this.startedAtBeat >= this.timeline.total_beats) this.startedAtBeat = 0;

    // Small offset so the very first notes aren't scheduled in the past.
    this.originTime = this.ctx.currentTime + 0.06;

    this.schedule = this.timeline.notes
      .filter((n) => n.start_beat >= this.startedAtBeat - 1e-9)
      .map((n) => {
        const start = (n.start_beat - this.startedAtBeat) * this.secondsPerBeat;
        const dur = n.is_grace || n.duration_beats <= 0
          ? GRACE_SECONDS
          : n.duration_beats * this.secondsPerBeat;
        return { note: n, start, end: start + dur };
      })
      .sort((a, b) => a.start - b.start);

    this.nextIndex = 0;
    this.playing = true;
    this.timer = setInterval(() => this.tick(), SCHEDULER_INTERVAL_MS);
    this.tick();
    this.startHighlightLoop();
  }

  pause() {
    if (!this.playing) return;
    // Freeze the beat position before clearing state, so resume continues
    // from here rather than restarting.
    this.startedAtBeat = this.currentBeat;
    this.stopInternal();
    this.cb.onHighlight([]);
  }

  stop() {
    this.startedAtBeat = 0;
    this.stopInternal();
    this.cb.onHighlight([]);
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
  }

  private tick() {
    if (!this.playing) return;
    const horizon = this.ctx.currentTime - this.originTime + LOOKAHEAD_SECONDS;
    while (this.nextIndex < this.schedule.length && this.schedule[this.nextIndex].start <= horizon) {
      const s = this.schedule[this.nextIndex];
      this.synth.noteOn(s.note.midi, this.originTime + s.start, this.originTime + s.end);
      this.nextIndex++;
    }
    if (this.nextIndex >= this.schedule.length) {
      const last = this.schedule.length ? this.schedule[this.schedule.length - 1].end : 0;
      if (this.ctx.currentTime - this.originTime > last + 0.2) {
        this.stop();
        this.cb.onEnded?.();
      }
    }
  }

  private startHighlightLoop() {
    const frame = () => {
      if (!this.playing) return;
      const now = this.ctx.currentTime - this.originTime;
      const active: number[] = [];
      // The schedule is start-sorted, so everything still sounding lies in a
      // prefix; a note's end can exceed later notes' starts, hence the scan
      // rather than an early break on start > now.
      for (const s of this.schedule) {
        if (s.start > now) break;
        if (s.end > now) active.push(s.note.midi);
      }
      const key = active.join(",");
      // Only push when the set actually changes - otherwise this would set
      // React state 60x a second for no visible difference.
      if (key !== this.lastHighlight) {
        this.lastHighlight = key;
        this.cb.onHighlight(active);
      }
      this.cb.onBeat?.(this.startedAtBeat + now / this.secondsPerBeat);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
}
