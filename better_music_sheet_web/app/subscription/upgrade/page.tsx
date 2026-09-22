import { Suspense } from "react";
import { Paywall } from "../paywall";

// The ?plan= query param is read client-side in Paywall, which is why
// useSearchParams needs a Suspense boundary here (see next.config.ts).
export default function UpgradePage() {
  return (
    <Suspense fallback={<div className="wrap medium subscription-page"><p style={{ color: "var(--ink-soft)" }}>Loading…</p></div>}>
      <Paywall />
    </Suspense>
  );
}
