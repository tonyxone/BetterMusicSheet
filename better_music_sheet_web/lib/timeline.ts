// Shape of the playback timeline JSON served by
// GET /api/sheets/{job_id}/timeline (built by ../../timeline.py).
//
// Beats are quarter-note units. There is no tempo in OMR output, so the
// backend ships a default BPM and the player scales it - see playback.ts.

export type TimelineNote = {
  measure_index: number;
  /** 0 = top staff (right hand), 1 = bottom staff. */
  role: number;
  midi: number;
  start_beat: number;
  /** 0 for grace notes; the player gives those a fixed short length. */
  duration_beats: number;
  is_grace: boolean;
};

export type TimelineMeasure = {
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
};
