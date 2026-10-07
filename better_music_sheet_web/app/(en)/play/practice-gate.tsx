"use client";

// Practice plays a sheet from its note names (the timeline), which are worked
// out after the upload - so a sheet can be opened here before they exist.
// Until then this shows the upload itself and says what is happening, and it
// swaps in the full player the moment the names are ready: no reload. If
// adding them failed, it says so and points to the sheet, where the reader
// can try again.

import { useEffect, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { clientApiFetch } from "@/lib/client-api";
import { fetchSheetFile } from "@/lib/sheet-files";
import { isActive, type AnnotationJob } from "@/lib/api";
import { BackButton } from "../../back-button";
import { PageLoading } from "../../page-loading";
import { useI18n } from "@/lib/i18n/client";
import { translateKnown } from "@/lib/i18n/known-text";

// pdf.js stays out of the static export's prerender pass, as elsewhere.
const PdfPages = dynamic(() => import("../../sheet-viewer/pdf-pages").then((m) => m.PdfPages), { ssr: false });

const POLL_INTERVAL_MS = 3000;

export function PracticeGate({ jobId, children }: { jobId: string; children: ReactNode }) {
  const [job, setJob] = useState<AnnotationJob | null>(null);
  const [unknown, setUnknown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        const res = await clientApiFetch(`/api/sheets/${jobId}`);
        if (!res.ok) throw new Error(`status check failed (${res.status})`);
        const data = await res.json() as AnnotationJob;
        if (cancelled) return;
        setJob(data);
        if (isActive(data)) timer = setTimeout(check, POLL_INTERVAL_MS);
      } catch (err) {
        console.error("Checking the sheet before practice failed:", err);
        if (!cancelled) setUnknown(true);
      }
    }
    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  // Couldn't tell: the player reports its own problems, as it always has.
  if (unknown || job?.status === "done") return <>{children}</>;
  if (!job) {
    return <PageLoading />;
  }
  return <WaitingForNames job={job} jobId={jobId} />;
}

function WaitingForNames({ job, jobId }: { job: AnnotationJob; jobId: string }) {
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const readable = !!job.original_ready;

  useEffect(() => {
    if (!readable) return;
    let cancelled = false;
    void fetchSheetFile(jobId, "original")
      .then(async (res) => (res.ok ? res.arrayBuffer() : null))
      .then((buffer) => {
        // Only a PDF can be drawn here; a photo upload simply isn't shown.
        const isPdf = buffer && new TextDecoder().decode(new Uint8Array(buffer.slice(0, 5))) === "%PDF-";
        if (!cancelled && isPdf) setPdf(buffer);
      })
      .catch((err) => console.error("Loading the sheet for practice failed:", err));
    return () => { cancelled = true; };
  }, [jobId, readable]);

  const failed = job.status === "failed";
  const { m, path } = useI18n();
  const t = m.play;
  return (
    <div className="wrap wide">
      <div className="result-head">
        <div className="page-title-row">
          <BackButton />
          <h2 className="serif">{job.sheet_name}</h2>
        </div>
      </div>
      <div className={`names-banner${failed ? " failed" : ""}`} role="status">
        {!failed && <div className="stage-spinner" />}
        <div className="names-banner-text">
          {failed ? (
            <>
              <strong>{t.gateFailed}</strong> {translateKnown(job.error, m)}
              <div className="names-banner-sub">
                {job.can_retry ? t.gateRetry : t.gateReadBelow}
              </div>
            </>
          ) : (
            <>
              <strong>{t.gateWaiting}</strong> {translateKnown(job.stage, m)}
              <div className="names-banner-sub">{t.gateWaitingSub}</div>
            </>
          )}
        </div>
        {failed && (
          <Link href={path(`/sheets?job=${jobId}`)} className="btn-pill">{t.openSheet}</Link>
        )}
      </div>
      {pdf && (
        <div className="preview-card practice-wait-sheet">
          <PdfPages pdfData={pdf} />
        </div>
      )}
    </div>
  );
}
