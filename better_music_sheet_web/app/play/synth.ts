// A small Web Audio piano-ish synth.
//
// Deliberately synthesized rather than sampled: a real piano soundfont is
// megabytes of assets for a feature whose point is showing you *which* keys
// sound, not reproducing a concert grand. Easy to swap later - nothing
// outside this file knows how a note is produced.

/** How long a grace note (duration_beats === 0) should actually sound. */
export const GRACE_SECONDS = 0.12;

type Voice = {
  osc: OscillatorNode;
  gain: GainNode;
};

export function midiToFrequency(midi: number) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class SynthEngine {
  private ctx: AudioContext;
  private master: GainNode;
  private voices = new Map<number, Voice>();
  private nextId = 1;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    // Headroom: a dense chord is many simultaneous oscillators, and summing
    // them at full gain clips audibly.
    this.master.gain.value = 0.22;
    this.master.connect(ctx.destination);
  }

  /** Schedule a note. `at`/`until` are AudioContext times, so timing comes
   * from the audio clock rather than JS timers. Returns a voice id. */
  noteOn(midi: number, at: number, until: number): number {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    // Triangle, not sine: a sine reads as a dull flute with no harmonic
    // content, and a full additive piano model is out of scope here.
    osc.type = "triangle";
    osc.frequency.value = midiToFrequency(midi);

    const gain = ctx.createGain();
    const peak = 0.9;
    const sustain = 0.28;
    const attack = 0.006;
    // A real piano decays continuously rather than holding flat, so the
    // envelope always slides toward the sustain level instead of sitting at
    // the peak - this is most of what makes it read as a piano at all.
    const decay = Math.min(0.35, Math.max(0.08, (until - at) * 0.5));

    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(sustain, at + attack + decay);

    const release = 0.08;
    const stopAt = Math.max(at + attack + 0.02, until);
    gain.gain.setTargetAtTime(0.0001, stopAt, release / 3);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(at);
    osc.stop(stopAt + release * 3);

    const id = this.nextId++;
    this.voices.set(id, { osc, gain });
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // already torn down
      }
      this.voices.delete(id);
    };
    return id;
  }

  /** Silence output without changing anything else. Muting at the master
   * gain rather than skipping noteOn keeps scheduling, timing and the
   * keyboard highlight identical whether or not you can hear it. */
  setMuted(muted: boolean) {
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(muted ? 0.0001 : 0.22, now, 0.01);
  }

  /** Cut everything immediately - used on pause/stop. */
  allOff() {
    const now = this.ctx.currentTime;
    for (const [id, v] of this.voices) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0.0001, now, 0.015);
        v.osc.stop(now + 0.1);
      } catch {
        // already stopped
      }
      this.voices.delete(id);
    }
  }

  dispose() {
    this.allOff();
    try {
      this.master.disconnect();
    } catch {
      // already disconnected
    }
  }
}
