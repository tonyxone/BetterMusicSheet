"use client";

// Numbered notation (jianpu), fixed-do: the note names shown as numbers,
// 1 = C, 2 = D, 3 = E, 4 = F, 5 = G, 6 = A, 7 = B, whatever key the piece is
// in - so a number always means the same piano key. The labels stay letters
// underneath - in labels.json, in the reader's saved edits, in what retyping
// compares - and only what is drawn changes, so switching back and forth
// loses nothing.
//
// A note on a white key reads as that key's number, however it is spelled
// (E♯ is 4, C♭ is 7, C𝄪 is 2). A note on a black key keeps its printed sharp
// or flat (D♯ is ♯2, E♭ is ♭3); a double sharp or flat on one reads as the
// nearest spelling with a single one (F𝄫 is ♭3).

import { useCallback, useSyncExternalStore } from "react";
import { parseNoteName } from "./labels";
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

/** A letter label ("F♯", "Bb4", "C?") as a number ("♯4", "b7", "1?").
 * Anything that isn't a note name comes back unchanged. The octave, when the
 * label has one, is dropped. */
export function toNumbered(text: string) {
  const p = parseNoteName(text);
  if (!p) return text;
  const pc = mod(STEP_SEMITONES[p.step] + p.alter, 12);
  const white = STEP_SEMITONES.indexOf(pc);
  let degree = p.step;
  let alter = p.alter;
  if (white >= 0) {
    degree = white;
    alter = 0;
  } else if (Math.abs(alter) > 1) {
    alter = Math.sign(alter);
    degree = STEP_SEMITONES.indexOf(mod(pc - alter, 12));
  }
  const acc = (usesAscii(text) ? ASCII_ACC : UNICODE_ACC)[alter] ?? "";
  return `${acc}${degree + 1}${/\?\s*$/.test(text) ? "?" : ""}`;
}

/** A number typed by the reader ("#4", "b7", "5") back as the letter it
 * means, spelled like ``original`` (the label's printed text). When it names
 * the note printed - by sound, as the numbers are shown - the printed text
 * itself comes back, octave and all. Null when ``text`` isn't a number. */
export function fromNumbered(text: string, original: string) {
  const m = NUMBERED.exec(text);
  if (!m) return null;
  const step = Number(m[2]) - 1;
  const alter = NUMBERED_ACC[m[1] ?? ""] ?? 0;
  const printed = parseNoteName(original);
  if (printed && mod(STEP_SEMITONES[printed.step] + printed.alter, 12) === mod(STEP_SEMITONES[step] + alter, 12)) {
    return original.trim();
  }
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
  return notation === "numbers" ? toNumbered(letter) : letter;
}

/** What a label reads as in ``notation``. */
export function displayText(text: string, notation: Notation) {
  return notation === "numbers" ? toNumbered(text) : text;
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
