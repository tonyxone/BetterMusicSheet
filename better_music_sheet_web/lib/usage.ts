"use client";

// How long a sheet is open and what is done with it, for the admin
// dashboard's Engagement tab (see ../../usage.py).
//
// A page that shows one sheet - its own page, or the practice page - calls
// useUsage, which starts a session for as long as it shows that sheet. Time
// counts while the page is visible and in use: touched, scrolled or typed in
// within the last IDLE_MS, or playing - a sheet read at the piano gets a page
// turned now and then, and a tab left open overnight shouldn't count. The
// controls call countUsage. Every REPORT_MS, and whenever the page is hidden
// or left, what is new goes to POST /api/usage; a report that fails waits
// for the next.

import { useEffect, useRef } from "react";
import { clientApiFetch } from "./client-api";

export type UsageSurface = "sheet" | "practice";

/** The same names usage.py's EVENTS accepts. */
export type UsageEvent =
  | "play" | "measure" | "step" | "scrub" | "speed" | "tempo" | "balance" | "instrument" | "sound"
  | "paywall" | "notation" | "view" | "download" | "edit";

export type UsageReport = {
  seconds: number;
  playing_seconds: number;
  events: Partial<Record<UsageEvent, number>>;
};

export const IDLE_MS = 5 * 60_000;
const REPORT_MS = 60_000;
const TICK_MS = 1_000;
/** The longest one tick may add: a sleeping laptop or a stalled timer
 * shouldn't count the gap. */
const MAX_TICK_MS = 5_000;
/** The same control used again within this counts once: a slider dragged is
 * one use, not one per step. */
export const REPEAT_MS = 2_000;
/** usage.py's MAX_REPORT_SECONDS: what is held over beyond it is dropped. */
const MAX_REPORT_SECONDS = 600;

const INPUTS = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart"] as const;

/** One session's count of time and control uses not yet reported. */
export class UsageMeter {
  private activeMs = 0;
  private playingMs = 0;
  private events: Partial<Record<UsageEvent, number>> = {};
  private lastCounted: Partial<Record<UsageEvent, number>> = {};
  private lastInput: number;
  private lastTick: number;

  constructor(now: number) {
    // Opening the page is itself a sign someone is there.
    this.lastInput = now;
    this.lastTick = now;
  }

  input(now: number) {
    this.lastInput = now;
  }

  /** Time has passed: count it if the page was in use. */
  tick(now: number, visible: boolean, playing: boolean) {
    const elapsed = Math.min(Math.max(0, now - this.lastTick), MAX_TICK_MS);
    this.lastTick = now;
    if (!visible) return;
    if (playing) {
      this.activeMs += elapsed;
      this.playingMs += elapsed;
    } else {
      // Only the part of it before the page went idle.
      this.activeMs += Math.min(elapsed, Math.max(0, this.lastInput + IDLE_MS - (now - elapsed)));
    }
  }

  count(event: UsageEvent, now: number) {
    this.input(now);
    const last = this.lastCounted[event];
    if (last !== undefined && now - last < REPEAT_MS) return;
    this.lastCounted[event] = now;
    this.events[event] = (this.events[event] ?? 0) + 1;
  }

  /** What there is to report, taken out of the meter - whole seconds, the
   * rest kept for next time - or null when nothing happened. */
  take(): UsageReport | null {
    const seconds = Math.min(MAX_REPORT_SECONDS, Math.floor(this.activeMs / 1000));
    const playing = Math.min(seconds, Math.floor(this.playingMs / 1000));
    const events = this.events;
    if (!seconds && !Object.keys(events).length) return null;
    this.activeMs = Math.max(0, this.activeMs - seconds * 1000);
    this.playingMs = Math.max(0, this.playingMs - playing * 1000);
    this.events = {};
    return { seconds, playing_seconds: playing, events };
  }

  /** Put back a report that couldn't be sent, to go with the next one. */
  restore(report: UsageReport) {
    this.activeMs = Math.min(MAX_REPORT_SECONDS * 1000, this.activeMs + report.seconds * 1000);
    this.playingMs = Math.min(this.activeMs, this.playingMs + report.playing_seconds * 1000);
    for (const [event, count] of Object.entries(report.events) as [UsageEvent, number][]) {
      this.events[event] = Math.min(1000, (this.events[event] ?? 0) + count);
    }
  }
}

/** The meter of the session open now, if any, for countUsage. */
let current: UsageMeter | null = null;

/** Count one use of a control on the page open now. */
export function countUsage(event: UsageEvent) {
  current?.count(event, Date.now());
}

/** Count time on this sheet while the page shows it. `jobId` null (still
 * loading, say) counts nothing; `playing` is whether it is sounding. */
export function useUsage(jobId: string | null, surface: UsageSurface, playing = false) {
  const playingRef = useRef(playing);
  useEffect(() => { playingRef.current = playing; });

  useEffect(() => {
    if (!jobId) return;
    const sessionId = crypto.randomUUID();
    const meter = new UsageMeter(Date.now());
    current = meter;
    const visible = () => document.visibilityState === "visible";

    function send(keepalive: boolean) {
      meter.tick(Date.now(), visible(), playingRef.current);
      const report = meter.take();
      if (!report) return;
      clientApiFetch("/api/usage", {
        method: "POST", headers: { "Content-Type": "application/json" }, keepalive,
        body: JSON.stringify({ session_id: sessionId, job_id: jobId, surface, ...report }),
      }).then(
        // Refused (the sheet is gone, say): sending it again won't help.
        (res) => { if (!res.ok && res.status !== 404 && res.status !== 422) meter.restore(report); },
        () => meter.restore(report),
      );
    }

    const onInput = () => meter.input(Date.now());
    const onVisibility = () => {
      if (visible()) {
        // Time hidden isn't counted, and coming back is a sign of life.
        meter.tick(Date.now(), false, false);
        meter.input(Date.now());
      } else {
        send(true);
      }
    };
    const onLeave = () => send(true);
    const ticker = setInterval(() => meter.tick(Date.now(), visible(), playingRef.current), TICK_MS);
    const reporter = setInterval(() => send(false), REPORT_MS);
    for (const type of INPUTS) window.addEventListener(type, onInput, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onLeave);
    return () => {
      clearInterval(ticker);
      clearInterval(reporter);
      for (const type of INPUTS) window.removeEventListener(type, onInput, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onLeave);
      send(true);
      if (current === meter) current = null;
    };
  }, [jobId, surface]);
}
