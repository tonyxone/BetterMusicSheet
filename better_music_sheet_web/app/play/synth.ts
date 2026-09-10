import type { Smplr } from "smplr";
import { SynthEngine as BasicSynth } from "./basic-synth";
export { GRACE_SECONDS, midiToFrequency } from "./basic-synth";

export const INSTRUMENTS = [
  { id: "grand", name: "Grand piano" },
  { id: "electric", name: "Electric piano · Wurlitzer" },
  { id: "cp80", name: "Electric grand · CP80" },
  { id: "organ", name: "Church organ" },
  { id: "basic", name: "Basic synth (offline)" },
] as const;
export type InstrumentId = typeof INSTRUMENTS[number]["id"];
export const isInstrumentId = (value: string): value is InstrumentId => INSTRUMENTS.some((i) => i.id === value);

/** Samples are loaded before the playback clock starts. */
export class SynthEngine {
  private instrument: Smplr | null = null;
  private basic: BasicSynth;
  private master: GainNode;
  private limiter: DynamicsCompressorNode;
  private loading: { id: InstrumentId; promise: Promise<void> } | null = null;
  private pending: Smplr | null = null;
  private generation = 0;
  private disposed = false;
  private nextId = 0;
  private loadedNotes = new Set<number>();
  instrumentId: InstrumentId = "basic";

  constructor(private ctx: AudioContext) {
    this.basic = new BasicSynth(ctx);
    this.master = ctx.createGain();
    this.master.gain.value = .65;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
  }
  get usesPianoPedal() { return this.instrumentId !== "organ"; }

  load(id: InstrumentId, notes: number[], progress: (percent: number) => void = () => {}) {
    if (this.disposed) return Promise.reject(new Error("Audio was closed."));
    if (this.loading?.id === id) return this.loading.promise;
    if (id === this.instrumentId && !this.loading && (id !== "grand" || notes.every((n) => this.loadedNotes.has(Math.round(n))))) return Promise.resolve();
    const generation = ++this.generation;
    this.pending?.dispose();
    this.pending = null;
    const promise = (async () => {
      let candidate: Smplr | null = null;
      try {
        if (id !== "basic") {
          const lib = await import("smplr");
          if (generation !== this.generation || this.disposed) return;
          const http = lib.HttpStorage;
          const cache = lib.CacheStorage("music-sheet-instruments-v1");
          const storage = { fetch: async (url: string) => {
            try { return await cache.fetch(url); } catch { return http.fetch(url); }
          } };
          const options = { destination: this.master, storage, volume: 85,
            onLoadProgress: ({ loaded, total }: { loaded: number; total: number }) => {
              if (generation === this.generation && !this.disposed) progress(total ? Math.round(loaded / total * 100) : 0);
            } };
          candidate = id === "grand"
            ? lib.SplendidGrandPiano(this.ctx, { ...options, decayTime: .35,
                notesToLoad: { notes: [...new Set(notes.map(Math.round))], velocityRange: [1, 127] } })
            : id === "organ"
              ? lib.Soundfont(this.ctx, { ...options, instrument: "church_organ", kit: "FluidR3_GM", loadLoopData: true })
              : lib.ElectricPiano(this.ctx, { ...options, instrument: id === "cp80" ? "CP80" : "WurlitzerEP200" });
          this.pending = candidate;
          await candidate.ready;
        }
        if (generation !== this.generation || this.disposed) { candidate?.dispose(); return; }
        this.allOff();
        this.instrument?.dispose();
        this.instrument = candidate;
        this.instrumentId = id;
        this.loadedNotes = new Set(notes.map(Math.round));
        this.pending = null;
        progress(100);
      } catch (error) {
        candidate?.dispose();
        throw error;
      } finally {
        if (generation === this.generation) { this.loading = null; this.pending = null; }
      }
    })();
    this.loading = { id, promise };
    void promise.then(() => { if (this.loading?.promise === promise) this.loading = null; }, () => {});
    return promise;
  }

  noteOn(midi: number, at: number, until: number, velocity = 80) {
    if (this.disposed || until <= at) return -1;
    if (!this.instrument) return this.basic.noteOn(midi, at, until, velocity);
    const id = ++this.nextId;
    this.instrument.start({ note: midi, time: at, duration: until - at,
      velocity: Math.max(1, Math.min(127, velocity)), stopId: id });
    return id;
  }
  setMuted(muted: boolean) {
    this.basic.setMuted(muted);
    this.master.gain.setTargetAtTime(muted ? 0 : .65, this.ctx.currentTime, .01);
  }
  allOff() { this.basic.allOff(); this.instrument?.stop(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.pending?.dispose();
    this.instrument?.dispose();
    this.basic.dispose();
    this.master.disconnect();
    this.limiter.disconnect();
  }
}
