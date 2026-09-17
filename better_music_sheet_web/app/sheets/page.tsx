import { Suspense } from "react";
import { JobStatus } from "./job-status";
import { BackButton } from "../back-button";

// jobId comes from a ?job= query param, not a dynamic route segment, so this
// page has no params to enumerate - it works as a single static HTML file
// under `output: "export"` (see next.config.ts). useSearchParams() requires
// a Suspense boundary.
export default function SheetPage() {
  return (
    <Suspense fallback={<div className="wrap"><div className="page-title-row"><BackButton /><p style={{ color: "var(--ink-soft)", margin: 0 }}>Loading…</p></div></div>}>
      <JobStatus />
    </Suspense>
  );
}
