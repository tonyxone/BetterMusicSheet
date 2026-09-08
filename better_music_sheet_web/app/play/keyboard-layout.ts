// Where the 88 keys sit, and what colour each hand is.
//
// Shared by the 3D keyboard and the falling-note roll above it. The roll has
// to line its lanes up with the keys exactly - a note that lands a lane off
// its key is worse than no roll at all - so both derive their geometry from
// here rather than each carrying its own copy.
//
// Geometry follows a real instrument rather than the obvious approximation.
// Black keys are NOT centred on the boundary between two white keys - on a
// real piano the twelve semitones are equally spaced where they enter the
// action, so within an octave F# sits noticeably left of its boundary, G#
// close to centre, and A# right. Centring them (the naive layout) is the
// single thing that makes a drawn keyboard look wrong.

export const FIRST_MIDI = 21; // A0
export const LAST_MIDI = 108; // C8

const BLACK_CLASSES = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

// White key = 1 unit wide. Real ratios: 2.4cm vs 1.4cm wide, 15cm vs 9cm long.
export const WHITE_W = 1;
export const BLACK_W = 0.583;
export const GAP = 0.055; // hairline between white keys

/** Slack either side of the board in the keyboard's orthographic frustum.
 * The roll must use the same value or its lanes drift ~1.5% off the keys. */
export const FRUSTUM_MARGIN = 0.8;

// One colour per hand, so you can see at a glance which hand plays what.
export const COLOR_RIGHT = 0x2f6fb5; // right hand (top staff)
export const COLOR_LEFT = 0x3e8e5a;  // left hand

/** The same two colours for canvas/CSS, which can't take a hex number. */
export const CSS_RIGHT = "#2f6fb5";
export const CSS_LEFT = "#3e8e5a";

/** The same two hues, lifted for use on the roll's black background. The keys
 * mix their colour into ivory, which lightens it; on black the unmodified
 * value reads as muddy, so these keep the two surfaces looking like the same
 * blue and green rather than matching a hex nobody can compare side by side. */
export const CSS_RIGHT_ON_DARK = "#4f9be6";
export const CSS_LEFT_ON_DARK = "#4fbc7c";

export function isBlackKey(midi: number) {
  return BLACK_CLASSES.has(((midi % 12) + 12) % 12);
}

export function noteName(midi: number, withOctave = false) {
  const pc = ((midi % 12) + 12) % 12;
  return NOTE_NAMES[pc] + (withOctave ? String(Math.floor(midi / 12) - 1) : "");
}

export type KeyLayout = {
  /** Key centres in white-key units, from the left edge of the board. */
  centers: Map<number, number>;
  whiteCount: number;
};

/** White keys tile evenly. Each black key is placed by the "twelve equal
 * divisions at the back of the octave" rule described above, which is what
 * produces the familiar uneven look of the 2- and 3-key groups. */
export function keyLayout(): KeyLayout {
  const centers = new Map<number, number>();
  let whiteIndex = 0;

  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    if (!isBlackKey(midi)) {
      centers.set(midi, whiteIndex + 0.5);
      whiteIndex++;
    }
  }

  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    if (!isBlackKey(midi)) continue;
    // Anchor on the C of this key's octave when it exists, else on the
    // neighbouring white key, so the bottom of the board (which starts at A0)
    // is laid out on the same rule as everywhere else.
    const belowWhite = centers.get(midi - 1);
    const aboveWhite = centers.get(midi + 1);
    if (belowWhite === undefined || aboveWhite === undefined) {
      centers.set(midi, (belowWhite ?? aboveWhite ?? 0) + (belowWhite === undefined ? -0.5 : 0.5));
      continue;
    }
    const boundary = (belowWhite + aboveWhite) / 2;
    // Offset from that boundary, in white-key units. An octave is 7 white
    // keys wide and its twelve semitones are equally spaced at the back, so
    // semitone n is centred at (n + 0.5) * 7/12; the offset is that minus the
    // white-key boundary it sits over. Hence the familiar look: C# and F#
    // left of centre, D# and A# right, G# nearly centred.
    const pc = ((midi % 12) + 12) % 12;
    const offset = { 1: -1 / 8, 3: 1 / 24, 6: -5 / 24, 8: -1 / 24, 10: 1 / 8 }[pc] ?? 0;
    centers.set(midi, boundary + offset);
  }

  return { centers, whiteCount: whiteIndex };
}

/** A key's centre as a 0..1 fraction of the rendered width.
 *
 * Mirrors how keyboard-3d.tsx places its meshes (world x = centre - span/2)
 * and frames them (frustum half-width = span/2 + FRUSTUM_MARGIN). Because
 * that camera is orthographic and tilted only about X, horizontal position
 * maps linearly to the screen, so this fraction is exact rather than an
 * approximation of a projection. */
export function normalizedKeyX(layout: KeyLayout, midi: number) {
  const span = layout.whiteCount * WHITE_W;
  const center = layout.centers.get(midi);
  if (center === undefined) return 0;
  return (center * WHITE_W + FRUSTUM_MARGIN) / (span + 2 * FRUSTUM_MARGIN);
}

/** Where each octave begins, as 0..1 fractions of the rendered width.
 *
 * One line per B|C boundary - the natural place to divide a keyboard, since
 * that is where the black-key pattern restarts. Used by the roll to group its
 * lanes, so a bar can be placed by eye without counting keys. */
export function normalizedOctaveLines(layout: KeyLayout) {
  const span = layout.whiteCount * WHITE_W;
  const lines: number[] = [];
  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    if (midi % 12 !== 0) continue; // every C
    const center = layout.centers.get(midi);
    if (center === undefined) continue;
    // The left edge of the C key, i.e. the boundary it shares with the B below.
    const edge = (center - WHITE_W / 2) * WHITE_W;
    lines.push((edge + FRUSTUM_MARGIN) / (span + 2 * FRUSTUM_MARGIN));
  }
  return lines;
}

/** A key's width as a 0..1 fraction of the rendered width. */
export function normalizedKeyWidth(layout: KeyLayout, midi: number) {
  const span = layout.whiteCount * WHITE_W;
  const width = isBlackKey(midi) ? BLACK_W : WHITE_W - GAP;
  return width / (span + 2 * FRUSTUM_MARGIN);
}
