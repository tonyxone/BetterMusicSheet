"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { clientApiFetch } from "@/lib/client-api";
import { KeyboardIcon } from "../keyboard-icon";
import type { AnnotationJob } from "@/lib/api";

const STATUS_LABEL: Record<AnnotationJob["status"], string> = {
  uploading: "Uploading",
  done: "Annotated",
  failed: "Failed",
  processing: "Processing",
  queued: "Queued",
};

export default function HistoryPage() {
  const [jobs, setJobs] = useState<AnnotationJob[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AnnotationJob | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    clientApiFetch("/api/sheets")
      .then((res) => (res.ok ? res.json() : []))
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

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
        throw new Error(body?.detail || `Could not delete this sheet (${res.status}).`);
      }
      setJobs((current) => current?.filter((job) => job.job_id !== deleteTarget.job_id) ?? current);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete this sheet.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="wrap medium">
      <h1 className="serif">History</h1>
      <div className="sub" style={{ marginBottom: 30 }}>Sheets you&apos;ve annotated.</div>

      {jobs === null ? (
        <p style={{ color: "var(--ink-soft)" }}>Loading…</p>
      ) : jobs.length === 0 ? (
        <div className="history-empty">No sheets annotated yet.</div>
      ) : (
        <div>
          {jobs.map((job) => (
            // A plain div, not the link itself: a Play link sits alongside the
            // main one below, and an <a> can't nest inside another <a>.
            <div key={job.job_id} className="history-row">
              <Link href={`/sheets?job=${job.job_id}`} className="history-row-link">
                <div className="history-icon">📄</div>
                <div className="history-info">
                  <div className="history-title">{job.sheet_name}</div>
                  <div className="history-meta">{new Date(job.created_at * 1000).toLocaleString()}</div>
                </div>
              </Link>
              {/* Only a finished sheet has a timeline to play back. */}
              {job.status === "done" && (
                <Link
                  href={`/play?job=${job.job_id}`}
                  className="icon-link"
                  title="Play with the keyboard"
                  aria-label="Play with the keyboard"
                >
                  <KeyboardIcon />
                </Link>
              )}
              <span className={`history-badge ${job.status}`}>{STATUS_LABEL[job.status]}</span>
              <button
                type="button"
                className="history-delete"
                onClick={() => openDelete(job)}
                disabled={job.status === "uploading" || job.status === "queued" || job.status === "processing"}
                title={
                  job.status === "uploading" || job.status === "queued" || job.status === "processing"
                    ? "Wait for processing to finish before deleting"
                    : `Delete ${job.sheet_name || "sheet"}`
                }
                aria-label={`Delete ${job.sheet_name || "sheet"}`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

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
              title="Close"
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
            <h2 id="delete-title" className="modal-title">Delete this sheet?</h2>
            <p className="modal-sub">
              <strong>{deleteTarget.sheet_name || "Untitled sheet"}</strong> and its uploaded PDF,
              annotated PDF, and playback data will be permanently deleted.
            </p>
            {deleteError && <div className="modal-error">{deleteError}</div>}
            <div className="modal-actions">
              <button type="button" className="btn-pill ghost" title="Keep this sheet" onClick={closeDelete} disabled={deleting}>
                Cancel
              </button>
              <button type="button" className="btn-pill danger" title="Permanently delete this sheet and its files" onClick={confirmDelete} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
