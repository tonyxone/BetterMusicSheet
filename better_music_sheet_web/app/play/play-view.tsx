"use client";

// The Play page: annotated sheet on top, 88-key keyboard below.
//
// Press play and the piece sounds while its keys light up; click a measure
// and the keyboard holds every distinct pitch in it. The two are mutually
// exclusive - clicking a measure pauses playback, since a held snapshot and a
// moving highlight would be reading the same keyboard two different ways.
//
// three.js and pdf.js are only imported from here, dynamically, so neither
// reaches any other route's bundle.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { clientApiFetch } from "@/lib/client-api";
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
  const [speed, setSpeed] = useState(1);
  const [activeMidis, setActiveMidis] = useState<number[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

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
        if (tlRes.status === 404) {
          throw new Error("Playback isn't available for this sheet.");
        }
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

  // Tear down audio and timers on unmount - leaving them running would keep an
  // AudioContext and a rAF loop alive after navigating away.
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

  const handlePlayPause = useCallback(() => {
    if (!timeline) return;
    if (playbackRef.current?.isPlaying) {
      playbackRef.current.pause();
      setPlaying(false);
      return;
    }
    // Created on this click, not earlier: browsers only allow an AudioContext
    // to start from a user gesture.
    if (!ctxRef.current) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctor();
      synthRef.current = new SynthEngine(ctxRef.current);
    }
    ctxRef.current.resume().catch(() => {});
    if (!playbackRef.current) {
      playbackRef.current = new Playback(timeline, synthRef.current!, ctxRef.current, {
        onHighlight: setActiveMidis,
        onEnded: () => setPlaying(false),
      });
    }
    setSelected(null);
    playbackRef.current.play(speed);
    setPlaying(true);
  }, [timeline, speed]);

  const handleMeasureClick = useCallback((index: number) => {
    if (playbackRef.current?.isPlaying) {
      playbackRef.current.pause();
      setPlaying(false);
    }
    setSelected(index);
    setTimeline((tl) => {
      if (tl) setActiveMidis(tl.measures[index]?.distinct_midis ?? []);
      return tl;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(null);
    setActiveMidis([]);
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

  const selectedMeasure = selected !== null ? timeline.measures[selected] : null;

  return (
    <div className="play-view">
      <div className="play-sheet">
        <SheetCanvas
          pdfData={pdfData}
          measures={timeline.measures}
          selectedIndex={selected}
          onMeasureClick={handleMeasureClick}
        />
      </div>

      <div className="play-transport">
        <button className="btn-pill" onClick={handlePlayPause}>
          {playing ? "Pause" : "Play"}
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
        {selectedMeasure ? (
          <span className="play-status">
            Measure {selectedMeasure.label || selectedMeasure.index + 1}
            {" · "}
            {selectedMeasure.distinct_midis.length} note
            {selectedMeasure.distinct_midis.length === 1 ? "" : "s"}
            <button className="play-clear" onClick={clearSelection}>clear</button>
          </span>
        ) : (
          <span className="play-status subtle">Click a measure to see its notes</span>
        )}
      </div>

      <div className="play-keyboard">
        <Keyboard3D activeMidis={activeMidis} />
      </div>
    </div>
  );
}

export default PlayView;
