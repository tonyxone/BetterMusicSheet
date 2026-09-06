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
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { clientApiFetch } from "@/lib/client-api";
import { isAuthConfigured } from "@/lib/auth";
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

export function PlayView() {
  const router = useRouter();
  const jobId = useSearchParams().get("job");
  const { user, loading } = useAuth();

  // Gate the whole route, not just the links into it - otherwise a bookmark,
  // a shared URL or the back button walks straight past the check.
  if (loading) return <p className="wrap" style={{ color: "var(--ink-soft)" }}>Loading…</p>;
  if (!user) return <SignInGate />;

  return jobId ? <Player jobId={jobId} /> : <SheetPicker onPick={(id) => router.push(`/play?job=${id}`)} />;
}

/** Shown instead of the player to a signed-out visitor. */
function SignInGate() {
  const { openSignIn } = useAuth();
  return (
    <div className="wrap" style={{ textAlign: "center" }}>
      <div className="play-gate-icon">🎹</div>
      <h1 className="serif" style={{ fontSize: 26, fontWeight: 600, margin: "0 0 8px" }}>
        Sign in to use the keyboard
      </h1>
      <p style={{ color: "var(--ink-soft)", margin: "0 auto 26px", maxWidth: 420, lineHeight: 1.5 }}>
        Playback and the piano keyboard are for signed-in accounts. Annotating and
        downloading sheets still work without one.
      </p>
      {isAuthConfigured ? (
        <button type="button" className="btn-pill" onClick={openSignIn}>
          Sign in
        </button>
      ) : (
        <p style={{ color: "var(--ink-soft)", fontSize: 14 }}>
          Sign-in isn&apos;t configured on this deployment.
        </p>
      )}
      <div style={{ marginTop: 22 }}>
        <Link href="/" style={{ color: "var(--accent)" }}>Back to uploading</Link>
      </div>
    </div>
  );
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
  const [speed, setSpeed] = useState(1);
  const [showKeyNames, setShowKeyNames] = useState(false);
  const [activeMidis, setActiveMidis] = useState<number[]>([]);
  /** The measure being repeated, if any. */
  const [loopMeasure, setLoopMeasure] = useState<number | null>(null);
  /** The measure sounding right now, from the playback clock. */
  const [playingMeasure, setPlayingMeasure] = useState<number | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const synthRef = useRef<SynthEngine | null>(null);
  const playbackRef = useRef<Playback | null>(null);

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
          onEnded: () => setPlaying(false),
        });
      }
      return playbackRef.current;
    },
    [],
  );

  const playWholePiece = useCallback(
    (fromBeat?: number) => {
      if (!timeline) return;
      const pb = ensurePlayback(timeline);
      setLoopMeasure(null);
      pb.play(speed, fromBeat === undefined ? {} : { fromBeat });
      setPlaying(true);
    },
    [timeline, ensurePlayback, speed],
  );

  const loopOneMeasure = useCallback(
    (index: number) => {
      if (!timeline) return;
      const m = timeline.measures[index];
      if (!m || m.length_beats <= 0) return;
      const pb = ensurePlayback(timeline);
      setLoopMeasure(index);
      pb.play(speed, {
        loop: { startBeat: m.start_beat, endBeat: m.start_beat + m.length_beats },
      });
      setPlaying(true);
    },
    [timeline, ensurePlayback, speed],
  );

  const handlePlayPause = useCallback(() => {
    if (!timeline) return;
    if (playbackRef.current?.isPlaying) {
      playbackRef.current.pause();
      setPlaying(false);
      return;
    }
    // Resume whatever mode we were in - repeating a measure stays repeating.
    if (loopMeasure !== null) loopOneMeasure(loopMeasure);
    else playWholePiece();
  }, [timeline, loopMeasure, loopOneMeasure, playWholePiece]);

  /** Step to the next measure, keeping the current mode. */
  const handleForward = useCallback(() => {
    if (!timeline) return;
    const playable = timeline.measures.filter((m) => m.length_beats > 0);
    if (!playable.length) return;

    const from = loopMeasure ?? playingMeasure;
    let next: number;
    if (from === null) {
      next = playable[0].index;
    } else {
      const after = playable.find((m) => m.index > from);
      next = after ? after.index : playable[0].index; // wrap around
    }

    if (loopMeasure !== null || !playbackRef.current?.isPlaying) {
      loopOneMeasure(next);
    } else {
      playWholePiece(timeline.measures[next].start_beat);
    }
  }, [timeline, loopMeasure, playingMeasure, loopOneMeasure, playWholePiece]);

  const handleMeasureClick = useCallback(
    (index: number) => {
      // Clicking the measure that is already repeating stops it, so the same
      // click both starts and clears the loop.
      if (loopMeasure === index && playbackRef.current?.isPlaying) {
        playbackRef.current.pause();
        setPlaying(false);
        return;
      }
      loopOneMeasure(index);
    },
    [loopMeasure, loopOneMeasure],
  );

  const stopLoop = useCallback(() => {
    playbackRef.current?.stop();
    setLoopMeasure(null);
    setPlaying(false);
  }, []);

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

  const loopLabel =
    loopMeasure !== null
      ? timeline.measures[loopMeasure]?.label || String(loopMeasure + 1)
      : null;

  return (
    <div className="play-view">
      <div className="play-sheet">
        <SheetCanvas
          pdfData={pdfData}
          measures={timeline.measures}
          playingIndex={playingMeasure}
          loopIndex={loopMeasure}
          onMeasureClick={handleMeasureClick}
        />
      </div>

      <div className="play-transport">
        <button className="btn-pill" onClick={handlePlayPause}>
          {playing ? "Pause" : "Play"}
        </button>
        <button className="btn-pill ghost" onClick={handleForward} title="Next measure">
          Next measure ▸
        </button>

        <label className="play-speed">
          Speed
          <input
            type="range"
            min={0.5}
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

        {loopLabel ? (
          <span className="play-status">
            Repeating measure {loopLabel}
            <button className="play-clear" onClick={stopLoop}>stop</button>
          </span>
        ) : (
          <span className="play-status subtle">Click a measure to repeat it</span>
        )}
      </div>

      <div className="play-keyboard">
        <Keyboard3D activeMidis={activeMidis} showKeyNames={showKeyNames} />
      </div>
    </div>
  );
}

export default PlayView;
