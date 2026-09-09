import type { Timeline } from "./timeline";

export type NoteCorrection = { midi: number; hand: "left" | "right" | null; offset: number; duration: number };
export type Corrections = Record<string, NoteCorrection>;

export function validCorrection(value: unknown): value is NoteCorrection {
  if (!value || typeof value !== "object") return false;
  const c = value as NoteCorrection;
  return Number.isInteger(c.midi) && c.midi >= 21 && c.midi <= 108
    && (c.hand === "left" || c.hand === "right" || c.hand === null)
    && Number.isFinite(c.offset) && c.offset >= 0
    && Number.isFinite(c.duration) && c.duration > 0 && c.duration <= 128;
}

/** Corrections address a printed note, so every repeated occurrence changes.
 * Pitch changes to a tied segment propagate through its sounding tie chain. */
export function applyCorrections(original: Timeline, corrections: Corrections): Timeline {
  const notes = original.notes.map((n) => {
    const c = corrections[n.printed_id ?? n.source_id ?? ""];
    const m = original.measures[n.measure_index];
    if (!validCorrection(c) || !m || c.offset >= m.length_beats) return { ...n };
    const duration = Math.min(c.duration, m.length_beats - c.offset);
    const gateRatio = n.duration_beats > 0 ? (n.key_duration_beats ?? n.duration_beats) / n.duration_beats : 1;
    return { ...n, midi: c.midi, hand: c.hand, role: c.hand === "right" ? 0 : c.hand === "left" ? 1 : Math.max(0, (n.staff ?? n.role + 1) - 1),
      start_beat: m.start_beat + c.offset, duration_beats: duration, key_duration_beats: duration * gateRatio, pitch_source: "user" };
  });
  const byId = new Map(notes.map((n) => [n.source_id, n]));
  const originals = new Map(original.notes.map((n) => [n.source_id, n]));
  const audio = original.audio_notes?.map((a) => {
    const segments = (a.segment_ids ?? [a.source_id]).map((id) => byId.get(id)).filter((n) => n !== undefined);
    if (!segments.length) return { ...a };
    const editedPitch = segments.find((n) => n.pitch_source === "user");
    if (editedPitch) segments.forEach((n) => { n.midi = editedPitch.midi; });
    const first = segments[0];
    const oldEnd = Math.max(...segments.map((n) => {
      const old = originals.get(n.source_id)!;
      return old.start_beat + (old.key_duration_beats ?? old.duration_beats);
    }));
    const newEnd = Math.max(...segments.map((n) => n.start_beat + (n.key_duration_beats ?? n.duration_beats)));
    // A pedal release is an absolute event, not a tail to move with the note.
    const pedalRelease = a.start_beat + a.duration_beats > oldEnd + 1e-8 ? a.start_beat + a.duration_beats : 0;
    return { ...a, midi: first.midi, role: first.role, start_beat: first.start_beat,
      duration_beats: Math.max(newEnd, pedalRelease) - first.start_beat };
  });
  return { ...original, notes: notes.sort((a, b) => a.start_beat - b.start_beat || a.midi - b.midi), audio_notes: audio,
    measures: original.measures.map((m) => ({ ...m, distinct_midis: [...new Set(notes.filter((n) => n.measure_index === m.index).map((n) => n.midi))].sort((a, b) => a - b) })) };
}
