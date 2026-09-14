import { Suspense } from "react";
import { CallbackView } from "./callback-view";

// Where a social sign-in lands after the provider's page redirects back
// through Cognito's hosted UI. Nobody navigates here on purpose - see
// lib/cognito.ts's socialSignInUrl, the only thing that ever sends someone
// to this route.
//
// Static like every other page (see next.config.ts) - the ?code= param is
// read client-side, which is why useSearchParams needs a Suspense boundary.
export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<p className="wrap" style={{ color: "var(--ink-soft)" }}>Signing you in…</p>}>
      <CallbackView />
    </Suspense>
  );
}
