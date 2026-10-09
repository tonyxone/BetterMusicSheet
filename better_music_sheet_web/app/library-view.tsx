"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { clientApiFetch } from "@/lib/client-api";
import { KeyboardIcon } from "./keyboard-icon";
import { BackButton } from "./back-button";
import { DemoSampleCard } from "./demo-sample-card";
import { isActive, type AnnotationJob } from "@/lib/api";
import { paginateLibrary } from "@/lib/library-pagination";
import { noteCountLabel } from "@/lib/note-count";
import { useI18n } from "@/lib/i18n/client";
import { fmt, rich } from "@/lib/i18n/format";
import { translateKnown } from "@/lib/i18n/known-text";

// A sheet can be opened as soon as its upload finishes; its badge
// (m.library.status) describes its note names, which may still be coming - or
// have failed, over a sheet that is otherwise perfectly readable.

// Rendered at two URLs: as the landing page at "/" for a signed-in visitor
// (see app/home.tsx), and at /history for everyone, which is how a guest -
// who has a library of their own under a guest id, but gets the upload form
// at "/" - reaches theirs.
//
// showBack: on /history there is a page above to return to; at the root there
// is not, so the caller decides rather than this component guessing.
export function LibraryView({ showBack = false }: { showBack?: boolean }) {
  const { m, tag, path } = useI18n();
  const t = m.library;
  const [jobs, setJobs] = useState<AnnotationJob[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AnnotationJob | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    clientApiFetch("/api/sheets")
      .then((res) => (res.ok ? res.json() : []))
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  const { pageCount, currentPage, start, end, showDemoLast, emptyLibrary } = paginateLibrary(jobs?.length ?? 0, page);
  // Not memoized by hand: the React Compiler does it.
  const pageJobs = jobs?.slice(start, end) ?? [];

  function openDelete(job: AnnotationJob) {
    setDeleteError(null);
    setDeleteTarget(job);
  }

  function closeDelete() {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await clientApiFetch(`/api/sheets/${deleteTarget.job_id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { detail?: string } | null;
        throw new Error(translateKnown(body?.detail, m) || fmt(t.deleteFailedStatus, { status: res.status }));
      }
      setJobs((current) => current?.filter((job) => job.job_id !== deleteTarget.job_id) ?? current);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t.deleteFailed);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="wrap medium history-page">
      <div className="page-title-row">
        {showBack && <BackButton />}
        <h1 className="serif">{t.title}</h1>
      </div>
      <div className="sub" style={{ marginBottom: 30 }}>{t.sub}</div>

      {jobs === null ? (
        <p style={{ color: "var(--ink-soft)" }}>{m.common.loading}</p>
      ) : (
        <>
          {jobs.length > 0 && (
          <div>
            {pageJobs.map((job) => (
              // A plain div, not the link itself: the Play link and delete button
              // sit alongside it inside the same card, and an <a>/<button> can't
              // nest inside another <a>.
              <div key={job.job_id} className="history-row">
                <Link href={path(`/sheets?job=${job.job_id}`)} className="history-row-link">
                  <div className="history-icon">📄</div>
                  <div className="history-info">
                    <div className="history-title">{job.sheet_name}</div>
                    {noteCountLabel(job, t, tag) && <div className="history-meta">{noteCountLabel(job, t, tag)}</div>}
                  </div>
                  <span className={`history-badge ${job.status}`}>{t.status[job.status]}</span>
                </Link>
                <div className="history-actions">
                  {/* Practice plays a finished sheet; before that it shows the
                      upload and picks the names up once they're ready. Open
                      to every plan: without Premium it plays the first lines,
                      then offers Premium (play-view.tsx's FREE_LINES). */}
                  {(job.status === "done" || job.original_ready) && (
                    <Link
                      href={path(`/play?job=${job.job_id}`)}
                      className="history-action history-play"
                      title={m.common.practiceWithKeyboard}
                      aria-label={m.common.practiceWithKeyboard}
                    >
                      <KeyboardIcon size={40} />
                    </Link>
                  )}
                  <button
                    type="button"
                    className="history-action history-delete"
                    onClick={() => openDelete(job)}
                    disabled={isActive(job)}
                    title={
                      isActive(job)
                        ? t.waitToDelete
                        : fmt(t.deleteNamed, { name: job.sheet_name || m.common.sheet })
                    }
                    aria-label={fmt(t.deleteNamed, { name: job.sheet_name || m.common.sheet })}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
          )}

          {/* Built-in sample, not user content - always last, and only on
              the last page, so it never sits in the middle of real sheets. */}
          {showDemoLast && <DemoSampleCard removable emptyLibrary={emptyLibrary} />}

          {pageCount > 1 && (
            <nav className="pagination" aria-label={t.pagesNav}>
              <button
                type="button"
                className="pagination-btn"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                aria-label={t.previousPage}
              >
                ‹
              </button>
              <span className="pagination-status">{fmt(t.pageOf, { page: currentPage, count: pageCount })}</span>
              <button
                type="button"
                className="pagination-btn"
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={currentPage === pageCount}
                aria-label={t.nextPage}
              >
                ›
              </button>
            </nav>
          )}
        </>
      )}

      <Link href={path("/upload")} className="upload-fab" title={m.common.uploadASheet} aria-label={m.common.uploadASheet}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {m.common.upload}
      </Link>

      {deleteTarget && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDelete();
        }}>
          <div className="modal-card delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
            <button
              type="button"
              className="modal-close"
              onClick={closeDelete}
              disabled={deleting}
              title={m.common.close}
              aria-label={m.common.close}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
            <h2 id="delete-title" className="modal-title">{t.deleteTitle}</h2>
            <p className="modal-sub">
              {rich(t.deleteBody, {}, { name: <strong>{deleteTarget.sheet_name || m.common.untitledSheet}</strong> })}
            </p>
            {deleteError && <div className="modal-error">{deleteError}</div>}
            <div className="modal-actions">
              <button type="button" className="btn-pill ghost" title={t.keepSheet} onClick={closeDelete} disabled={deleting}>
                {m.common.cancel}
              </button>
              <button type="button" className="btn-pill danger" title={t.deleteForever} onClick={confirmDelete} disabled={deleting}>
                {deleting ? m.common.deleting : m.common.delete}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
