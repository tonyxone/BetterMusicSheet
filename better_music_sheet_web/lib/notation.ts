"use client";

// Numbered notation (jianpu) and solfège, both fixed-do: the note names shown
// as numbers (1 = C, 2 = D, 3 = E, 4 = F, 5 = G, 6 = A, 7 = B) or as syllables
// (do, re, mi, fa, so, la, si), whatever key the piece is in - so a degree
// always means the same piano key. The labels stay letters underneath - in
// labels.json, in the reader's saved edits, in what retyping compares - and
// only what is drawn changes, so switching back and forth loses nothing.
//
// A note on a white key reads as that key's degree, however it is spelled
// (E♯ is 4/mi, C♭ is 7/si, C𝄪 is 2/re). A note on a black key keeps its
// printed sharp or flat (D♯ is ♯2/♯re, E♭ is ♭3/♭mi); a double sharp or flat
// on one reads as the nearest spelling with a single one (F𝄫 is ♭3/♭mi).

import { parseNoteName, type SpelledPitch } from "./labels";
import { usePreference } from "./preferences";
import type { Timeline } from "./timeline";

export type Notation = "letters" | "numbers" | "solfege";

const LETTERS = "CDEFGAB";
const SOLFEGE = ["do", "re", "mi", "fa", "so", "la", "si"];
const STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const mod = (a: number, n: number) => ((a % n) + n) % n;

const UNICODE_ACC: Record<number, string> = { [-2]: "𝄫", [-1]: "♭", 0: "", 1: "♯", 2: "𝄪" };
const ASCII_ACC: Record<number, string> = { [-2]: "bb", [-1]: "b", 0: "", 1: "#", 2: "##" };
const NUMBERED = /^\s*(𝄫|𝄪|♭♭|♯♯|##|bb|♮|♯|♭|#|b|x)?([1-7])\s*(\?)?\s*$/u;
const SOLFEGE_RE = /^\s*(𝄫|𝄪|♭♭|♯♯|##|bb|♮|♯|♭|#|b|x)?\s*(do|re|mi|fa|so|la|si)\s*(\?)?\s*$/iu;
const NUMBERED_ACC: Record<string, number> = {
  "": 0, "♮": 0, "♯": 1, "#": 1, "♭": -1, "b": -1, "𝄪": 2, "x": 2, "##": 2, "♯♯": 2, "𝄫": -2, "bb": -2, "♭♭": -2,
};

/** Whether a label spells its accidentals in plain ASCII (Bb, C#). */
function usesAscii(text: string) {
  return /^\s*[A-Ga-g](#|b|x)/.test(text);
}

/** A letter label's fixed-do scale degree (0 = C/do) and alteration, or null
 * for anything that isn't a note name. */
function fixedDoDegree(p: SpelledPitch) {
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
  return { degree, alter };
}

/** A letter label ("F♯", "Bb4", "C?") as a number ("♯4", "b7", "1?").
 * Anything that isn't a note name comes back unchanged. The octave, when the
 * label has one, is dropped. */
export function toNumbered(text: string) {
  const p = parseNoteName(text);
  if (!p) return text;
  const { degree, alter } = fixedDoDegree(p);
  const acc = (usesAscii(text) ? ASCII_ACC : UNICODE_ACC)[alter] ?? "";
  return `${acc}${degree + 1}${/\?\s*$/.test(text) ? "?" : ""}`;
}

/** A letter label ("F♯", "Bb4", "C?") as a solfège syllable ("♯fa", "bsi",
 * "do?"). Anything that isn't a note name comes back unchanged. The octave,
 * when the label has one, is dropped. */
export function toSolfege(text: string) {
  const p = parseNoteName(text);
  if (!p) return text;
  const { degree, alter } = fixedDoDegree(p);
  const acc = (usesAscii(text) ? ASCII_ACC : UNICODE_ACC)[alter] ?? "";
  return `${acc}${SOLFEGE[degree]}${/\?\s*$/.test(text) ? "?" : ""}`;
}

/** A number typed by the reader ("#4", "b7", "5") back as the letter it
 * means, spelled like ``original`` (the label's printed text). When it names
 * the note printed - by sound, as the numbers are shown - the printed text
 * itself comes back, octave and all. Null when ``text`` isn't a number. */
export function fromNumbered(text: string, original: string) {
  const m = NUMBERED.exec(text);
  if (!m) return null;
  return fromFixedDoDegree(Number(m[2]) - 1, NUMBERED_ACC[m[1] ?? ""] ?? 0, m[3] ?? "", original);
}

/** A solfège syllable typed by the reader ("#fa", "bsi", "so") back as the
 * letter it means, spelled like ``original``. Null when ``text`` isn't a
 * solfège syllable. */
export function fromSolfege(text: string, original: string) {
  const m = SOLFEGE_RE.exec(text);
  if (!m) return null;
  const degree = SOLFEGE.indexOf(m[2].toLowerCase());
  return fromFixedDoDegree(degree, NUMBERED_ACC[m[1] ?? ""] ?? 0, m[3] ?? "", original);
}

/** Shared by fromNumbered/fromSolfege: a fixed-do degree + alteration back as
 * the letter it means, spelled like ``original``. */
function fromFixedDoDegree(step: number, alter: number, suffix: string, original: string) {
  const printed = parseNoteName(original);
  if (printed && mod(STEP_SEMITONES[printed.step] + printed.alter, 12) === mod(STEP_SEMITONES[step] + alter, 12)) {
    return original.trim();
  }
  const acc = (usesAscii(original) ? ASCII_ACC : UNICODE_ACC)[alter];
  if (acc === undefined) return null;
  return `${LETTERS[step]}${acc}${suffix}`;
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
  return notation === "numbers" ? toNumbered(letter) : notation === "solfege" ? toSolfege(letter) : letter;
}

/** What a label reads as in ``notation``. */
export function displayText(text: string, notation: Notation) {
  return notation === "numbers" ? toNumbered(text) : notation === "solfege" ? toSolfege(text) : text;
}

// ---- the reader's choice ---------------------------------------------------

/** The reader's letters/numbers/solfège choice - saved with their other
 * settings (lib/preferences.ts), so it is the same on every sheet and, signed
 * in, on every device - kept in step across every viewer on the page. Until
 * they choose, ``fallback`` (the notation the sheet was made with) is used. */
export function useNotation(fallback: Notation = "letters") {
  return usePreference("notation", fallback);
}
