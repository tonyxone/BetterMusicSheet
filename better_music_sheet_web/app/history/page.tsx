"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { clientApiFetch } from "@/lib/client-api";
import { setAdsPaused } from "@/lib/ads";
import type { AnnotationJob } from "@/lib/api";

const STATUS_LABEL: Record<AnnotationJob["status"], string> = {
  done: "Annotated",
  failed: "Failed",
  processing: "Processing",
  queued: "Queued",
};

export default function HistoryPage() {
  const [jobs, setJobs] = useState<AnnotationJob[] | null>(null);

  useEffect(() => {
    clientApiFetch("/api/sheets")
      .then((res) => (res.ok ? res.json() : []))
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  // No AdSense ads while this screen is just a loading state or the
  // "nothing here yet" empty state - only once there's a real list.
  useEffect(() => {
    setAdsPaused(!jobs || jobs.length === 0);
    return () => setAdsPaused(false);
  }, [jobs]);

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
            <Link key={job.job_id} href={`/sheets?job=${job.job_id}`} className="history-row">
              <div className="history-icon">📄</div>
              <div className="history-info">
                <div className="history-title">{job.sheet_name}</div>
                <div className="history-meta">{new Date(job.created_at * 1000).toLocaleString()}</div>
              </div>
              <span className={`history-badge ${job.status}`}>{STATUS_LABEL[job.status]}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
