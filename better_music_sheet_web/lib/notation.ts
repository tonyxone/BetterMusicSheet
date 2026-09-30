"use client";

// Numbered notation (jianpu): the note names shown as scale degrees of the
// key, 1 2 3 4 5 6 7, instead of letters. The labels stay letters underneath
// - in labels.json, in the reader's saved edits, in what retyping compares -
// and only what is drawn changes, so switching back and forth loses nothing.
//
// "1" is always the major tonic of the key signature: with no sharps or
// flats 1 = C, and a piece in A minor reads 6 7 1 2 3 4 5, as printed jianpu
// does ("1=C"). A note only gets a sharp or flat when it differs from the
// key: in G major F♯ is plain 7 and F♮ is ♭7. A spelling that would need a
// double sharp or flat - D♯ written before a key change, in A♭ major - reads
// as the degree it sounds as instead (5), as a jianpu reader would write it.

import { useCallback, useSyncExternalStore } from "react";
import { parseNoteName, type LabelItem, type LabelSet } from "./labels";
import type { Timeline } from "./timeline";

export type Notation = "letters" | "numbers";

const LETTERS = "CDEFGAB";
const STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const mod = (a: number, n: number) => ((a % n) + n) % n;

const UNICODE_ACC: Record<number, string> = { [-2]: "𝄫", [-1]: "♭", 0: "", 1: "♯", 2: "𝄪" };
const ASCII_ACC: Record<number, string> = { [-2]: "bb", [-1]: "b", 0: "", 1: "#", 2: "##" };
const NUMBERED = /^\s*(𝄫|𝄪|♭♭|♯♯|##|bb|♮|♯|♭|#|b|x)?([1-7])\s*(\?)?\s*$/u;
const NUMBERED_ACC: Record<string, number> = {
  "": 0, "♮": 0, "♯": 1, "#": 1, "♭": -1, "b": -1, "𝄪": 2, "x": 2, "##": 2, "♯♯": 2, "𝄫": -2, "bb": -2, "♭♭": -2,
};

/** Whether a label spells its accidentals in plain ASCII (Bb, C#). */
function usesAscii(text: string) {
  return /^\s*[A-Ga-g](#|b|x)/.test(text);
}

/** The major tonic of a key signature: letter index (C = 0) and pitch class. */
function tonic(fifths: number) {
  return { step: mod(4 * fifths, 7), pc: mod(7 * fifths, 12) };
}

/** "G", "E♭", "F♯" - the name after "1=" for a key signature. */
export function keyName(fifths: number, ascii = false) {
  const { step, pc } = tonic(fifths);
  const alter = mod(pc - STEP_SEMITONES[step] + 6, 12) - 6;
  return LETTERS[step] + (ascii ? ASCII_ACC : UNICODE_ACC)[alter];
}

/** A letter label ("F♯", "Bb4", "C?") as a scale degree of the key given by
 * ``fifths`` ("#4", "♭7", "1?"). Anything that isn't a note name comes back
 * unchanged. The octave, when the label has one, is dropped. */
export function toNumbered(text: string, fifths: number) {
  const p = parseNoteName(text);
  if (!p) return text;
  const t = tonic(fifths);
  let degree = mod(p.step - t.step, 7);
  const expected = mod(t.pc + STEP_SEMITONES[degree], 12);
  const actual = mod(STEP_SEMITONES[p.step] + p.alter, 12);
  let alter = mod(actual - expected + 6, 12) - 6;
  if (Math.abs(alter) > 1) {
    // By sound instead: the degree itself, or the one a semitone away in
    // the direction the note was altered.
    const offset = mod(actual - t.pc, 12);
    const plain = STEP_SEMITONES.indexOf(offset);
    alter = plain >= 0 ? 0 : Math.sign(alter);
    degree = plain >= 0 ? plain : STEP_SEMITONES.indexOf(mod(offset - alter, 12));
  }
  const acc = (usesAscii(text) ? ASCII_ACC : UNICODE_ACC)[alter] ?? "";
  return `${acc}${degree + 1}${/\?\s*$/.test(text) ? "?" : ""}`;
}

/** A scale degree typed by the reader ("#4", "b7", "5") back as the letter
 * it means in the key, spelled like ``original`` (the label's printed text).
 * When it names the printed note, the printed text itself comes back, octave
 * and all. Null when ``text`` isn't a scale degree. */
export function fromNumbered(text: string, fifths: number, original: string) {
  const m = NUMBERED.exec(text);
  if (!m) return null;
  const t = tonic(fifths);
  const degree = Number(m[2]) - 1;
  const step = mod(t.step + degree, 7);
  const pc = mod(t.pc + STEP_SEMITONES[degree] + (NUMBERED_ACC[m[1] ?? ""] ?? 0), 12);
  const alter = mod(pc - STEP_SEMITONES[step] + 6, 12) - 6;
  const printed = parseNoteName(original);
  if (printed && printed.step === step && printed.alter === alter) return original.trim();
  const acc = (usesAscii(original) ? ASCII_ACC : UNICODE_ACC)[alter];
  if (acc === undefined) return null;
  return `${LETTERS[step]}${acc}${m[3] ?? ""}`;
}

const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
const SHARP_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

/** A timeline note's name in ``notation``, as written on the sheet: its own
 * spelling when that still matches what it plays, otherwise - a pitch the
 * reader corrected - spelled from the pitch, with flats in flat keys. */
export function timelineNoteName(n: Timeline["notes"][number], notation: Notation) {
  const fifths = n.key_fifths ?? 0;
  const pc = mod(n.midi, 12);
  const step = n.step ? LETTERS.indexOf(n.step) : -1;
  const written = step >= 0 && mod(STEP_SEMITONES[step] + (n.alter ?? 0), 12) === pc;
  const letter = written ? n.step! + (UNICODE_ACC[n.alter ?? 0] ?? "") : (fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[pc];
  return notation === "numbers" ? toNumbered(letter, fifths) : letter;
}

/** What a label reads as in ``notation``. Labels whose key isn't known stay
 * letters rather than guessing. */
export function displayText(text: string, key: number | undefined, notation: Notation) {
  return notation === "numbers" && key !== undefined ? toNumbered(text, key) : text;
}

// ---- keys ------------------------------------------------------------------

function noteId(n: Timeline["notes"][number]) {
  return n.printed_id ?? n.source_id;
}

/** ``set`` with each label's key signature filled in, when labels.json didn't
 * already carry it: the key of the note it names or, for a label not linked
 * to one, of the nearest notehead on its page. */
export function withKeys(set: LabelSet | null, timeline: Timeline | null): LabelSet | null {
  if (!set || !timeline || set.items.every((i) => i.key !== undefined)) return set;
  const byId = new Map<string, number>();
  const heads: { page: number; x: number; y: number; key: number }[] = [];
  for (const n of timeline.notes) {
    if (n.key_fifths === undefined) continue;
    const id = noteId(n);
    if (id && !byId.has(id)) byId.set(id, n.key_fifths);
    const page = timeline.measures[n.measure_index]?.page;
    if (n.bbox_pt && page) {
      const [x0, y0, x1, y1] = n.bbox_pt;
      heads.push({ page, x: (x0 + x1) / 2, y: (y0 + y1) / 2, key: n.key_fifths });
    }
  }
  if (!byId.size) return set;
  const items = set.items.map((item): LabelItem => {
    if (item.key !== undefined) return item;
    const linked = item.notes.map((id) => byId.get(id)).find((k) => k !== undefined);
    if (linked !== undefined) return { ...item, key: linked };
    let best: number | undefined;
    let bestDistance = Infinity;
    for (const h of heads) {
      if (h.page !== item.page) continue;
      const d = Math.hypot(h.x - item.x, h.y - item.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = h.key;
      }
    }
    return best === undefined ? item : { ...item, key: best };
  });
  return { ...set, items };
}

/** Each measure's key signature, by timeline measure index: the key most of
 * its notes are in, carried over measures that have none. Empty when the
 * timeline records no keys. */
export function measureKeys(timeline: Timeline): number[] {
  const counts = timeline.measures.map(() => new Map<number, number>());
  for (const n of timeline.notes) {
    const c = counts[n.measure_index];
    if (n.key_fifths === undefined || !c) continue;
    c.set(n.key_fifths, (c.get(n.key_fifths) ?? 0) + 1);
  }
  const majority = counts.map((c) => (c.size ? [...c.entries()].sort((a, b) => b[1] - a[1])[0][0] : null));
  let last = majority.find((k) => k !== null);
  if (last === undefined) return [];
  return majority.map((k) => (last = k ?? last!));
}

export type KeyMark = { page: number; x: number; y: number; size: number; text: string };

/** Where "1=G" goes: above the start of the first measure on each page and
 * of any measure where the key changes, as printed jianpu marks it. A
 * measure's key is the one most of its notes are in. */
export function keyMarks(timeline: Timeline | null, size = 7): KeyMark[] {
  if (!timeline) return [];
  const keysByMeasure = new Map<number, Map<number, number>>();
  for (const n of timeline.notes) {
    if (n.key_fifths === undefined) continue;
    const m = timeline.measures[n.measure_index];
    const index = m ? m.printed_index ?? m.index : n.printed_measure_index ?? n.measure_index;
    const counts = keysByMeasure.get(index) ?? new Map<number, number>();
    counts.set(n.key_fifths, (counts.get(n.key_fifths) ?? 0) + 1);
    keysByMeasure.set(index, counts);
  }
  if (!keysByMeasure.size) return [];
  // Each printed measure once, in reading order - repeats replay measures.
  const printed = new Map<number, Timeline["measures"][number]>();
  for (const m of timeline.measures) {
    const index = m.printed_index ?? m.index;
    if (!printed.has(index)) printed.set(index, m);
  }
  const order = [...printed.entries()].sort(([a], [b]) => a - b);
  const marks: KeyMark[] = [];
  let lastKey: number | null = null;
  let lastPage: number | null = null;
  for (const [index, m] of order) {
    const counts = keysByMeasure.get(index);
    const key: number | null = counts ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] : lastKey;
    if (key === null) continue;
    if (m.page && m.bbox_pt && (key !== lastKey || m.page !== lastPage)) {
      const [x0, y0] = m.bbox_pt;
      // Above the top staff line, clear of a treble clef's curl.
      marks.push({ page: m.page, x: x0, y: y0 - size * 1.3, size, text: `1=${keyName(key)}` });
    }
    lastKey = key;
    if (m.page) lastPage = m.page;
  }
  return marks;
}

// ---- the reader's choice ---------------------------------------------------

const NOTATION_KEY = "bms_label_notation";
const NOTATION_EVENT = "bms-label-notation";
// Where the choice lives when browser storage is unavailable.
let unsaved: Notation | null = null;

function savedNotation(): Notation | null {
  try {
    const v = localStorage.getItem(NOTATION_KEY);
    return v === "letters" || v === "numbers" ? v : unsaved;
  } catch {
    return unsaved;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(NOTATION_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(NOTATION_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The reader's letters/numbers choice, remembered in this browser and kept
 * in step across every viewer on the page. Until they choose, ``fallback``
 * (the notation the sheet was made with) is used. */
export function useNotation(fallback: Notation = "letters") {
  const chosen = useSyncExternalStore(subscribe, savedNotation, () => null);
  const choose = useCallback((next: Notation) => {
    unsaved = next;
    try { localStorage.setItem(NOTATION_KEY, next); } catch { /* Optional. */ }
    window.dispatchEvent(new Event(NOTATION_EVENT));
  }, []);
  return [chosen ?? fallback, choose] as const;
}
