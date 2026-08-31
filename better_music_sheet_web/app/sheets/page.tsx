import { Suspense } from "react";
import { JobStatus } from "./job-status";

// jobId comes from a ?job= query param, not a dynamic route segment, so this
// page has no params to enumerate - it works as a single static HTML file
// under `output: "export"` (see next.config.ts). useSearchParams() requires
// a Suspense boundary.
export default function SheetPage() {
  return (
    <Suspense fallback={<p className="wrap" style={{ color: "var(--ink-soft)" }}>Loading…</p>}>
      <JobStatus />
    </Suspense>
  );
}
