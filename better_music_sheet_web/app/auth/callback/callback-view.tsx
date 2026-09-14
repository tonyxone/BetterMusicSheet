"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signInWithSocialCode } from "@/lib/auth";
import { callbackRedirectUri } from "@/lib/cognito";

export function CallbackView() {
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  // StrictMode double-invokes effects in dev, and the code is single-use -
  // a second exchange attempt would just fail with a confusing error over
  // one that already succeeded.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    // Every setState below happens inside a promise callback rather than in
    // the effect body itself - even the two "no code" checks are thrown into
    // the chain rather than handled inline - so nothing sets state
    // synchronously within an effect (see the same reasoning, at more
    // length, on auth-context.tsx's refresh()).
    Promise.resolve()
      .then(() => {
        // The provider or Cognito itself can send back an error instead of a
        // code - most commonly someone closing the provider's login popup,
        // or denying the permission request.
        const providerError = params.get("error");
        if (providerError) {
          throw new Error(
            providerError === "access_denied"
              ? "Sign-in was cancelled."
              : `Sign-in failed (${params.get("error_description") || providerError}).`,
          );
        }
        const code = params.get("code");
        if (!code) {
          throw new Error("This page only works as part of signing in - there's nothing to do here directly.");
        }
        return signInWithSocialCode(code, callbackRedirectUri());
      })
      .then(() => {
        // A full navigation, not router.replace: the rest of the app (the
        // header's user menu, auth-context's cached state) was rendered
        // before this session existed, and a fresh load is the simplest way
        // to make everything notice it - the same reasoning signOut() uses.
        window.location.href = "/";
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [params]);

  return (
    <div className="wrap" style={{ textAlign: "center" }}>
      {error ? (
        <>
          <p style={{ color: "var(--danger)" }}>{error}</p>
          <Link href="/" style={{ marginTop: 20, display: "inline-block", color: "var(--accent)" }}>
            Back to BetterMusicSheet
          </Link>
        </>
      ) : (
        <p style={{ color: "var(--ink-soft)" }}>Signing you in…</p>
      )}
    </div>
  );
}
