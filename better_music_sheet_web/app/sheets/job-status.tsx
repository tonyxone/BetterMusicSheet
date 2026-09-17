"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { clientApiFetch } from "@/lib/client-api";
import { fetchSheetAssets, fetchSheetFile } from "@/lib/sheet-files";
import { SheetToggle, type SheetVariant } from "../sheet-toggle";
import { KeyboardIcon } from "../keyboard-icon";
import { BackButton } from "../back-button";
import type { AnnotationJob } from "@/lib/api";

const POLL_INTERVAL_MS = 2500;

export function JobStatus() {
  const jobId = useSearchParams().get("job");
  const [job, setJob] = useState<AnnotationJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which copy the preview shows. Owned here rather than by the preview
  // itself: the control sits with the page's other actions, a level above it.
  const [variant, setVariant] = useState<SheetVariant>("annotated");
  const [originalMissing, setOriginalMissing] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    void fetchSheetAssets(jobId)
      .then((assets) => {
        if (cancelled || !assets) return;
        // An older backend omits the field entirely; that is not proof of
        // absence, so only an explicit null disables the toggle.
        if ("original" in assets && !assets.original) {
          setOriginalMissing("The uploaded file isn't stored for this sheet");
        }
      })
      .catch(() => { /* Leave it enabled - the frame reports its own failures. */ });
    return () => { cancelled = true; };
  }, [jobId]);

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
        if (data.status === "uploading" || data.status === "queued" || data.status === "processing") {
          timer.current = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        console.error("Checking the sheet's status failed:", err);
        if (!cancelled) setError("Couldn't check this sheet's status. Reloading the page usually fixes it.");
      }
    }
    poll();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId]);

  if (!jobId) return <div className="wrap"><div className="page-title-row"><BackButton /><p style={{ color: "var(--danger)", margin: 0 }}>No sheet specified.</p></div></div>;
  if (error) return <div className="wrap"><div className="page-title-row"><BackButton /><p style={{ color: "var(--danger)", margin: 0 }}>{error}</p></div></div>;
  if (!job) return <div className="wrap"><div className="page-title-row"><BackButton /><p style={{ color: "var(--ink-soft)", margin: 0 }}>Loading…</p></div></div>;

  if (job.status === "failed") {
    return (
      <div className="wrap" style={{ textAlign: "center" }}>
        <div className="page-title-row" style={{ justifyContent: "center" }}>
          <BackButton />
          <h1 className="serif" style={{ fontSize: 24, fontWeight: 600, color: "var(--danger)" }}>
            Annotation failed
          </h1>
        </div>
        <p style={{ marginTop: 6, color: "var(--ink-soft)" }}>{job.sheet_name}</p>
        <p style={{ marginTop: 12, color: "var(--ink-soft)" }}>{job.error}</p>
        <Link href="/upload" style={{ marginTop: 24, display: "inline-block", color: "var(--accent)", textDecoration: "underline" }}>
          Try another file
        </Link>
      </div>
    );
  }

  if (job.status === "uploading" || job.status === "queued" || job.status === "processing") {
    return (
      <div className="wrap" style={{ maxWidth: 480, padding: "100px 32px", textAlign: "center" }}>
        <div className="note-bounce">
          <div className="line" />
          <div className="note">♪</div>
        </div>
        <div className="page-title-row" style={{ justifyContent: "center" }}>
          <BackButton />
          <h2 className="serif" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>
            Annotating your sheet…
          </h2>
        </div>
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
        <div className="page-title-row">
          <BackButton />
          <h2 className="serif">{job.sheet_name}</h2>
        </div>
        <div className="result-actions">
          <SheetToggle value={variant} onChange={setVariant} unavailable={originalMissing} />
          <Link
            href={`/play?job=${jobId}`}
            className="icon-link"
            title="Practice with the keyboard"
            aria-label="Practice with the keyboard"
          >
            <KeyboardIcon size={44} />
          </Link>
          <DownloadButton jobId={jobId} sheetName={job.sheet_name} />
        </div>
      </div>
      <div className="preview-card">
        {/* Remounted on a switch: the frame's whole job is to fetch one file
            and hand the browser a blob URL, and starting that over is simpler
            and less error-prone than swapping documents mid-flight. */}
        <PreviewFrame key={variant} jobId={jobId} variant={variant} />
      </div>
    </div>
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
      const res = await fetchSheetFile(jobId, "pdf");
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
      console.error("Downloading the annotated sheet failed:", err);
      setError("failed");
    } finally {
      setDownloading(false);
    }
  }

  if (error) {
    return (
      <button onClick={handleDownload} className="btn-pill" title="That download didn't finish. Try again." style={{ background: "var(--danger)" }}>
        Retry download
      </button>
    );
  }

  return (
    <button
      onClick={handleDownload}
      disabled={downloading}
      className="btn-pill"
      title={downloading ? "Preparing the annotated PDF" : "Download the annotated PDF"}
    >
      {downloading ? "Downloading…" : "Download"}
    </button>
  );
}

const PREVIEW_H_KEY = "bms_preview_h";

function PreviewFrame({ jobId, variant }: { jobId: string; variant: SheetVariant }) {
  const resizeRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const dragState = useRef({ startY: 0, startH: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    fetchSheetFile(jobId, variant === "original" ? "original" : "pdf")
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
        console.error("Rendering the sheet preview failed:", err);
        if (!revoked) setError("unavailable");
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [jobId, variant]);

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
          {variant === "original"
            ? "Couldn't show the uploaded file here."
            : "Couldn't show the preview here. The Download button still gives you the file."}
        </p>
      </div>
    );
  }

  return (
    <div className="preview-resize" ref={resizeRef}>
      <iframe ref={frameRef} title={variant === "original" ? "Original sheet preview" : "Annotated sheet preview"} />
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
