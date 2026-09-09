// Audio and highlights share a tempo-integrated AudioContext clock. Sounding
// events can span multiple written tie segments or continue under the pedal.
import { GRACE_SECONDS, SynthEngine } from "./synth";
import { tempoClock } from "./tempo";
import { measureIndexAt, notesAtBeat } from "@/lib/timeline";
import type { AudioNote, Timeline, TimelineNote } from "@/lib/timeline";

const LOOKAHEAD_SECONDS = .1;
const SCHEDULER_INTERVAL_MS = 25;
// Shared with the falling-note roll; retain the full opening descent.
export const LEAD_IN_BEATS = 4;

export type PlayOptions = { fromBeat?: number; untilBeat?: number };
export type PlaybackCallbacks = {
  onHighlight: (notes: TimelineNote[]) => void;
  onProgress?: (beat: number) => void;
  onMeasure?: (index: number | null) => void;
  onEnded?: () => void;
};

export class Playback {
  private schedule: { note: AudioNote; start: number; end: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private raf: number | null = null;
  private originTime = 0;
  private windowStart = 0;
  private windowEnd = 0;
  private windowSeconds = 0;
  private startSeconds = 0;
  private cursorIndex = 0;
  private pausedBeat = 0;
  private playing = false;
  private lastHighlight = "";
  private lastMeasure: number | null = null;
  private lastOptions: PlayOptions = {};
  private lastSpeed = 1;
  private baseBpm: number | null = null;
  private clock: ReturnType<typeof tempoClock>;

  constructor(private timeline: Timeline, private synth: SynthEngine,
              private ctx: AudioContext, private cb: PlaybackCallbacks) {
    this.clock = tempoClock(timeline);
  }

  get isPlaying() { return this.playing; }
  get currentBeat() {
    return this.playing ? Math.max(this.windowStart, Math.min(this.windowEnd, this.leadBeat)) : this.pausedBeat;
  }
  get leadBeat() {
    return this.playing ? this.clock.beatAt(this.startSeconds + this.ctx.currentTime - this.originTime) : this.pausedBeat;
  }

  play(speed: number, opts: PlayOptions = {}) {
    this.stopInternal();
    this.lastSpeed = speed;
    this.lastOptions = opts;
    this.clock = tempoClock(this.timeline, speed, this.baseBpm);
    const requestedEnd = opts.untilBeat ?? this.timeline.total_beats;
    this.windowEnd = Math.max(0, Math.min(this.timeline.total_beats, requestedEnd));
    const from = Math.max(0, opts.fromBeat ?? this.pausedBeat);
    this.windowStart = from >= this.windowEnd ? 0 : from;
    this.startSeconds = this.clock.secondsAt(this.windowStart);
    this.windowSeconds = this.clock.secondsAt(this.windowEnd) - this.startSeconds;
    const events: AudioNote[] = this.timeline.audio_notes ?? this.timeline.notes.map((n) => ({
      ...n, duration_beats: n.duration_beats > 0 ? n.duration_beats : n.is_grace ? GRACE_SECONDS / .625 : 0,
    }));
    this.schedule = events
      .filter((n) => n.start_beat < this.windowEnd - 1e-9 && n.start_beat + n.duration_beats > this.windowStart + 1e-9)
      .map((n) => ({
        note: n,
        start: this.clock.secondsAt(Math.max(n.start_beat, this.windowStart)) - this.startSeconds,
        end: this.clock.secondsAt(Math.min(n.start_beat + n.duration_beats, this.windowEnd)) - this.startSeconds,
      }))
      .sort((a, b) => a.start - b.start);
    const lead = this.windowStart <= 1e-9
      ? this.clock.secondsAt(0) - this.clock.secondsAt(-LEAD_IN_BEATS) : .06;
    this.originTime = this.ctx.currentTime + lead;
    this.cursorIndex = 0;
    this.playing = true;
    this.timer = setInterval(() => this.tick(), SCHEDULER_INTERVAL_MS);
    this.tick();
    if (this.playing) this.startHighlightLoop();
  }

  setSpeed(speed: number) {
    const beat = this.currentBeat;
    this.lastSpeed = speed;
    if (this.playing) this.play(speed, { ...this.lastOptions, fromBeat: beat });
  }

  setTempo(bpm: number | null) {
    const beat = this.currentBeat;
    this.baseBpm = bpm;
    if (this.playing) this.play(this.lastSpeed, { ...this.lastOptions, fromBeat: beat });
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

  dispose() { this.stopInternal(); }

  private stopInternal() {
    this.playing = false;
    if (this.timer !== null) clearInterval(this.timer);
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.timer = this.raf = null;
    this.synth.allOff();
    this.lastHighlight = "stopped";
    this.lastMeasure = null;
  }

  private tick() {
    if (!this.playing) return;
    const elapsed = this.ctx.currentTime - this.originTime;
    while (this.cursorIndex < this.schedule.length && this.schedule[this.cursorIndex].start <= elapsed + LOOKAHEAD_SECONDS) {
      const s = this.schedule[this.cursorIndex++];
      // A backgrounded tab can wake after an event. Skip expired sounds and
      // resume a still-active event at the current audio time.
      const at = Math.max(this.ctx.currentTime, this.originTime + s.start);
      const until = this.originTime + s.end;
      if (until > at) this.synth.noteOn(s.note.midi, at, until, s.note.velocity);
    }
    // The window includes trailing rests and every sustained voice.
    if (elapsed >= this.windowSeconds) {
      this.pausedBeat = this.windowEnd;
      this.stopInternal();
      this.emitHighlight([]);
      this.cb.onProgress?.(this.pausedBeat);
      this.cb.onMeasure?.(null);
      this.cb.onEnded?.();
    }
  }

  private emitHighlight(notes: TimelineNote[]) {
    const key = notes.map((n) => n.source_id ?? `${n.midi}:${n.role}:${n.start_beat}`).join(",");
    if (key !== this.lastHighlight) {
      this.lastHighlight = key;
      this.cb.onHighlight(notes);
    }
  }

  notesAt(beat: number) { return notesAtBeat(this.timeline, beat); }
  measureAt(beat: number) { return measureIndexAt(this.timeline, beat); }

  seek(beat: number) {
    const target = Math.max(0, Math.min(this.timeline.total_beats, beat));
    this.pausedBeat = target;
    if (this.playing) this.play(this.lastSpeed, { ...this.lastOptions, fromBeat: target });
    else {
      this.emitHighlight(this.notesAt(target));
      this.lastMeasure = this.measureAt(target);
      this.cb.onMeasure?.(this.lastMeasure);
      this.cb.onProgress?.(target);
    }
  }

  private startHighlightLoop() {
    const frame = () => {
      if (!this.playing) return;
      const beat = this.leadBeat;
      this.emitHighlight(beat < this.windowStart ? [] : this.notesAt(beat));
      this.cb.onProgress?.(beat);
      const measure = beat < this.windowStart ? null : this.measureAt(beat);
      if (measure !== this.lastMeasure) {
        this.lastMeasure = measure;
        this.cb.onMeasure?.(measure);
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
}
