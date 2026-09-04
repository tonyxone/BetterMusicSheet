import { Suspense } from "react";
import { AuthCallback } from "./auth-callback";

// Where Cognito's hosted UI sends the browser back to after sign-in. Static
// like every other page here (see next.config.ts) - the ?code= exchange all
// happens client-side in AuthCallback. useSearchParams() requires a Suspense
// boundary.
export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<p className="wrap" style={{ color: "var(--ink-soft)" }}>Signing you in…</p>}>
      <AuthCallback />
    </Suspense>
  );
}
