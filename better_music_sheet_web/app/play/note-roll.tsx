"use client";

// Falling notes: a Synthesia-style lane where each note descends toward the
// key it will be played on, arriving exactly as it sounds.
//
// Plain 2D canvas rather than part of the keyboard's three.js scene. The
// keyboard's camera is orthographic and tilted only about X, so horizontal
// position maps linearly to the screen - which means a flat canvas can line
// its lanes up with the keys exactly (see keyboard-layout.ts), while rounded
// bars and the landing flash stay trivial to draw.
//
// Time is read straight from the audio clock every frame rather than from
// React state: the position has to be continuous, and pushing 60 updates a
// second through state would re-render the whole page to move some pixels.

import { useEffect, useRef } from "react";
import type { Timeline } from "@/lib/timeline";
import {
  CSS_LEFT_ON_DARK,
  CSS_RIGHT_ON_DARK,
  isBlackKey,
  keyLayout,
  normalizedKeyWidth,
  normalizedKeyX,
  normalizedOctaveLines,
} from "./keyboard-layout";
import { LEAD_IN_BEATS } from "./playback";

/** How much music is in view above the keys. Shared with playback.ts's
 * count-in, which delays the very first note by exactly this many beats -
 * so the first note starts at the top of the roll and arrives at the hit
 * line exactly as it's due to sound. A shorter window here would make it
 * pop in mid-air; a longer one would make it wait at the bottom in silence.
 * Four beats otherwise reads as the right compromise: enough warning to read
 * ahead, while a 16th note is still a bar you can see rather than a line. */
const BEATS_AHEAD = LEAD_IN_BEATS;

/** A sliver below the hit line, so a note stays visible for a moment after it
 * lands instead of vanishing at the instant you need to see it. */
const BEATS_BEHIND = 0.45;

/** Grace notes have no duration; give them a bar you can actually see. */
const MIN_BAR_BEATS = 0.12;

/** How long the flash at the hit line lasts, in beats. */
const FLASH_BEATS = 0.35;

function roundedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
}

export function NoteRoll({
  timeline,
  getBeat,
  lockedFromBeat,
}: {
  timeline: Timeline;
  /** The live position, in beats. Called once per frame - it must be cheap
   * and must not allocate. */
  getBeat: () => number;
  /** Where a signed-out visitor's preview ends, or null when unrestricted.
   * Notes past it are drawn muted, matching the dimmed measures on the sheet. */
  lockedFromBeat: number | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read inside the animation frame, so changing either doesn't restart it.
  const getBeatRef = useRef(getBeat);
  const lockedRef = useRef(lockedFromBeat);
  useEffect(() => {
    getBeatRef.current = getBeat;
    lockedRef.current = lockedFromBeat;
  }, [getBeat, lockedFromBeat]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const layout = keyLayout();
    const octaveLines = normalizedOctaveLines(layout);
    // Sorted once: the draw loop binary-searches this to find the first note
    // in view, so a 5,000-note piece costs the same as a 50-note one.
    const notes = [...timeline.notes].sort((a, b) => a.start_beat - b.start_beat);

    let width = 0;
    let height = 0;
    let raf = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // The canvas's own box, not the host's clientWidth: clientWidth
      // *includes* padding, and the host is inset to line up with the
      // keyboard, so using it drew a canvas wider than its container that
      // overflowed to the right - putting every lane off its key.
      // CSS sizes the canvas; only the backing store is set here.
      const box = canvas.getBoundingClientRect();
      width = box.width || 1;
      height = box.height || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    /** Index of the first note that could still be on screen. */
    const firstVisible = (from: number) => {
      let lo = 0;
      let hi = notes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        // A long note starting well before the window can still reach into
        // it, so back the cut-off off by a generous bar length rather than
        // testing start_beat alone.
        if (notes[mid].start_beat < from - 8) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!width || !height) return;

      const beat = getBeatRef.current();
      const locked = lockedRef.current;
      // The hit line sits at the very bottom: notes meet the keys directly
      // below, so the lane reads as continuous with the keyboard.
      const pxPerBeat = height / (BEATS_AHEAD + BEATS_BEHIND);
      const hitY = height - BEATS_BEHIND * pxPerBeat;

      ctx.clearRect(0, 0, width, height);

      // Octave divisions, drawn first so the bars sit over them. They give the
      // eye somewhere to anchor: a lane 40 keys along is otherwise impossible
      // to place without counting.
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const f of octaveLines) {
        const x = Math.round(f * width) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      ctx.stroke();

      const windowStart = beat - BEATS_BEHIND;
      const windowEnd = beat + BEATS_AHEAD;
      const start = firstVisible(windowStart);

      // Black-key lanes overlap their white neighbours, exactly as the keys
      // themselves do, so they are drawn in a second pass and sit on top -
      // otherwise whichever note happened to start later would win. A third
      // pass puts every flash above every bar. Three cheap loops rather than
      // one loop plus a sort, so nothing is allocated per frame.
      const pass = (phase: 0 | 1 | 2) => {
        for (let i = start; i < notes.length; i++) {
          const n = notes[i];
          if (n.start_beat > windowEnd) break;
          if (phase < 2 && isBlackKey(n.midi) !== (phase === 1)) continue;

          const beats = Math.max(
            MIN_BAR_BEATS,
            n.is_grace || n.duration_beats <= 0 ? 0 : n.duration_beats,
          );
          if (n.start_beat + beats < windowStart) continue;

          // y grows downward as the note approaches, so the bar's *bottom* is
          // its onset and its top is where it ends.
          const bottom = hitY + (beat - n.start_beat) * pxPerBeat;
          const top = bottom - beats * pxPerBeat;
          if (top > height || bottom < 0) continue;

          const cx = normalizedKeyX(layout, n.midi) * width;
          const w = normalizedKeyWidth(layout, n.midi) * width;
          const past = locked !== null && n.start_beat >= locked;

          if (phase === 2) {
            // The moment of the strike, fading as it crosses the line.
            const since = beat - n.start_beat;
            if (past || since < 0 || since >= FLASH_BEATS) continue;
            ctx.globalAlpha = 1 - since / FLASH_BEATS;
            ctx.fillStyle = "#ffffff";
            roundedBar(ctx, cx - w / 2, hitY - 5, w, 10, 3);
            continue;
          }

          ctx.globalAlpha = past ? 0.22 : 1;
          ctx.fillStyle = n.role === 1 ? CSS_LEFT_ON_DARK : CSS_RIGHT_ON_DARK;
          // Clipped to the visible part: a whole note can be many screens
          // tall, and handing the canvas a bar with a huge negative top is
          // wasted work.
          const drawTop = Math.max(top, -8);
          roundedBar(ctx, cx - w / 2, drawTop, w, Math.min(bottom, height + 8) - drawTop, 3);
        }
      };

      pass(0);
      pass(1);
      pass(2);

      ctx.globalAlpha = 1;

      // The line the notes land on. Drawn last so bars pass behind it.
      ctx.strokeStyle = "rgba(255,255,255,0.34)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, hitY + 0.5);
      ctx.lineTo(width, hitY + 0.5);
      ctx.stroke();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [timeline]);

  return (
    <div className="note-roll" ref={hostRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

export default NoteRoll;
