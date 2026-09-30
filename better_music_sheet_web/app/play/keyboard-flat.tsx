"use client";

// The keyboard drawn as plain HTML, for browsers that can't give the 3D one a
// WebGL context - hardware acceleration turned off, a GPU the browser has
// blocklisted, or a driver that won't start. Without it the page had nothing
// to show there, and a failed WebGLRenderer took the whole Play page down.
//
// Keys are placed with the same fractions the note roll uses for its lanes
// (keyboard-layout.ts), so the falling notes still land on the right key.

import { useMemo } from "react";
import type { ActiveKey } from "./keyboard-3d";
import {
  CSS_LEFT,
  CSS_RIGHT,
  FIRST_MIDI,
  LAST_MIDI,
  isBlackKey,
  keyLayout,
  normalizedKeyWidth,
  normalizedKeyX,
  keyLabel,
} from "./keyboard-layout";
import type { Notation } from "@/lib/notation";

const WHITE = "#fbf9f4";
const BLACK = "#1c1613";

export function FlatKeyboard({
  activeKeys,
  showKeyNames = false,
  notation = "letters",
  keyFifths = 0,
}: {
  activeKeys: ActiveKey[];
  showKeyNames?: boolean;
  notation?: Notation;
  /** The key signature playback is in, for jianpu names. */
  keyFifths?: number;
}) {
  const layout = useMemo(() => keyLayout(), []);

  // Same rule as the 3D board: a pitch both hands play takes the right hand's colour.
  const roleOf = useMemo(() => {
    const roles = new Map<number, number>();
    for (const k of activeKeys) {
      if (!roles.has(k.midi) || k.role === 0) roles.set(k.midi, k.role);
    }
    return roles;
  }, [activeKeys]);

  const keys = useMemo(() => {
    const out: { midi: number; black: boolean; left: number; width: number }[] = [];
    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      const width = normalizedKeyWidth(layout, midi);
      out.push({ midi, black: isBlackKey(midi), left: normalizedKeyX(layout, midi) - width / 2, width });
    }
    // Black keys after white ones, so they paint on top.
    return [...out.filter((k) => !k.black), ...out.filter((k) => k.black)];
  }, [layout]);

  return (
    <div className="keyboard-3d keyboard-flat">
      {keys.map((k) => {
        const role = roleOf.get(k.midi);
        const base = k.black ? BLACK : WHITE;
        const background = role === undefined ? base
          : `color-mix(in srgb, ${role === 1 ? CSS_LEFT : CSS_RIGHT} ${k.black ? 88 : 70}%, ${base})`;
        return (
          <div
            key={k.midi}
            className={`flat-key${k.black ? " black" : ""}${role !== undefined ? " lit" : ""}`}
            style={{ left: `${k.left * 100}%`, width: `${k.width * 100}%`, background }}
          >
            {showKeyNames && <span>{keyLabel(k.midi, notation, keyFifths)}</span>}
          </div>
        );
      })}
    </div>
  );
}
