"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../auth-context";
import { clientApiFetch } from "@/lib/client-api";
import { refreshSubscription, useSubscription } from "@/lib/subscription";

function dateTime(value: number | null) {
  return value ? new Date(value * 1000).toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
}

export function SubscriptionManager() {
  const { user, loading: authLoading, openSignIn } = useAuth();
  const { subscription, loading } = useSubscription();
  const router = useRouter();
  // Without a subscription there is nothing to manage here - the upgrade page
  // is where plans are chosen, so a free account is sent straight there.
  const free = !authLoading && !loading && !!user && (!subscription || subscription.tier === "free");
  useEffect(() => {
    if (free) router.replace("/subscription/upgrade");
  }, [free, router]);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
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

  if (authLoading || loading) return <div className="wrap medium subscription-page"><p className="subscription-muted">Loading subscription…</p></div>;
  if (!user) {
    return <div className="wrap medium subscription-page"><h1 className="serif">Your subscription</h1><p>Sign in to view or manage a subscription.</p><button type="button" className="btn-pill" onClick={() => openSignIn()}>Sign in</button></div>;
  }
  // Free accounts are on their way to the upgrade page (see the effect above).
  if (free || !subscription) return <div className="wrap medium subscription-page"><p className="subscription-muted">Loading subscription…</p></div>;

  const pending = subscription.cancel_at_period_end;
  return (
    <div className="wrap medium subscription-page">
      <div className="page-title-row"><h1 className="serif">Your subscription</h1></div>
      <section className="subscription-card manage-card">
        <dl>
          <div><dt>Plan</dt><dd>{subscription.plan === "yearly" ? "Yearly" : "Monthly"}</dd></div>
          <div><dt>Status</dt><dd>{pending ? "Cancels at period end" : subscription.status === "trialing" ? "Trial active" : "Active"}</dd></div>
          <div><dt>Started</dt><dd>{dateTime(subscription.started_at)}</dd></div>
          <div><dt>{pending ? "Access ends" : "Renews"}</dt><dd>{dateTime(subscription.current_period_end)}</dd></div>
        </dl>
        {pending ? (
          <p className="subscription-notice">Cancellation is pending. Premium access continues until {dateTime(subscription.current_period_end)}, then ends. You won&apos;t be charged again, and no refund is issued for the current period.</p>
        ) : subscription.platform === "stripe" ? (
          confirming ? (
            <div className="subscription-confirm">
              <p>
                {subscription.status === "trialing"
                  ? <>Cancel your free trial? You keep Premium access until {dateTime(subscription.current_period_end)}, and you won&apos;t be charged.</>
                  : <>Cancel your subscription? It stays active until the end of the period you&apos;ve paid for, {dateTime(subscription.current_period_end)}, and then ends. You won&apos;t be charged again, but no refund is issued for the time remaining.</>}
              </p>
              <button type="button" className="btn-pill danger" onClick={cancel} disabled={cancelling}>{cancelling ? "Cancelling…" : "Confirm cancellation"}</button>
              <button type="button" className="btn-pill ghost" onClick={() => setConfirming(false)} disabled={cancelling}>Keep subscription</button>
            </div>
          ) : (
            <div className="subscription-confirm">
              <button type="button" className="btn-pill danger" onClick={() => setConfirming(true)}>Cancel Subscription</button>
            </div>
          )
        ) : <p className="subscription-muted">Manage this subscription through Apple.</p>}
        {error && <p className="subscription-error">{error}</p>}
      </section>
    </div>
  );
}
