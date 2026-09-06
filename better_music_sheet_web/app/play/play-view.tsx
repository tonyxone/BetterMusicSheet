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
import { useAuth } from "../auth-context";
import type { AnnotationJob } from "@/lib/api";
import type { Timeline, TimelineNote } from "@/lib/timeline";
import { SynthEngine } from "./synth";
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

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5a1 1 0 0 1 1.53-.85l9 6.5a1 1 0 0 1 0 1.7l-9 6.5A1 1 0 0 1 8 18.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
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
            <button key={job.job_id} className="history-row" onClick={() => onPick(job.job_id)}>
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
function notesAtBeat(timeline: Timeline, beat: number) {
  return timeline.notes.filter((n) => {
    const len = n.is_grace || n.duration_beats <= 0 ? 0.25 : n.duration_beats;
    return beat >= n.start_beat - 1e-9 && beat < n.start_beat + len;
  });
}

function measureIndexAt(timeline: Timeline, beat: number) {
  const m = timeline.measures.find(
    (mm) => beat >= mm.start_beat && beat < mm.start_beat + mm.length_beats,
  );
  return m ? m.index : null;
}

function Player({ jobId }: { jobId: string }) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [playing, setPlaying] = useState(false);
  // Full speed by default, with every key labelled; the slider still goes
  // down to 0.1x for picking a passage apart.
  const [speed, setSpeed] = useState(1);
  const [showKeyNames, setShowKeyNames] = useState(true);
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
    Promise.all([
      clientApiFetch(`/api/sheets/${jobId}/timeline`),
      clientApiFetch(`/api/sheets/${jobId}/download?inline=1`),
    ])
      .then(async ([tlRes, pdfRes]) => {
        if (cancelled) return;
        if (tlRes.status === 404) throw new Error("Playback isn't available for this sheet.");
        if (!tlRes.ok) throw new Error(`couldn't load playback data (${tlRes.status})`);
        if (!pdfRes.ok) throw new Error(`couldn't load the sheet (${pdfRes.status})`);
        const [tl, pdf] = await Promise.all([tlRes.json(), pdfRes.arrayBuffer()]);
        if (cancelled) return;
        setTimeline(tl);
        setPdfData(pdf);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Tear down audio and timers on unmount - otherwise an AudioContext and a
  // rAF loop keep running after navigating away.
  useEffect(() => {
    return () => {
      playbackRef.current?.dispose();
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
    (tl: Timeline) => {
      if (!ctxRef.current) {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctxRef.current = new Ctor();
        synthRef.current = new SynthEngine(ctxRef.current);
      }
      ctxRef.current.resume().catch(() => {});
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
      return playbackRef.current;
    },
    [openSignIn],
  );

  const playWholePiece = useCallback(
    (fromBeat?: number) => {
      if (!timeline) return;
      const pb = ensurePlayback(timeline);
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
    if (playbackRef.current?.isPlaying) {
      playbackRef.current.pause();
      setPlaying(false);
      return;
    }
    // No argument: playback picks up from the beat it was paused at, rather
    // than restarting the measure that was underway.
    playWholePiece();
  }, [timeline, playWholePiece]);

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
  if (!timeline || !pdfData) {
    return <p className="wrap" style={{ color: "var(--ink-soft)" }}>Loading…</p>;
  }

  return (
    <div className="play-view">
      <div className="play-sheet">
        <SheetCanvas
          pdfData={pdfData}
          measures={timeline.measures}
          playingIndex={playingMeasure}
          lockedFromIndex={lockedFrom}
          activeNotes={activeNotes}
          onMeasureClick={handleMeasureClick}
        />
      </div>

      <div className="play-scrub">
        <input
          type="range"
          min={0}
          max={Math.max(1, timeline.total_beats)}
          step={0.05}
          value={Math.min(beat, timeline.total_beats)}
          aria-label="Position in the piece"
          // While the pointer is down the input owns the value; letting the
          // playback clock write back mid-drag would fight the thumb.
          onPointerDown={() => { scrubbingRef.current = true; }}
          onPointerUp={() => { scrubbingRef.current = false; }}
          onPointerCancel={() => { scrubbingRef.current = false; }}
          onChange={(e) => handleScrub(Number(e.target.value))}
        />
        <span className="play-time">
          {/* Measures, not a clock: beats are not seconds, and the piece has
              no real tempo to convert with (see timeline.py). */}
          Measure {(measureIndexAt(timeline, beat) ?? 0) + 1} / {playableMeasureCount}
        </span>
      </div>

      <div className="play-transport">
        <button
          className="btn-pill icon"
          onClick={handlePlayPause}
          title={playing ? "Pause" : "Play"}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <label className="play-speed">
          Speed
          <input
            type="range"
            min={0.1}
            max={2}
            step={0.1}
            value={speed}
            // Remapping an in-flight schedule mid-note is more complexity than
            // it's worth here, so speed applies to the next Play.
            disabled={playing}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
          <span>{speed.toFixed(1)}x</span>
        </label>

        <label className="play-toggle">
          <input
            type="checkbox"
            checked={showKeyNames}
            onChange={(e) => setShowKeyNames(e.target.checked)}
          />
          Key names
        </label>


      </div>

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
