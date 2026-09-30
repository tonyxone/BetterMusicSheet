// Shape of the playback timeline JSON served by
// GET /api/sheets/{job_id}/timeline (built by ../../timeline.py).
//
// Beats are quarter-note units. Score/PDF tempo events form a tempo map; a
// default BPM remains available when recognition has no trustworthy marking.

export type TimelineNote = {
  source_id?: string;
  printed_id?: string;
  printed_measure_index?: number;
  part?: number;
  staff?: number;
  voice?: string;
  hand?: "left" | "right" | null;
  attack?: boolean;
  velocity?: number;
  key_duration_beats?: number;
  pitch_source?: string;
  confidence?: number | null;
  fingering?: string | null;
  tie_start?: boolean;
  tie_stop?: boolean;
  /** The key signature in force, as fifths (-7..7). */
  key_fifths?: number;
  /** The note as written: letter, alteration in semitones, octave. */
  step?: string;
  alter?: number;
  octave?: number;
  measure_index: number;
  /** 0 = top staff (right hand), 1 = bottom staff. */
  role: number;
  midi: number;
  start_beat: number;
  /** 0 for grace notes; the player gives those a fixed short length. */
  duration_beats: number;
  is_grace: boolean;
  /** The notehead's own box in PDF points, when the two OMR sources agreed
   * on this measure. Null otherwise - the player falls back to a position
   * interpolated across the measure. */
  bbox_pt: [number, number, number, number] | null;
};

export type TimelineMeasure = {
  printed_index?: number;
  system?: number;
  warnings?: string[];
  index: number;
  label: string;
  /** 1-based PDF page, or null if this measure has no page geometry. */
  page: number | null;
  start_beat: number;
  length_beats: number;
  /** [x0, y0, x1, y1] in PDF points, top-down (PyMuPDF convention). */
  bbox_pt: [number, number, number, number] | null;
  distinct_midis: number[];
};

export type Timeline = {
  version: number;
  tempo_bpm_default: number;
  total_beats: number;
  measures: TimelineMeasure[];
  notes: TimelineNote[];
  audio_notes?: AudioNote[];
  tempo_map?: { start_beat: number; bpm: number; beat_unit_quarters?: number }[];
  tempo_source?: "score" | "default";
  events?: { kind: string; start_beat: number; value: string | number; part: number; staff: number }[];
  stats?: Record<string, number>;
  warnings?: string[];
};

export type AudioNote = {
  segment_ids?: string[];
  source_id?: string;
  midi: number;
  role: number;
  start_beat: number;
  duration_beats: number;
  velocity?: number;
};

/** Held keys exclude pedal-only sustain; written tie segments stay visible. */
export function notesAtBeat(timeline: Timeline, beat: number): TimelineNote[] {
  return timeline.notes.filter((n) => {
    const duration = n.key_duration_beats ?? (n.duration_beats > 0 ? n.duration_beats : n.is_grace ? .25 : 0);
    return beat >= n.start_beat - 1e-9 && beat < n.start_beat + duration - 1e-9;
  });
}

export function measureIndexAt(timeline: Timeline, beat: number): number | null {
  return timeline.measures.find((m) => beat >= m.start_beat && beat < m.start_beat + m.length_beats)?.index ?? null;
}

/** Where each note's name ends, in beats, for notes sorted by start: one name
 * per struck note, spanning its tied continuations - which get -1, as does a
 * second copy of a note two voices strike together. ``minBeats`` is the
 * shortest a note is drawn, grace notes included. */
export function nameSpans(notes: TimelineNote[], minBeats: number) {
  const ends = new Float64Array(notes.length);
  // Per key, the note whose name the next tied piece would extend.
  const heads = new Map<number, { index: number; start: number; end: number }>();
  notes.forEach((n, i) => {
    const end = n.start_beat + Math.max(minBeats, n.is_grace || n.duration_beats <= 0 ? 0 : n.duration_beats);
    const head = heads.get(n.midi);
    if (head && (Math.abs(head.start - n.start_beat) < 1e-6
        || (n.tie_stop && Math.abs(head.end - n.start_beat) < 1e-6))) {
      ends[i] = -1;
      if (end > head.end) ends[head.index] = head.end = end;
      return;
    }
    ends[i] = end;
    heads.set(n.midi, { index: i, start: n.start_beat, end });
  });
  return ends;
}
