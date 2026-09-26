"use client";

// The note names printed on the sheet, as data the viewer draws itself so a
// reader can move and retype them (see ../../label_export.py).
//
// Sheets annotated since label export existed carry a labels.json. Older
// ones only have the names baked into the annotated PDF, so for those they
// are read back out of its text layer: annotate.py draws every name twice at
// the same spot - a white outline, then the fill - which nothing else on a
// score does, and that pairing is what identifies them.

import { fetchSheetAssets, fetchSheetFile } from "./sheet-files";
import { openPdf, type PdfTextItem } from "./pdfjs";
import type { Timeline } from "./timeline";

export type LabelItem = {
  id: string;
  /** Lines of one chord stack share a group, so they can move together. */
  group: string;
  /** 1-based PDF page. */
  page: number;
  /** Horizontal centre and baseline, in PDF points, top-down. */
  x: number;
  y: number;
  size: number;
  text: string;
  /** Timeline ids (printed_id, else source_id) of the notes this names. */
  notes: string[];
};

export type LabelSet = { color: string; items: LabelItem[]; source: "data" | "pdf" };

// ---- note names ------------------------------------------------------------

const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
const STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const ACCIDENTALS: Record<string, number> = {
  "": 0, "♮": 0, "♯": 1, "#": 1, "♭": -1, "b": -1, "𝄪": 2, "x": 2, "##": 2, "♯♯": 2, "𝄫": -2, "bb": -2, "♭♭": -2,
};
const NAME = /^\s*([A-Ga-g])(𝄫|𝄪|♭♭|♯♯|##|bb|♮|♯|♭|#|b|x)?(-?\d)?\s*\??\s*$/u;

export type SpelledPitch = { step: number; alter: number; octave: number | null };

/** "B♭", "C#4", "f" -> its letter, accidental and (optional) octave, or null
 * for anything that isn't a note name. */
export function parseNoteName(text: string): SpelledPitch | null {
  const m = NAME.exec(text);
  if (!m) return null;
  return {
    step: STEPS.indexOf(m[1].toUpperCase()),
    alter: ACCIDENTALS[m[2] ?? ""] ?? 0,
    octave: m[3] === undefined ? null : Number(m[3]),
  };
}

/** The MIDI number a retyped label means, judged against what it said
 * before and the note it belonged to: an explicit octave is taken as
 * written, otherwise the new letter lands on the nearest staff position -
 * so a "B" retyped as "C" goes up a step, not down a seventh. */
export function retypedMidi(newText: string, oldText: string, oldMidi: number): number | null {
  const next = parseNoteName(newText);
  if (!next) return null;
  let midi: number;
  if (next.octave !== null) {
    midi = (next.octave + 1) * 12 + STEP_SEMITONES[next.step] + next.alter;
  } else {
    const old = parseNoteName(oldText);
    const oldStep = old?.step ?? nearestStep(oldMidi);
    const oldAlter = old ? old.alter : oldMidi % 12 - STEP_SEMITONES[oldStep];
    const oldOctave = Math.round((oldMidi - oldAlter - STEP_SEMITONES[oldStep]) / 12) - 1;
    const oldIndex = oldOctave * 7 + oldStep;
    let best = 0;
    let bestDistance = Infinity;
    for (let octave = oldOctave - 1; octave <= oldOctave + 1; octave++) {
      const distance = Math.abs(octave * 7 + next.step - oldIndex);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = octave;
      }
    }
    midi = (best + 1) * 12 + STEP_SEMITONES[next.step] + next.alter;
  }
  return midi >= 21 && midi <= 108 ? midi : null;
}

function nearestStep(midi: number) {
  const pc = ((midi % 12) + 12) % 12;
  let best = 0;
  for (let i = 0; i < 7; i++) if (Math.abs(STEP_SEMITONES[i] - pc) < Math.abs(STEP_SEMITONES[best] - pc)) best = i;
  return best;
}

function pitchClassOf(text: string) {
  const p = parseNoteName(text);
  return p ? (((STEP_SEMITONES[p.step] + p.alter) % 12) + 12) % 12 : null;
}

// ---- loading ---------------------------------------------------------------

function validItem(value: unknown): value is LabelItem {
  const v = value as LabelItem;
  return !!v && typeof v.id === "string" && typeof v.text === "string" && Number.isFinite(v.page)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.size);
}

/** The sheet's labels, from its labels.json or, failing that, read out of
 * the annotated PDF. Null when neither yields any. */
export async function loadLabels(jobId: string, annotatedPdf: ArrayBuffer | null, timeline: Timeline | null): Promise<LabelSet | null> {
  try {
    const assets = await fetchSheetAssets(jobId);
    if (assets?.labels) {
      const res = await fetchSheetFile(jobId, "labels");
      if (res.ok) {
        const data = await res.json() as { color?: string; items?: unknown[] };
        const items = (data.items ?? []).filter(validItem).map((item) => ({
          ...item, group: item.group ?? item.id, notes: Array.isArray(item.notes) ? item.notes : [],
        }));
        if (items.length) return { color: data.color ?? "#000000", items, source: "data" };
      }
    }
  } catch (err) {
    console.error("Loading the label data failed; reading the PDF instead:", err);
  }
  if (!annotatedPdf) return null;
  try {
    const items = await readLabelsFromPdf(annotatedPdf);
    if (!items.length) return null;
    if (timeline) linkByPosition(items, timeline);
    return { color: "#000000", items, source: "pdf" };
  } catch (err) {
    console.error("Reading labels out of the annotated PDF failed:", err);
    return null;
  }
}

function isTextItem(item: PdfTextItem | { type: string }): item is PdfTextItem {
  return typeof (item as PdfTextItem).str === "string";
}

/** Every outline-then-fill pair of identical note names at one spot. */
export async function readLabelsFromPdf(data: ArrayBuffer): Promise<LabelItem[]> {
  const doc = await openPdf(data);
  const items: LabelItem[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const { items: raw } = await page.getTextContent();
      const seen = new Map<string, number>();
      const found: { key: string; text: string; x: number; y: number; size: number }[] = [];
      for (const item of raw) {
        if (!isTextItem(item)) continue;
        const text = item.str.trim();
        if (!text || !parseNoteName(text)) continue;
        const [a, b, c, d, e, f] = item.transform;
        // Into the viewport's top-down space at scale 1, which is PDF points
        // measured from the page's top-left - the space bbox_pt uses.
        const [va, vb, vc, vd, ve, vf] = viewport.transform;
        const x = va * e + vc * f + ve;
        const y = vb * e + vd * f + vf;
        const size = Math.hypot(a, b) || Math.hypot(c, d);
        const key = `${text}@${Math.round(x * 4)},${Math.round(y * 4)}`;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count === 2) found.push({ key, text, x: x + item.width / 2, y, size });
      }
      found.forEach((label) => {
        const id = `pdf-${n}-${Math.round(label.x * 10)}-${Math.round(label.y * 10)}`;
        items.push({ id, group: id, page: n, x: label.x, y: label.y, size: label.size, text: label.text, notes: [] });
      });
    }
  } finally {
    await doc.destroy?.().catch(() => undefined);
  }
  return items;
}

/** Ties labels read from a PDF to the timeline's notes by position: the
 * nearest unclaimed notehead of the same pitch class just above or below.
 * Approximate by nature - labels this can't place simply don't affect
 * playback when retyped. */
function linkByPosition(items: LabelItem[], timeline: Timeline) {
  const heads: { page: number; cx: number; cy: number; pc: number; id: string }[] = [];
  const seenIds = new Set<string>();
  for (const note of timeline.notes) {
    const m = timeline.measures[note.measure_index];
    const id = note.printed_id ?? note.source_id;
    if (!note.bbox_pt || !m?.page || !id || seenIds.has(id)) continue;
    seenIds.add(id);
    const [x0, y0, x1, y1] = note.bbox_pt;
    heads.push({ page: m.page, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, pc: ((note.midi % 12) + 12) % 12, id });
  }
  const pairs: { label: LabelItem; head: (typeof heads)[number]; cost: number }[] = [];
  for (const label of items) {
    const pc = pitchClassOf(label.text);
    if (pc === null) continue;
    for (const head of heads) {
      if (head.page !== label.page || head.pc !== pc) continue;
      const dx = Math.abs(head.cx - label.x);
      const dy = Math.abs(head.cy - (label.y - label.size * 0.35));
      if (dx > 16 || dy > 45) continue;
      pairs.push({ label, head, cost: dx * 2 + dy });
    }
  }
  pairs.sort((a, b) => a.cost - b.cost);
  const claimed = new Set<string>();
  for (const { label, head } of pairs) {
    if (label.notes.length || claimed.has(head.id)) continue;
    label.notes.push(head.id);
    claimed.add(head.id);
  }
}
