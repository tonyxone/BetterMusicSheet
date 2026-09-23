"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { clientApiFetch } from "@/lib/client-api";
import { useSubscription } from "@/lib/subscription";

export function SubscriptionSuccess() {
  const sessionId = useSearchParams().get("session_id");
  const { subscription, loading, refresh } = useSubscription();
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Syncs entitlement from the just-completed Checkout Session right away,
  // rather than waiting on the webhook - which has nowhere reachable to
  // reach in local dev, and can otherwise lag the browser's own redirect
  // back here even in production (see server.py's /confirm route).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (sessionId) {
        try {
          const response = await clientApiFetch("/api/subscriptions/stripe/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => null) as { detail?: string } | null;
            if (!cancelled) setConfirmError(body?.detail ?? null);
          }
        } catch {
          // The webhook may still land shortly - refresh() below picks up
          // whatever the account's entitlement actually is either way.
        }
      }
      refresh();
    })();
    return () => { cancelled = true; };
  }, [sessionId, refresh]);

  const trial = subscription?.status === "trialing";
  const stillFree = !loading && subscription?.tier !== "premium";

  return (
    <div className="wrap medium subscription-page subscription-return">
      <h1 className="serif">
        {loading ? "Confirming your subscription…"
          : stillFree ? "Almost there"
          : trial ? "Your trial has started" : "You're subscribed"}
      </h1>
      <p>
        {loading ? "This only takes a moment."
          : stillFree ? (confirmError || "We're still waiting to hear back from Stripe. This updates as soon as it does.")
          : "Upload your sheet music and start practising whenever you're ready."}
      </p>
      {!loading && (stillFree
        ? <Link className="btn-pill ghost" href="/subscription">Check subscription status</Link>
        : <Link className="btn-pill" href="/play">Start practising</Link>)}
    </div>
  );
}
