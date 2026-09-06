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
import type { Timeline } from "@/lib/timeline";
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

/** How many measures a signed-out visitor can play before being asked to
 * sign in. They get the real page and a real preview, not a wall. */
const FREE_MEASURES = 3;

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

function Player({ jobId }: { jobId: string }) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [playing, setPlaying] = useState(false);
  // Full speed by default, with every key labelled; the slider still goes
  // down to 0.1x for picking a passage apart.
  const [speed, setSpeed] = useState(1);
  const [showKeyNames, setShowKeyNames] = useState(true);
  const [activeMidis, setActiveMidis] = useState<number[]>([]);
  /** The measure sounding right now, from the playback clock. */
  const [playingMeasure, setPlayingMeasure] = useState<number | null>(null);

  const { user, openSignIn } = useAuth();

  const ctxRef = useRef<AudioContext | null>(null);
  const synthRef = useRef<SynthEngine | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  /** Set when the current run is the signed-out preview, so reaching the end
   * asks for a sign-in rather than just stopping. */
  const previewRef = useRef(false);

  /** A signed-out visitor can play up to here and no further. */
  const freeEndBeat = useMemo(() => {
    if (!timeline) return 0;
    const free = timeline.measures.filter((m) => m.index < FREE_MEASURES);
    if (!free.length) return 0;
    const last = free[free.length - 1];
    return last.start_beat + last.length_beats;
  }, [timeline]);

  const isLocked = useCallback(
    (index: number) => !user && index >= FREE_MEASURES,
    [user],
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
          onHighlight: setActiveMidis,
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
          lockedFromIndex={user ? null : FREE_MEASURES}
          onMeasureClick={handleMeasureClick}
        />
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

        {user ? (
          <span className="play-status subtle">Click a measure to play from there</span>
        ) : (
          <span className="play-status subtle">
            First {FREE_MEASURES} measures free
            <button className="play-clear" onClick={openSignIn}>sign in for the rest</button>
          </span>
        )}
      </div>

      <div className="play-keyboard">
        <Keyboard3D activeMidis={activeMidis} showKeyNames={showKeyNames} />
      </div>
    </div>
  );
}

export default PlayView;
