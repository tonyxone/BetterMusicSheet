import { Suspense } from "react";
import { Paywall } from "../paywall";
import { getI18n } from "@/lib/i18n/server";

// The ?plan= query param is read client-side in Paywall, which is why
// useSearchParams needs a Suspense boundary here (see next.config.ts).
export default async function UpgradePage() {
  const { m } = await getI18n();
  return (
    <Suspense fallback={<div className="wrap medium subscription-page"><p style={{ color: "var(--ink-soft)" }}>{m.common.loading}</p></div>}>
      <Paywall />
    </Suspense>
  );
}
