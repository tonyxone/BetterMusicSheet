import { Suspense } from "react";
import { PlayView } from "./play-view";
import { BackButton } from "../back-button";

// Playback lives on its own route rather than inside the results page: it
// pulls in three.js and pdf.js, and nothing here should load for someone who
// only wants to download their annotated PDF.
//
// Static like every other page (see next.config.ts) - the ?job= param is read
// client-side, which is why useSearchParams needs a Suspense boundary.
export default function PlayPage() {
  return (
    <Suspense fallback={<div className="wrap"><div className="page-title-row"><BackButton /><p style={{ color: "var(--ink-soft)", margin: 0 }}>Loading…</p></div></div>}>
      <PlayView />
    </Suspense>
  );
}
