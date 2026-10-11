"use client";

import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { clientApiFetch } from "@/lib/client-api";
import { fetchSheetAssets, fetchSheetFile } from "@/lib/sheet-files";
import { SheetToggle, type SheetVariant } from "../../sheet-toggle";
import { KeyboardIcon } from "../../keyboard-icon";
import { BackButton } from "../../back-button";
import { isActive, type AnnotationJob } from "@/lib/api";
import { usePreference } from "@/lib/preferences";
import type { CustomizedExport } from "../../sheet-viewer/sheet-editor";
import { PageLoading } from "../../page-loading";
import { useI18n } from "@/lib/i18n/client";
import { fmt, rich } from "@/lib/i18n/format";
import { translateKnown } from "@/lib/i18n/known-text";
import { namesProgress, namesStage } from "@/lib/names-progress";

// pdf.js and the editor stay out of every other route's bundle, and out of
// the static export's prerender pass, which has no canvas or worker.
const SheetEditor = dynamic(() => import("../../sheet-viewer/sheet-editor").then((m) => m.SheetEditor), {
  ssr: false,
  loading: () => <SheetLoading />,
});

function SheetLoading() {
  const { m } = useI18n();
  return <p className="play-hint" style={{ padding: 24 }}>{m.common.loadingSheet}</p>;
}

const POLL_INTERVAL_MS = 2500;

export function JobStatus() {
  const jobId = useSearchParams().get("job");
  const { m, path } = useI18n();
  const t = m.sheet;
  const [job, setJob] = useState<AnnotationJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set while a cancel request is in flight: the job is about to 404, which
  // must not surface as a status-check error.
  const cancellingRef = useRef(false);
  // Which copy the preview shows. Owned here rather than by the preview
  // itself: the Download menu up in the page's actions follows it too.
  // The reader's own choice, the same on every sheet (lib/preferences.ts).
  const [variant, setVariant] = usePreference("sheet_view", "annotated");
  const [originalMissing, setOriginalMissing] = useState<string | null>(null);
  // Set by the editor once the sheet has loaded: builds the Customized PDF.
  const customizedRef = useRef<CustomizedExport | null>(null);
  // Bumped to start checking again once a retry puts a failed sheet back in
  // the queue - the check stops by itself when a sheet finishes or fails.
  const [pollRound, setPollRound] = useState(0);

  const done = job?.status === "done";
  // The upload can be read long before the names are ready, and still can
  // after adding them failed.
  const viewable = done || !!job?.original_ready;

  useEffect(() => {
    if (!jobId || !viewable) return;
    let cancelled = false;
    void fetchSheetAssets(jobId)
      .then((assets) => {
        if (cancelled || !assets) return;
        // An older backend omits the field entirely; that is not proof of
        // absence, so only an explicit null disables the toggle.
        if ("original" in assets && !assets.original) {
          setOriginalMissing(t.originalNotStored);
        }
      })
      .catch(() => { /* Leave it enabled - the frame reports its own failures. */ });
    return () => { cancelled = true; };
  }, [jobId, viewable, t]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await clientApiFetch(`/api/sheets/${jobId}`);
        if (cancelled) return;
        if (cancellingRef.current) {
          timer.current = setTimeout(poll, POLL_INTERVAL_MS);
          return;
        }
        if (!res.ok) throw new Error(`status check failed (${res.status})`);
        const data: AnnotationJob = await res.json();
        if (cancelled) return;
        setJob(data);
        if (isActive(data)) timer.current = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        console.error("Checking the sheet's status failed:", err);
        if (!cancelled) setError(t.statusFailed);
      }
    }
    poll();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId, pollRound, t]);

  if (!jobId) return <PageLoading text={t.noSheet} error />;
  if (error) return <PageLoading text={error} error />;
  if (!job) return <PageLoading />;

  // Failed before the upload even finished: there is nothing to show.
  if (job.status === "failed" && !viewable) {
    return (
      <div className="wrap" style={{ textAlign: "center" }}>
        <div className="page-title-row" style={{ justifyContent: "center" }}>
          <BackButton />
          <h1 className="serif" style={{ fontSize: 24, fontWeight: 600, color: "var(--danger)" }}>
            {t.annotationFailed}
          </h1>
        </div>
        <p style={{ marginTop: 6, color: "var(--ink-soft)" }}>{job.sheet_name}</p>
        <p style={{ marginTop: 12, color: "var(--ink-soft)" }}>{translateKnown(job.error, m)}</p>
        <Link href={path("/upload")} style={{ marginTop: 24, display: "inline-block", color: "var(--accent)", textDecoration: "underline" }}>
          {t.tryAnother}
        </Link>
      </div>
    );
  }

  // Still uploading - or an older backend, which can't show a sheet before
  // its names are ready.
  if (!viewable) {
    return (
      <div className="wrap" style={{ maxWidth: 480, padding: "100px 32px", textAlign: "center" }}>
        <div className="note-bounce">
          <div className="line" />
          <div className="note">♪</div>
        </div>
        <div className="page-title-row" style={{ justifyContent: "center" }}>
          <BackButton />
          <h2 className="serif" style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>
            {t.annotating}
          </h2>
        </div>
        <p style={{ marginTop: 6, color: "var(--ink-soft)" }}>{job.sheet_name}</p>
        <div className="stage-card" style={{ marginTop: 30 }}>
          <div className="stage-spinner" />
          <div className="stage-text">{translateKnown(job.stage, m) || t.queued}</div>
        </div>
        <CancelAnnotation jobId={jobId} sheetName={job.sheet_name} cancellingRef={cancellingRef} />
      </div>
    );
  }

  // Readable: done, or the names still coming (or failed) over the upload.
  // Until the names exist there is only the upload to show.
  // One without its upload stored shows the names, without changing the
  // reader's choice for the next sheet.
  const shown: SheetVariant = !done ? "original" : originalMissing ? "annotated" : variant;
  const namesUnavailable = done ? null
    : job.status === "failed" ? t.namesFailedShort : t.namesPending;
  return (
    <div className="wrap wide">
      <div className="result-head">
        <div className="page-title-row">
          <BackButton />
          <h2 className="serif">{job.sheet_name}</h2>
        </div>
        <div className="result-actions">
          {/* Open to every plan: without Premium, Play plays the first lines
              and then offers Premium (play-view.tsx's FREE_LINES). */}
          <Link
            href={path(`/play?job=${jobId}`)}
            className="icon-link"
            title={m.common.practiceWithKeyboard}
            aria-label={m.common.practiceWithKeyboard}
          >
            <KeyboardIcon size={44} />
          </Link>
          <DownloadMenu jobId={jobId} sheetName={job.sheet_name} originalMissing={!!originalMissing}
            customizedRef={customizedRef} variant={shown} annotatedReady={done} />
        </div>
      </div>
      {!done && (
        <NamesBanner job={job} jobId={jobId} cancellingRef={cancellingRef}
          onRetried={(next) => { setJob(next); setPollRound((round) => round + 1); }} />
      )}
      <div className="preview-card">
        {/* Keyed on readiness: when the names arrive the editor loads again
            and shows them, without a page reload. */}
        <PreviewPanel key={done ? "names" : "upload"} jobId={jobId} variant={shown} customizedRef={customizedRef}
          variantToggle={<SheetToggle value={shown} onChange={setVariant} unavailable={originalMissing}
            annotatedUnavailable={namesUnavailable} />} />
      </div>
    </div>
  );
}

/** Where the note names are while the sheet itself can already be read:
 * still being added, or failed - with a way to try again. */
function NamesBanner({ job, jobId, cancellingRef, onRetried }: {
  job: AnnotationJob;
  jobId: string;
  cancellingRef: MutableRefObject<boolean>;
  onRetried: (job: AnnotationJob) => void;
}) {
  const { m } = useI18n();
  const t = m.sheet;
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      const res = await clientApiFetch(`/api/sheets/${jobId}/retry`, { method: "POST" });
      const body = await res.json().catch(() => null) as (AnnotationJob & { detail?: string }) | null;
      if (!res.ok || !body) throw new Error(translateKnown(body?.detail, m) || fmt(t.retryFailedStatus, { status: res.status }));
      onRetried(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.retryFailed);
    } finally {
      setRetrying(false);
    }
  }

  if (job.status === "failed") {
    return (
      <div className="names-banner failed" role="status">
        <div className="names-banner-text">
          <strong>{t.namesFailed}</strong> {translateKnown(job.error, m)}
          <div className="names-banner-sub">{t.namesFailedSub}</div>
          {error && <div className="names-banner-error">{error}</div>}
        </div>
        {job.can_retry && (
          <button type="button" className="btn-pill" onClick={() => void retry()} disabled={retrying}>
            {retrying ? t.starting : t.tryAgain}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="names-banner" role="status">
      <div className="stage-spinner" />
      <div className="names-banner-text">
        <strong>{t.addingNames}</strong> {translateKnown(job.stage, m)}
        <div className="names-banner-sub">{t.addingNamesSub}</div>
      </div>
      <CancelAnnotation jobId={jobId} sheetName={job.sheet_name} cancellingRef={cancellingRef} inline />
      <NamesProgressBar stage={job.stage} />
    </div>
  );
}

/** How far adding the names has got, worked out from the stage the job
 * reports (lib/names-progress.ts). Ticks between polls so the bar keeps
 * creeping, and only moves back when the job itself starts over. */
function NamesProgressBar({ stage }: { stage: string | null }) {
  const { m } = useI18n();
  const { key, start, end } = namesStage(stage);
  const [shown, setShown] = useState(start);
  // The previous stage's start, to tell a retry starting over from progress.
  const previousStart = useRef(start);

  useEffect(() => {
    const reachedAt = Date.now();
    let restarted = start < previousStart.current;
    previousStart.current = start;
    function update() {
      const progress = namesProgress({ key, start, end }, (Date.now() - reachedAt) / 1000);
      setShown((before) => (restarted ? progress : Math.max(before, progress)));
      restarted = false;
    }
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [key, start, end]);

  return (
    <div className="names-progress" role="progressbar" aria-label={m.sheet.addingNames}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown * 100)}>
      <div className="names-progress-fill" style={{ width: `${shown * 100}%` }} />
    </div>
  );
}

// Cancelling deletes the job outright - the worker notices at its next
// heartbeat and stops - so nothing is left behind in the library.
function CancelAnnotation({ jobId, sheetName, cancellingRef, inline = false }: {
  jobId: string;
  sheetName?: string | null;
  cancellingRef: MutableRefObject<boolean>;
  /** In the names banner, beside its text, rather than under a spinner. */
  inline?: boolean;
}) {
  const router = useRouter();
  const { m, path } = useI18n();
  const t = m.sheet;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (busy) return;
    setOpen(false);
    setError(null);
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    cancellingRef.current = true;
    try {
      const res = await clientApiFetch(`/api/sheets/${jobId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { detail?: string } | null;
        throw new Error(translateKnown(body?.detail, m) || fmt(t.cancelFailedStatus, { status: res.status }));
      }
      router.replace(path("/upload"));
    } catch (err) {
      cancellingRef.current = false;
      setError(err instanceof Error ? err.message : t.cancelFailed);
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn-pill ghost" style={inline ? undefined : { marginTop: 24 }} onClick={() => setOpen(true)}>
        {m.common.cancel}
      </button>
      {open && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}>
          <div className="modal-card delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="cancel-title"
            style={{ textAlign: "left" }}>
            <button type="button" className="modal-close" onClick={close} disabled={busy} title={m.common.close} aria-label={m.common.close}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
            <h2 id="cancel-title" className="modal-title">{t.stopTitle}</h2>
            <p className="modal-sub">
              {rich(t.stopBody, {}, { name: <strong>{sheetName || m.common.thisSheet}</strong> })}
            </p>
            {error && <div className="modal-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn-pill ghost" onClick={close} disabled={busy}>
                {t.keepGoing}
              </button>
              <button type="button" className="btn-pill danger" onClick={() => void confirm()} disabled={busy}>
                {busy ? t.cancelling : t.stopAndRemove}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

type DownloadKind = "original" | "annotated" | "customized" | "musicxml";

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked on the next tick: some browsers start the save asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// A plain <a href> can't be pointed at a fetch() call, and we want the
// browser's "save as" filename to be the real sheet name, not the job id -
// so fetch the bytes ourselves and hand the browser a blob URL to save.
function DownloadMenu({ jobId, sheetName, originalMissing, customizedRef, variant, annotatedReady }: {
  jobId: string;
  sheetName?: string;
  originalMissing: boolean;
  customizedRef: MutableRefObject<CustomizedExport | null>;
  /** Customized follows the preview: with the note names or without. */
  variant: SheetVariant;
  /** Whether the note names exist yet. */
  annotatedReady: boolean;
}) {
  const { m } = useI18n();
  const t = m.sheet.download;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<DownloadKind | null>(null);
  const [error, setError] = useState<DownloadKind | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const stem = (sheetName || jobId).replace(/\.[^.]+$/, "");
  // The MusicXML is stored a few seconds after the names are done, so ask
  // again each time the menu opens rather than once with the page. Until an
  // answer arrives the option stays enabled; a click checks for itself.
  const [musicxml, setMusicxml] = useState<"ready" | "missing" | "unknown">("unknown");

  useEffect(() => {
    if (!open || !annotatedReady) return;
    let cancelled = false;
    void fetchSheetAssets(jobId)
      .then((assets) => {
        // An older backend omits the field: that is not proof of absence.
        if (!cancelled && assets && "musicxml" in assets) setMusicxml(assets.musicxml ? "ready" : "missing");
      })
      .catch(() => { /* Leave it as it was. */ });
    return () => { cancelled = true; };
  }, [open, annotatedReady, jobId]);

  useEffect(() => {
    if (!open) return;
    function close(e: PointerEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function escape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  async function download(kind: DownloadKind) {
    setOpen(false);
    setBusy(kind);
    setError(null);
    try {
      if (kind === "customized") {
        const build = customizedRef.current;
        if (!build) throw new Error("the sheet hasn't finished loading");
        saveBlob(await build(), fmt(t.customizedFile, { stem }));
        return;
      }
      const res = await fetchSheetFile(jobId, kind === "annotated" ? "pdf" : kind);
      // Without this check a failed request still "downloads" - the error
      // body gets saved as a .pdf that won't open, which is how a server-side
      // 500 previously reached the user as a silently broken file.
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const blob = await res.blob();
      saveBlob(blob, kind === "original" ? (sheetName || `${stem}.pdf`)
        : kind === "musicxml" ? fmt(t.musicxmlFile, { stem }) : fmt(t.annotatedFile, { stem }));
    } catch (err) {
      console.error(`Downloading the ${kind} sheet failed:`, err);
      setError(kind);
    } finally {
      setBusy(null);
    }
  }

  const options: { kind: DownloadKind; label: string; detail: string; disabled?: boolean }[] = [
    {
      kind: "customized", label: t.customized,
      detail: variant === "original" ? t.customizedOriginal : t.customizedAnnotated,
    },
    {
      kind: "annotated", label: t.annotated, disabled: !annotatedReady,
      detail: annotatedReady ? t.annotatedReady : t.annotatedPending,
    },
    {
      kind: "original", label: t.original, disabled: originalMissing,
      detail: originalMissing ? m.sheet.originalNotStored : t.originalDetail,
    },
    {
      kind: "musicxml", label: t.musicxml, disabled: !annotatedReady || musicxml === "missing",
      detail: !annotatedReady ? t.annotatedPending : musicxml === "missing" ? t.musicxmlMissing : t.musicxmlDetail,
    },
  ];

  return (
    <div className="download-menu" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy !== null}
        className="btn-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        title={error ? t.failed : t.title}
        style={error ? { background: "var(--danger)" } : undefined}
      >
        {busy ? t.preparing : error ? t.retry : t.button}
      </button>
      {open && (
        <div className="download-menu-list" role="menu">
          {options.map((o) => (
            <button key={o.kind} type="button" role="menuitem" disabled={o.disabled} onClick={() => void download(o.kind)}>
              {o.label}
              <small>{o.detail}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const PREVIEW_H_KEY = "bms_preview_h";

function PreviewPanel({ jobId, variant, customizedRef, variantToggle }: {
  jobId: string;
  variant: SheetVariant;
  customizedRef: MutableRefObject<CustomizedExport | null>;
  variantToggle: ReactNode;
}) {
  const resizeRef = useRef<HTMLDivElement>(null);
  const { m } = useI18n();
  const dragState = useRef({ startY: 0, startH: 0 });
  // The sheet pinned over the whole window, page scroll locked behind it.
  const [fullWindow, setFullWindow] = useState(false);

  useEffect(() => {
    if (!fullWindow) return;
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    return () => { html.style.overflow = before; };
  }, [fullWindow]);

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
    window.removeEventListener("pointermove", onDrag);
    window.removeEventListener("pointerup", onDragEnd);
  }

  return (
    <div className={`preview-resize-wrap${fullWindow ? " full-window" : ""}`}>
      <div className="preview-resize scrolling" ref={resizeRef}>
        <SheetEditor jobId={jobId} variant={variant} exportRef={customizedRef} variantToggle={variantToggle}
          fullWindow={fullWindow} onFullWindow={setFullWindow} />
      </div>
      <div className="resize-handle" title={m.sheet.dragToResize} onPointerDown={onPointerDown}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <line x1="3" y1="14" x2="14" y2="3" />
          <line x1="8" y1="14" x2="14" y2="8" />
          <line x1="13" y1="14" x2="14" y2="13" />
        </svg>
      </div>
    </div>
  );
}
