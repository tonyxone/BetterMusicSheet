"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { clientApiFetch } from "@/lib/client-api";
import { setAdsPaused } from "@/lib/ads";
import { useAuth } from "../auth-context";
import { KeyboardIcon } from "../keyboard-icon";
import type { AnnotationJob } from "@/lib/api";

const POLL_INTERVAL_MS = 2500;

export function JobStatus() {
  const jobId = useSearchParams().get("job");
  const [job, setJob] = useState<AnnotationJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // No AdSense ads while this screen has no real content yet - just a
  // spinner or an error string, not the annotated sheet itself.
  useEffect(() => {
    const hasContent = job?.status === "done" || job?.status === "failed";
    setAdsPaused(!hasContent);
    return () => setAdsPaused(false);
  }, [job]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await clientApiFetch(`/api/sheets/${jobId}`);
        if (!res.ok) throw new Error(`status check failed (${res.status})`);
        const data: AnnotationJob = await res.json();
        if (cancelled) return;
        setJob(data);
        if (data.status === "queued" || data.status === "processing") {
          timer.current = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    poll();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId]);

  if (!jobId) return <p className="wrap" style={{ color: "var(--danger)" }}>No sheet specified.</p>;
  if (error) return <p className="wrap" style={{ color: "var(--danger)" }}>{error}</p>;
  if (!job) return <p className="wrap" style={{ color: "var(--ink-soft)" }}>Loading…</p>;

  if (job.status === "failed") {
    return (
      <div className="wrap" style={{ textAlign: "center" }}>
        <h1 className="serif" style={{ fontSize: 24, fontWeight: 600, color: "var(--danger)" }}>
          Annotation failed
        </h1>
        <p style={{ marginTop: 6, color: "var(--ink-soft)" }}>{job.sheet_name}</p>
        <p style={{ marginTop: 12, color: "var(--ink-soft)" }}>{job.error}</p>
        <Link href="/" style={{ marginTop: 24, display: "inline-block", color: "var(--accent)", textDecoration: "underline" }}>
          Try another file
        </Link>
      </div>
    );
  }

  if (job.status === "queued" || job.status === "processing") {
    return (
      <div className="wrap" style={{ maxWidth: 480, padding: "100px 32px", textAlign: "center" }}>
        <div className="note-bounce">
          <div className="line" />
          <div className="note">♪</div>
        </div>
        <h2 className="serif" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>
          Annotating your sheet…
        </h2>
        <p style={{ marginTop: 6, color: "var(--ink-soft)" }}>{job.sheet_name}</p>
        <div className="stage-card" style={{ marginTop: 30 }}>
          <div className="stage-spinner" />
          <div className="stage-text">{job.stage || "Queued…"}</div>
        </div>
      </div>
    );
  }

  // done
  return (
    <div className="wrap wide">
      <div className="result-head">
        <div>
          <h2 className="serif">{job.sheet_name}</h2>
          <div className="sub">{job.labeled_groups} beat-groups labeled</div>
        </div>
        <div className="result-actions">
          <Link href="/" className="btn-pill ghost">
            Annotate another
          </Link>
          <PlayLink jobId={jobId} />
          <DownloadButton jobId={jobId} sheetName={job.sheet_name} />
        </div>
      </div>
      <div className="preview-card">
        <PreviewFrame jobId={jobId} />
      </div>
    </div>
  );
}

// Playback is for signed-in accounts; a signed-out click opens the sign-in
// modal instead of navigating to /play, which would only gate them anyway.
function PlayLink({ jobId }: { jobId: string }) {
  const { user, loading, openSignIn } = useAuth();
  return (
    <Link
      href={`/play?job=${jobId}`}
      className="btn-pill ghost icon-only"
      title="Play with the keyboard"
      aria-label="Play with the keyboard"
      onClick={(e) => {
        if (!loading && !user) {
          e.preventDefault();
          openSignIn();
        }
      }}
    >
      <KeyboardIcon size={20} />
    </Link>
  );
}

// A plain <a href> can't be pointed at a fetch() call, and we want the
// browser's "save as" filename to be the real sheet name, not the job id -
// so fetch the bytes ourselves and hand the browser a blob URL to save.
function DownloadButton({ jobId, sheetName }: { jobId: string; sheetName?: string }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setDownloading(true);
    setError(null);
    try {
      const res = await clientApiFetch(`/api/sheets/${jobId}/download`);
      // Without this check a failed request still "downloads" - the error
      // body gets saved as a .pdf that won't open, which is how a server-side
      // 500 previously reached the user as a silently broken file.
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(sheetName || jobId).replace(/\.pdf$/i, "")} (annotated).pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  if (error) {
    return (
      <button onClick={handleDownload} className="btn-pill" title={error} style={{ background: "var(--danger)" }}>
        Retry download
      </button>
    );
  }

  return (
    <button onClick={handleDownload} disabled={downloading} className="btn-pill">
      {downloading ? "Downloading…" : "Download"}
    </button>
  );
}

const PREVIEW_H_KEY = "bms_preview_h";

function PreviewFrame({ jobId }: { jobId: string }) {
  const resizeRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const dragState = useRef({ startY: 0, startH: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    clientApiFetch(`/api/sheets/${jobId}/download?inline=1`)
      .then((res) => {
        // A failed request otherwise gets turned into a blob and handed to
        // the PDF viewer, which renders it as an empty frame - indis-
        // tinguishable from a genuinely blank PDF, and how a server-side
        // 500 previously surfaced as "the preview is blank".
        if (!res.ok) throw new Error(`preview failed (${res.status})`);
        return res.blob();
      })
      .then((blob) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        // Assigned imperatively, once the iframe already exists in the DOM
        // at its final layout size - not via a src={} prop that mounts the
        // iframe and its content in the same render.
        const frame = frameRef.current;
        if (!frame) return;
        frame.src = objectUrl;
        // Chromium's built-in PDF viewer frequently finishes its first paint
        // pass blank (toolbar and page count are correct, but no page
        // content is drawn) when loaded this way, and doesn't recover on its
        // own - reliably confirmed by testing, not a guess. Resize events
        // and layout nudges don't fix it; forcing the iframe through a real
        // navigation cycle (blank, then back to the real content) does, by
        // making the plugin fully reinitialize instead of continuing a
        // first attempt it got stuck on.
        setTimeout(() => {
          if (!frame.isConnected || frame.src !== objectUrl) return;
          frame.src = "about:blank";
          setTimeout(() => {
            if (frame.isConnected) frame.src = objectUrl!;
          }, 50);
        }, 400);
      })
      .catch((err) => {
        if (!revoked) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [jobId]);

  useEffect(() => {
    const saved = parseInt(localStorage.getItem(PREVIEW_H_KEY) || "", 10);
    if (saved && resizeRef.current) resizeRef.current.style.height = `${saved}px`;
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    const el = resizeRef.current;
    if (!el) return;
    dragState.current = { startY: e.clientY, startH: el.getBoundingClientRect().height };
    el.classList.add("dragging");
    if (frameRef.current) frameRef.current.style.pointerEvents = "none"; // otherwise the iframe swallows the drag
    window.addEventListener("pointermove", onDrag);
    window.addEventListener("pointerup", onDragEnd);
  }
  function onDrag(e: PointerEvent) {
    const el = resizeRef.current;
    if (!el) return;
    const h = Math.max(300, Math.min(window.innerHeight * 2.2, dragState.current.startH + (e.clientY - dragState.current.startY)));
    el.style.height = `${h}px`;
  }
  function onDragEnd() {
    const el = resizeRef.current;
    if (el) {
      el.classList.remove("dragging");
      localStorage.setItem(PREVIEW_H_KEY, String(Math.round(el.getBoundingClientRect().height)));
    }
    if (frameRef.current) frameRef.current.style.pointerEvents = "";
    window.removeEventListener("pointermove", onDrag);
    window.removeEventListener("pointerup", onDragEnd);
  }

  if (error) {
    return (
      <div className="preview-resize" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--danger)", textAlign: "center", padding: 24 }}>
          Couldn&apos;t load the preview ({error}). The Download button still gives you the file.
        </p>
      </div>
    );
  }

  return (
    <div className="preview-resize" ref={resizeRef}>
      <iframe ref={frameRef} title="Annotated sheet preview" />
      <div className="resize-handle" title="Drag to resize" onPointerDown={onPointerDown}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <line x1="3" y1="14" x2="14" y2="3" />
          <line x1="8" y1="14" x2="14" y2="8" />
          <line x1="13" y1="14" x2="14" y2="13" />
        </svg>
      </div>
    </div>
  );
}
