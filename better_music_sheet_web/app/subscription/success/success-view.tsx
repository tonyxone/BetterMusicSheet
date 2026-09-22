"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useSubscription } from "@/lib/subscription";

export function SubscriptionSuccess() {
  const { subscription, loading, refresh } = useSubscription();
  useEffect(() => { refresh(); }, [refresh]);
  const trial = subscription?.status === "trialing";
  return (
    <div className="wrap medium subscription-page subscription-return">
      <h1 className="serif">{loading ? "Confirming your subscription…" : trial ? "Your trial has started" : "You&apos;re subscribed"}</h1>
      <p>{loading ? "This only takes a moment." : "Practice mode is ready whenever you are."}</p>
      {!loading && <Link className="btn-pill" href="/play">Start practising</Link>}
    </div>
  );
}
