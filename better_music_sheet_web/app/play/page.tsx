import { Suspense } from "react";
import { PlayView } from "./play-view";

// Playback lives on its own route rather than inside the results page: it
// pulls in three.js and pdf.js, and nothing here should load for someone who
// only wants to download their annotated PDF.
//
// Static like every other page (see next.config.ts) - the ?job= param is read
// client-side, which is why useSearchParams needs a Suspense boundary.
export default function PlayPage() {
  return (
    <Suspense fallback={<p className="wrap" style={{ color: "var(--ink-soft)" }}>Loading…</p>}>
      <PlayView />
    </Suspense>
  );
}
