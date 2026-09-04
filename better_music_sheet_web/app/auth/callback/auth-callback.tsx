"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { completeSignIn } from "@/lib/auth";
import { useAuth } from "../../auth-context";

export function AuthCallback() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useAuth();
  const code = params.get("code");
  const state = params.get("state");
  // Cognito reports a refused/failed sign-in in the query string rather than
  // by failing the redirect. Both this and the missing-code case are plain
  // functions of the URL, so they're derived during render rather than
  // pushed into state from the effect.
  const requestError =
    params.get("error_description") || params.get("error") || (!code || !state ? "missing authorization code" : null);
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  const error = requestError || exchangeError;

  // The PKCE verifier is single-use: React mounts effects twice in dev, and
  // a second run would consume an already-spent code and fail.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || requestError || !code || !state) return;
    started.current = true;

    completeSignIn(code, state)
      .then(async ({ returnTo }) => {
        await refresh();
        router.replace(returnTo);
      })
      .catch((err) => setExchangeError(err instanceof Error ? err.message : String(err)));
  }, [code, state, requestError, refresh, router]);

  if (error) {
    return (
      <div className="wrap" style={{ textAlign: "center" }}>
        <h1 className="serif" style={{ fontSize: 24, fontWeight: 600, color: "var(--danger)" }}>
          Sign-in failed
        </h1>
        <p style={{ marginTop: 12, color: "var(--ink-soft)" }}>{error}</p>
        <Link href="/" style={{ marginTop: 24, display: "inline-block", color: "var(--accent)", textDecoration: "underline" }}>
          Back to uploading
        </Link>
      </div>
    );
  }

  return <p className="wrap" style={{ color: "var(--ink-soft)" }}>Signing you in…</p>;
}
