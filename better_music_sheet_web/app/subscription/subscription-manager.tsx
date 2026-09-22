"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "../auth-context";
import { clientApiFetch } from "@/lib/client-api";
import { refreshSubscription, useSubscription } from "@/lib/subscription";

function date(value: number | null) {
  return value ? new Date(value * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "—";
}

export function SubscriptionManager() {
  const { user, loading: authLoading, openSignIn } = useAuth();
  const { subscription, loading } = useSubscription();
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setCancelling(true);
    setError(null);
    try {
      const response = await clientApiFetch("/api/subscriptions/stripe/cancel", { method: "POST" });
      const body = await response.json().catch(() => null) as { detail?: string } | null;
      if (!response.ok) throw new Error(body?.detail || "Could not cancel the subscription.");
      await refreshSubscription();
      setConfirming(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not cancel the subscription.");
    } finally {
      setCancelling(false);
    }
  }

  async function switchPlan(plan: "monthly" | "yearly") {
    setSwitching(true);
    setError(null);
    try {
      const response = await clientApiFetch("/api/subscriptions/stripe/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const body = await response.json().catch(() => null) as { detail?: string } | null;
      if (!response.ok) throw new Error(body?.detail || "Could not switch plans.");
      await refreshSubscription();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not switch plans.");
    } finally {
      setSwitching(false);
    }
  }

  if (authLoading || loading) return <div className="wrap medium subscription-page"><p className="subscription-muted">Loading subscription…</p></div>;
  if (!user) {
    return <div className="wrap medium subscription-page"><h1 className="serif">Your subscription</h1><p>Sign in to view or manage a subscription.</p><button type="button" className="btn-pill" onClick={() => openSignIn()}>Sign in</button></div>;
  }
  if (!subscription || subscription.tier === "free") {
    return <div className="wrap medium subscription-page"><h1 className="serif">Your subscription</h1><p>You&apos;re on the free plan. Upgrade to unlock practice mode.</p><Link className="btn-pill" href="/subscription/upgrade">Start 7-day free trial</Link></div>;
  }

  const pending = subscription.cancel_at_period_end;
  const otherPlan: "monthly" | "yearly" = subscription.plan === "yearly" ? "monthly" : "yearly";
  return (
    <div className="wrap medium subscription-page">
      <div className="page-title-row"><h1 className="serif">Your subscription</h1></div>
      <section className="subscription-card manage-card">
        <dl>
          <div><dt>Plan</dt><dd>{subscription.plan === "yearly" ? "Yearly" : "Monthly"}</dd></div>
          <div><dt>Status</dt><dd>{pending ? "Cancels at period end" : subscription.status === "trialing" ? "Trial active" : "Active"}</dd></div>
          <div><dt>{pending ? "Access ends" : "Renews"}</dt><dd>{date(subscription.current_period_end)}</dd></div>
          <div><dt>Billing</dt><dd>{subscription.platform === "stripe" ? "Stripe" : "Apple"}</dd></div>
        </dl>
        {pending ? (
          <p className="subscription-notice">Cancellation is pending. Practice access continues until {date(subscription.current_period_end)}.</p>
        ) : subscription.platform === "stripe" ? (
          confirming ? (
            <div className="subscription-confirm">
              <p>Cancel now? You keep practice access until {date(subscription.current_period_end)}.</p>
              <button type="button" className="btn-pill danger" onClick={cancel} disabled={cancelling}>{cancelling ? "Cancelling…" : "Confirm cancellation"}</button>
              <button type="button" className="btn-pill ghost" onClick={() => setConfirming(false)} disabled={cancelling}>Keep subscription</button>
            </div>
          ) : (
            <div className="subscription-confirm">
              <button type="button" className="btn-pill ghost" onClick={() => switchPlan(otherPlan)} disabled={switching}>
                {switching ? "Switching…" : `Switch to ${otherPlan === "yearly" ? "Yearly" : "Monthly"}`}
              </button>
              <button type="button" className="btn-pill ghost" onClick={() => setConfirming(true)}>Cancel subscription</button>
            </div>
          )
        ) : <p className="subscription-muted">Manage this subscription through Apple.</p>}
        {error && <p className="subscription-error">{error}</p>}
      </section>
    </div>
  );
}
