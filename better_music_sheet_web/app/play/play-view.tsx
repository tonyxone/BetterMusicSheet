"use client";

// The Play page: annotated sheet on top, 88-key keyboard below.
//
// Play runs the whole piece; clicking a measure repeats just that measure
// until you stop it. Either way the keyboard shows only what is sounding at
// this instant, and the measure being played is outlined on the sheet.
//
// three.js and pdf.js are only imported from here, dynamically, so neither
// reaches any other route's bundle.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { clientApiFetch } from "@/lib/client-api";
import { fetchSheetFile } from "@/lib/sheet-files";
import { useAuth } from "../auth-context";
import type { AnnotationJob } from "@/lib/api";
import type { Timeline, TimelineNote } from "@/lib/timeline";
import { notesAtBeat, measureIndexAt } from "@/lib/timeline";
import { applyCorrections, validCorrection } from "@/lib/corrections";
import type { Corrections } from "@/lib/corrections";
import { tempoClock, tempoControl } from "./tempo";
import { GRACE_SECONDS, SynthEngine, INSTRUMENTS, isInstrumentId, type InstrumentId } from "./synth";
import { Playback } from "./playback";

// ssr:false is required, not just an optimization: both touch WebGL/Worker
// APIs that don't exist during the static export's prerender pass.
const Keyboard3D = dynamic(() => import("./keyboard-3d"), {
  ssr: false,
  loading: () => <div className="keyboard-3d" />,
});
const SheetCanvas = dynamic(() => import("./sheet-canvas"), {
  ssr: false,
  loading: () => <p className="play-hint">Loading the sheet…</p>,
});
const NoteRoll = dynamic(() => import("./note-roll"), {
  ssr: false,
  loading: () => <div className="note-roll" />,
});

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5a1 1 0 0 1 1.53-.85l9 6.5a1 1 0 0 1 0 1.7l-9 6.5A1 1 0 0 1 8 18.5z" />
    </svg>
  );
}

/** Step forward: the play triangle stopped against a bar. */
function StepForwardIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <path d="M6.5 5.8 15.6 12 6.5 18.2z" />
      <rect x="16.6" y="5.6" width="2.5" height="12.8" rx="1.1" />
    </svg>
  );
}

/** Its mirror image, so the pair reads as one control. */
function StepBackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <path d="M17.5 5.8 8.4 12 17.5 18.2z" />
      <rect x="4.9" y="5.6" width="2.5" height="12.8" rx="1.1" />
    </svg>
  );
}

/** A disclosure triangle; rotated by CSS when its panel is open. */
function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
      <path d="M9 5.5 16.5 12 9 18.5z" />
    </svg>
  );
}

/** One collapsible section of the page.
 *
 * Both sections share the space left over by the transport and keyboard, in
 * proportion to `grow`. Collapsing one gives its room to the other rather
 * than leaving a hole, which is the whole point: the sheet and the falling
 * notes are two ways of reading the same thing, and how much of each you want
 * changes as you practise. */
function Panel({
  title,
  label,
  open,
  onToggle,
  grow,
  flush = false,
  dark = false,
  children,
}: {
  /** Shown in the header. Omit for a panel whose content speaks for itself -
   * the chevron alone is then the whole header. */
  title?: string;
  /** Accessible name when there is no visible title. */
  label?: string;
  open: boolean;
  onToggle: () => void;
  grow: number;
  /** Skip the inner padding, for a child that paints to its own edges. */
  flush?: boolean;
  /** Dark surface, for the note roll. */
  dark?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`play-panel${open ? " open" : ""}${dark ? " dark" : ""}`}
      // Only a growing panel needs a basis of 0; a closed one is sized by its
      // header alone, so it must not grow at all.
      style={open ? { flex: `${grow} 1 0` } : { flex: "none" }}
    >
      <button
        type="button"
        className="play-panel-head"
        onClick={onToggle}
        title={`${open ? "Collapse" : "Expand"} ${title ?? label}`}
        aria-expanded={open}
        aria-label={title ?? label}
      >
        <ChevronIcon />
        {title && <span>{title}</span>}
      </button>
      {/* Unmounted rather than hidden when closed: the roll runs an animation
          frame loop and the sheet holds a pdf.js document, and neither should
          keep working behind a collapsed header. */}
      {open && <div className={`play-panel-body${flush ? " flush" : ""}`}>{children}</div>}
    </section>
  );
}

/** A keyboard key with a letter on it - the thing the toggle turns on. */
function KeyNamesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <rect
        x="4.5" y="4.5" width="15" height="15" rx="3.5"
        fill="none" stroke="currentColor" strokeWidth="1.6"
      />
      <text
        x="12" y="16.2" textAnchor="middle"
        fontSize="10.5" fontWeight="700" fill="currentColor"
        fontFamily="inherit"
      >
        A
      </text>
    </svg>
  );
}

function SpeakerOnIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path d="M4 9.5h3.1L12 5.6v12.8L7.1 14.5H4z" fill="currentColor" />
      <path
        d="M15.4 9.4a3.7 3.7 0 0 1 0 5.2M17.9 6.9a7.2 7.2 0 0 1 0 10.2"
        fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
      />
    </svg>
  );
}

function SpeakerOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path d="M4 9.5h3.1L12 5.6v12.8L7.1 14.5H4z" fill="currentColor" />
      <path
        d="M15.6 9.8l4.6 4.6M20.2 9.8l-4.6 4.6"
        fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
      />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <rect x="7" y="5" width="3.6" height="14" rx="1.2" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" />
    </svg>
  );
}

/** How many printed lines (systems) a signed-out visitor can play before
 * being asked to sign in. Lines rather than measures because that is the unit
 * someone reading the sheet actually sees. */
const FREE_LINES = 2;

export function PlayView() {
  const router = useRouter();
  const jobId = useSearchParams().get("job");
  return jobId ? <Player jobId={jobId} /> : <SheetPicker onPick={(id) => router.push(`/play?job=${id}`)} />;
}

/** Landing state: which of your annotated sheets do you want to play? */
function SheetPicker({ onPick }: { onPick: (jobId: string) => void }) {
  const [jobs, setJobs] = useState<AnnotationJob[] | null>(null);

  useEffect(() => {
    clientApiFetch("/api/sheets")
      .then((res) => (res.ok ? res.json() : []))
      .then((all: AnnotationJob[]) => setJobs(all.filter((j) => j.status === "done")))
      .catch(() => setJobs([]));
  }, []);

  return (
    <div className="wrap medium">
      <h1 className="serif">Play</h1>
      <div className="sub" style={{ marginBottom: 30 }}>
        Hear a sheet play back, with the notes lit up on a keyboard.
      </div>
      {jobs === null ? (
        <p style={{ color: "var(--ink-soft)" }}>Loading…</p>
      ) : jobs.length === 0 ? (
        <div className="history-empty">
          No annotated sheets yet. <Link href="/" style={{ color: "var(--accent)" }}>Upload one first.</Link>
        </div>
      ) : (
        <div>
          {jobs.map((job) => (
            <button
              key={job.job_id}
              className="history-row"
              title={`Play ${job.sheet_name || "this sheet"}`}
              onClick={() => onPick(job.job_id)}
            >
              <div className="history-icon">🎹</div>
              <div className="history-info">
                <div className="history-title">{job.sheet_name}</div>
                <div className="history-meta">{new Date(job.created_at * 1000).toLocaleString()}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** What is sounding at a beat, straight from the timeline. Mirrors
 * Playback.notesAt for the case where nothing has been played yet and so no
 * audio graph exists to ask - scrubbing has to work before the first play. */
function Player({ jobId }: { jobId: string }) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [baseBpm, setBaseBpm] = useState<number | null>(null);
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [playing, setPlaying] = useState(false);
  // Full speed by default; the slider still goes down to 0.1x for picking a
  // passage apart.
  const [speed, setSpeed] = useState(1);
  // What the speed slider actually achieves, after tempoClock's own
  // MAX_EFFECTIVE_BPM clamp - can read lower than `speed` when a BPM
  // override near the ceiling leaves no headroom for it. Falls back to the
  // raw request before the timeline has loaded, when there's nothing to
  // clamp against yet.
  const effectiveSpeed = useMemo(
    () => (timeline ? tempoClock(timeline, speed, baseBpm).rate : speed),
    [timeline, speed, baseBpm],
  );
  const [showKeyNames, setShowKeyNames] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [instrument, setInstrument] = useState<InstrumentId>("grand");
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioError, setAudioError] = useState("");
  const audioRequest = useRef(0);
  const [activeNotes, setActiveNotes] = useState<TimelineNote[]>([]);
  const [beat, setBeat] = useState(0);
  // A ref, not state: the progress callback is created once and must see the
  // current value without being rebuilt on every drag.
  const scrubbingRef = useRef(false);
  /** The measure sounding right now, from the playback clock. */
  const [playingMeasure, setPlayingMeasure] = useState<number | null>(null);

  const { user, openSignIn } = useAuth();

  const ctxRef = useRef<AudioContext | null>(null);
  const synthRef = useRef<SynthEngine | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  /** Set when the current run is the signed-out preview, so reaching the end
   * asks for a sign-in rather than just stopping. */
  const previewRef = useRef(false);

  /** Index of the first measure past the free lines, or null when a visitor
   * can play everything.
   *
   * A "line" is a printed system. Measures on one carry the same page and the
   * same vertical extent, so grouping on that recovers the lines without the
   * backend having to label them. */
  const lockedFrom = useMemo(() => {
    if (user || !timeline) return null;
    const seen: string[] = [];
    for (const m of timeline.measures) {
      if (!m.bbox_pt || m.page === null) continue;
      const line = `${m.page}:${Math.round(m.bbox_pt[1])}`;
      if (!seen.includes(line)) {
        seen.push(line);
        if (seen.length > FREE_LINES) return m.index;
      }
    }
    return null;
  }, [user, timeline]);

  /** A signed-out visitor can play up to here and no further. */
  const freeEndBeat = useMemo(() => {
    if (!timeline) return 0;
    if (lockedFrom === null) return timeline.total_beats;
    const m = timeline.measures.find((x) => x.index === lockedFrom);
    return m ? m.start_beat : timeline.total_beats;
  }, [timeline, lockedFrom]);

  const playableMeasureCount = useMemo(
    () => (timeline ? timeline.measures.filter((m) => m.length_beats > 0).length : 0),
    [timeline],
  );

  const isLocked = useCallback(
    (index: number) => lockedFrom !== null && index >= lockedFrom,
    [lockedFrom],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const tlRes = await fetchSheetFile(jobId, "timeline");
        if (tlRes.status === 404) throw new Error("Playback isn't available for this sheet.");
        if (!tlRes.ok) throw new Error(`couldn't load playback data (${tlRes.status})`);
        const tl = await tlRes.json();
        if (cancelled) return;
        try {
          const savedInstrument = localStorage.getItem("sheet-instrument");
          if (savedInstrument && isInstrumentId(savedInstrument)) setInstrument(savedInstrument);
        } catch { /* Storage is optional. */ }
        let saved: Corrections = {};
        try {
          const raw = JSON.parse(localStorage.getItem(`sheet-corrections:${jobId}`) ?? "{}");
          saved = Object.fromEntries(Object.entries(raw).filter(([, value]) => validCorrection(value))) as Corrections;
        } catch { /* Browser storage may be unavailable. */ }
        setTimeline(applyCorrections(tl, saved));
      } catch (err) {
        console.error("Loading the sheet for playback failed:", err);
        if (!cancelled) setError("Couldn't open this sheet for playback.");
      }
    })();

    // The annotated PDF is a visual aid. Playback is driven entirely by the
    // timeline and remains usable when the preview request or renderer fails.
    void (async () => {
      try {
        const pdfRes = await fetchSheetFile(jobId, "pdf");
        if (!pdfRes.ok) throw new Error(`request failed (${pdfRes.status})`);
        const pdf = await pdfRes.arrayBuffer();
        if (!cancelled) setPdfData(pdf);
      } catch (err) {
        // Read as a flag only - playback carries on without the preview.
        console.error("Loading the sheet preview failed:", err);
        if (!cancelled) setPdfError("unavailable");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Tear down audio and timers on unmount - otherwise an AudioContext and a
  // rAF loop keep running after navigating away.
  useEffect(() => {
    const request = audioRequest;
    return () => {
      playbackRef.current?.dispose();
      request.current++;
      synthRef.current?.dispose();
      ctxRef.current?.close().catch(() => {});
      playbackRef.current = null;
      synthRef.current = null;
      ctxRef.current = null;
    };
  }, []);

  /** Lazily build the audio graph. Must happen inside a click: browsers only
   * let an AudioContext start from a user gesture. */
  const ensurePlayback = useCallback(
    async (tl: Timeline, chosen: InstrumentId = instrument) => {
      const request = ++audioRequest.current;
      if (!ctxRef.current) {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctxRef.current = new Ctor();
        synthRef.current = new SynthEngine(ctxRef.current);
        synthRef.current.setMuted(!soundOn);
      }
      ctxRef.current.resume().catch(() => {});
      setAudioError("");
      setAudioLoading(true);
      setAudioProgress(0);
      if (synthRef.current!.instrumentId !== chosen) {
        playbackRef.current?.pause();
        setPlaying(false);
      }
      try {
        await synthRef.current!.load(chosen, [...tl.notes, ...(tl.audio_notes ?? [])].map((n) => n.midi), setAudioProgress);
      } catch {
        if (request === audioRequest.current) {
          setAudioError("Could not load this instrument. Try again or choose Basic synth (offline).");
          setAudioLoading(false);
        }
        return null;
      }
      if (request !== audioRequest.current || !ctxRef.current) return null;
      setAudioLoading(false);
      if (!playbackRef.current) {
        playbackRef.current = new Playback(tl, synthRef.current!, ctxRef.current, {
          onHighlight: setActiveNotes,
          onProgress: (b) => {
            // Ignore the clock while the thumb is held, or it fights the drag.
            if (!scrubbingRef.current) setBeat(b);
          },
          onMeasure: setPlayingMeasure,
          onEnded: () => {
            setPlaying(false);
            // Reaching the end of the preview is the natural moment to ask.
            if (previewRef.current) {
              previewRef.current = false;
              openSignIn();
            }
          },
        });
      }
      playbackRef.current.setTempo(baseBpm);
      return playbackRef.current;
    },
    [openSignIn, soundOn, baseBpm, instrument],
  );

  // Applies mid-playback too, not just at the next press.
  useEffect(() => {
    synthRef.current?.setMuted(!soundOn);
  }, [soundOn]);

  const playWholePiece = useCallback(
    async (fromBeat?: number) => {
      if (!timeline) return;
      const pb = await ensurePlayback(timeline);
      if (!pb) return;
      // Bound the window rather than stopping once it overruns: notes past
      // the limit are then never scheduled, so nothing audible leaks out.
      previewRef.current = !user;
      pb.play(speed, {
        ...(fromBeat === undefined ? {} : { fromBeat }),
        ...(user ? {} : { untilBeat: freeEndBeat }),
      });
      setPlaying(true);
    },
    [timeline, ensurePlayback, speed, user, freeEndBeat],
  );

  /** Jump to a measure and carry on from there. */
  const playFromMeasure = useCallback(
    (index: number) => {
      if (!timeline) return;
      const m = timeline.measures[index];
      if (!m || m.length_beats <= 0) return;
      if (isLocked(index)) {
        openSignIn();
        return;
      }
      playWholePiece(m.start_beat);
    },
    [timeline, isLocked, openSignIn, playWholePiece],
  );

  const handlePlayPause = useCallback(() => {
    if (!timeline) return;
    if (audioLoading) {
      audioRequest.current++;
      setAudioLoading(false);
      return;
    }
    if (playbackRef.current?.isPlaying) {
      playbackRef.current.pause();
      setPlaying(false);
      return;
    }
    // No argument: playback picks up from the beat it was paused at, rather
    // than restarting the measure that was underway.
    playWholePiece();
  }, [timeline, playWholePiece, audioLoading]);

  const [sheetOpen, setSheetOpen] = useState(true);
  const [rollOpen, setRollOpen] = useState(true);

  /** Whether a step has placed the playhead yet - see step(). */
  const steppedRef = useRef(false);

  // The roll reads the position every animation frame, so it can't go through
  // React state - and a plain closure over `beat` would go stale. A ref keeps
  // one stable callback pointing at the current value.
  const beatRef = useRef(beat);
  useEffect(() => {
    beatRef.current = beat;
  }, [beat]);
  /** Live position for the roll: the audio clock while playing, and the
   * paused/scrubbed position otherwise (Playback.seek keeps that current).
   * leadBeat, not currentBeat: during the count-in at the start of the piece
   * it keeps counting up from below zero instead of pinning at it, which is
   * what lets the first notes fall into place rather than appearing already
   * at the keys. Nothing else reads leadBeat - the sheet, keyboard and
   * scrubber all come from Playback's onProgress/onHighlight/onMeasure
   * callbacks instead, which correctly report nothing until the count-in
   * ends and the piece actually starts sounding.
   *
   * Before the very first Play/Step press, though, no Playback exists yet
   * to run that count-in at all - so without this, the roll would just
   * render its static beat-0..4 window the instant the page loads, notes
   * already sitting there having never fallen. Reporting -Infinity for that
   * one pristine moment keeps it empty until something real has happened.
   * Scoped to `playbackRef.current === null` rather than "paused at 0", so
   * stepping back to the first note later still shows it - that object is
   * created (see ensurePlayback) the first time Play or a step is pressed,
   * and stays alive for the rest of the session from then on. */
  const getBeat = useCallback(() => {
    const pb = playbackRef.current;
    if (!pb) return beatRef.current <= 1e-9 ? Number.NEGATIVE_INFINITY : beatRef.current;
    return pb.leadBeat;
  }, []);

  /** Every distinct onset in the piece, in order - the stops the step buttons
   * walk between. Onsets rather than metrical beats: what you want to land
   * on is the next thing that is actually struck, which in a run of 16ths is
   * four times a beat and during a held chord is not on the next beat at all. */
  const onsetBeats = useMemo(() => {
    if (!timeline) return [];
    return [...new Set(timeline.notes.map((n) => n.start_beat))].sort((a, b) => a - b);
  }, [timeline]);

  /** Move one onset and stop there. Nothing runs on afterwards - this is for
   * walking a passage a note at a time. */
  const step = useCallback(async (direction: 1 | -1) => {
    if (!timeline) return;
    // Must happen inside the click: this may be the first gesture on the
    // page, and the AudioContext can only start from one.
    const pb = await ensurePlayback(timeline);
    if (!pb) return;
    // Stepping is a deliberate stop-and-look, so a running playback gives way
    // rather than the two fighting over the position.
    if (pb.isPlaying) {
      pb.pause();
      setPlaying(false);
    }

    let next: number | undefined;
    if (direction > 0) {
      // The first press lands *on* the opening onset instead of past it: the
      // playhead starts at beat 0 and so does the first note, so "the next
      // onset after here" would skip it. Wraps to the start once past the
      // last onset, so the button never goes dead.
      next =
        !steppedRef.current && beat <= (onsetBeats[0] ?? 0) + 1e-6
          ? onsetBeats[0]
          : onsetBeats.find((b) => b > beat + 1e-6) ?? onsetBeats[0];
    } else {
      // Strictly before the current position, so pausing part-way through a
      // note steps back to the onset you are inside rather than past it to
      // the one before. Clamps at the first onset instead of wrapping round
      // to the end - back at the start of a piece is a mis-click far more
      // often than it is a request to jump to the last bar.
      for (let i = onsetBeats.length - 1; i >= 0; i--) {
        if (onsetBeats[i] < beat - 1e-6) {
          next = onsetBeats[i];
          break;
        }
      }
      next = next ?? onsetBeats[0];
    }
    if (next === undefined) return;
    steppedRef.current = true;

    const measure = measureIndexAt(timeline, next);
    if (measure !== null && isLocked(measure)) {
      openSignIn();
      return;
    }

    // seek() sets the paused position and pushes the highlight/measure for
    // it, so a later Play carries on from where the stepping left off.
    pb.seek(next);

    const synth = synthRef.current;
    const ctx = ctxRef.current;
    if (synth && ctx) {
      // Only what is *struck* here sounds. Notes still ringing from an
      // earlier onset stay lit on the keyboard but aren't re-hammered.
      const struck = timeline.notes.filter((n) => n.attack !== false && Math.abs(n.start_beat - next) < 1e-6);
      const clock = tempoClock(timeline, speed, baseBpm);
      const at = ctx.currentTime + 0.02;
      synth.allOff(); // stepping quickly shouldn't pile voices up
      for (const n of struck) {
        const beats = n.key_duration_beats ?? n.duration_beats;
        // Capped: a whole note held for its full written length just drones
        // while you're reading the next one.
        const seconds = beats > 0 ? Math.min(1.5, clock.secondsAt(n.start_beat + beats) - clock.secondsAt(n.start_beat)) : GRACE_SECONDS;
        synth.noteOn(n.midi, at, at + Math.max(.02, seconds), n.velocity);
      }
    }
  }, [timeline, ensurePlayback, onsetBeats, beat, isLocked, openSignIn, speed, baseBpm]);

  const handleStepBack = useCallback(() => step(-1), [step]);
  const handleStepForward = useCallback(() => step(1), [step]);

  /** Drag the playhead. Locked regions clamp back to the free part and ask
   * for a sign-in, so scrubbing can't be used to walk past the preview. */
  const handleScrub = useCallback(
    (value: number) => {
      if (!timeline) return;
      let target = value;
      if (lockedFrom !== null && target >= freeEndBeat) {
        target = Math.max(0, freeEndBeat - 0.001);
        setBeat(target);
        if (playbackRef.current) playbackRef.current.seek(target);
        else {
          setActiveNotes(notesAtBeat(timeline, target));
          setPlayingMeasure(measureIndexAt(timeline, target));
        }
        openSignIn();
        return;
      }
      setBeat(target);
      const pb = playbackRef.current;
      if (pb) {
        pb.seek(target);
      } else {
        setActiveNotes(notesAtBeat(timeline, target));
        setPlayingMeasure(measureIndexAt(timeline, target));
      }
    },
    [timeline, lockedFrom, freeEndBeat, openSignIn],
  );

  const handleMeasureClick = useCallback(
    (index: number) => playFromMeasure(index),
    [playFromMeasure],
  );

  if (error) {
    return (
      <div className="wrap" style={{ textAlign: "center" }}>
        <p style={{ color: "var(--danger)" }}>{error}</p>
        <Link href="/play" style={{ marginTop: 20, display: "inline-block", color: "var(--accent)" }}>
          Pick another sheet
        </Link>
      </div>
    );
  }
  if (!timeline) {
    return <p className="wrap" style={{ color: "var(--ink-soft)" }}>Loading…</p>;
  }

  return (
    <div className="play-view">
      <Panel title="Sheet" open={sheetOpen} onToggle={() => setSheetOpen((v) => !v)} grow={1}>
        {pdfData ? (
          <SheetCanvas
            pdfData={pdfData}
            measures={timeline.measures}
            playingIndex={playingMeasure}
            lockedFromIndex={lockedFrom}
            notes={timeline.notes}
            beat={beat}
            onMeasureClick={handleMeasureClick}
          />
        ) : (
          <p className="play-hint">
            {pdfError ? "Sheet preview is unavailable, but playback is ready." : "Loading the sheet preview…"}
          </p>
        )}
      </Panel>

      <div className="play-scrub">
        <input
          type="range"
          min={0}
          max={Math.max(1, timeline.total_beats)}
          step={0.05}
          value={Math.max(0, Math.min(beat, timeline.total_beats))}
          aria-label="Position in the piece"
          // While the pointer is down the input owns the value; letting the
          // playback clock write back mid-drag would fight the thumb.
          onPointerDown={() => { scrubbingRef.current = true; }}
          onPointerUp={() => { scrubbingRef.current = false; }}
          onPointerCancel={() => { scrubbingRef.current = false; }}
          onChange={(e) => handleScrub(Number(e.target.value))}
        />
        <span className="play-time">
          {/* A printed measure label plus performed occurrence count. Repeats
              can make the two differ, which is useful information. */}
          Measure {timeline.measures[measureIndexAt(timeline, beat) ?? 0]?.label} · {Math.min((measureIndexAt(timeline, beat) ?? 0) + 1, playableMeasureCount)} / {playableMeasureCount}
        </span>
      </div>

      <div className="play-transport">
        <button
          className="btn-pill icon"
          onClick={handlePlayPause}
          title={audioLoading ? "Cancel loading playback" : playing ? "Pause" : "Play"}
          aria-label={audioLoading ? "Cancel loading playback" : playing ? "Pause" : "Play"}
        >
          {playing || audioLoading ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          className="btn-pill icon"
          onClick={handleStepBack}
          title="Previous note"
          aria-label="Step to the previous note"
        >
          <StepBackIcon />
        </button>
        <button
          className="btn-pill icon"
          onClick={handleStepForward}
          title="Next note"
          aria-label="Step to the next note"
        >
          <StepForwardIcon />
        </button>
        <label className="play-speed">
          Speed
          <input
            type="range"
            min={0.1}
            max={2}
            step={0.1}
            value={speed}
            onChange={(e) => {
              const value = Number(e.target.value);
              setSpeed(value);
              playbackRef.current?.setSpeed(value);
            }}
          />
          {/* The true rate, not just an echo of the slider - a BPM override
              near the ceiling can pull this below what's requested (see
              MAX_EFFECTIVE_BPM in tempo.ts), and showing "2.0x" while it's
              actually playing at 1.0x would read as broken, not capped. */}
          <span title={effectiveSpeed < speed - 1e-6 ? `Capped from ${speed.toFixed(1)}x by the BPM limit` : undefined}>
            {effectiveSpeed.toFixed(1)}x
          </span>
        </label>
        <button
          type="button"
          className={`icon-toggle${showKeyNames ? " on" : ""}`}
          aria-pressed={showKeyNames}
          title={showKeyNames ? "Hide key names" : "Show key names"}
          aria-label={showKeyNames ? "Hide key names" : "Show key names"}
          onClick={() => setShowKeyNames((v) => !v)}
        >
          <KeyNamesIcon />
        </button>

        <button
          type="button"
          className={`icon-toggle${soundOn ? " on" : ""}`}
          aria-pressed={soundOn}
          title={soundOn ? "Mute" : "Unmute"}
          aria-label={soundOn ? "Mute" : "Unmute"}
          onClick={() => setSoundOn((v) => !v)}
        >
          {/* The glyph itself carries the state, so it stays readable even
              where the pressed styling is subtle. */}
          {soundOn ? <SpeakerOnIcon /> : <SpeakerOffIcon />}
        </button>

        <label className="play-speed">
          BPM
          <input
            type="number"
            min={20}
            max={300}
            className="play-tempo-input"
            value={tempoControl(timeline, baseBpm).bpm}
            aria-label={`Base tempo in ${tempoControl(timeline).unit}s per minute`}
            // The score/assumed distinction still matters - it just doesn't need
            // to live in the label text anymore, so it's a hover title instead.
            title={
              timeline.tempo_source === "score"
                ? `Detected from the score (${tempoControl(timeline).unit} beats) - change it to override`
                : "No tempo marking was found on the sheet; this is a default"
            }
            onChange={(e) => {
              const value = Number(e.target.value);
              if (value >= 20 && value <= 300) {
                const quarterBpm = tempoControl(timeline).toQuarterBpm(value);
                setBaseBpm(quarterBpm);
                playbackRef.current?.setTempo(quarterBpm);
              }
            }}
          />
        </label>

        <div className="play-instrument">
          <label>Instrument <select value={instrument} onChange={(e) => {
            const value = e.target.value;
            if (!isInstrumentId(value)) return;
            setInstrument(value);
            try { localStorage.setItem("sheet-instrument", value); } catch { /* Optional. */ }
            void ensurePlayback(timeline, value);
          }}>{INSTRUMENTS.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        </div>

      </div>

      {audioLoading && <p className="play-hint" role="status">Loading samples… {audioProgress}%</p>}
      {audioError && <p className="play-hint" role="alert">{audioError}</p>}

      <Panel
        label="Falling notes"
        open={rollOpen}
        onToggle={() => setRollOpen((v) => !v)}
        grow={1}
        flush
        dark
      >
        <NoteRoll
          timeline={timeline}
          getBeat={getBeat}
          lockedFromBeat={lockedFrom === null ? null : freeEndBeat}
        />
      </Panel>

      <div className="play-keyboard">
        <Keyboard3D
          activeKeys={activeNotes.map((n) => ({ midi: n.midi, role: n.role }))}
          showKeyNames={showKeyNames}
        />
      </div>
    </div>
  );
}

export default PlayView;
