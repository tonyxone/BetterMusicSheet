"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../../auth-context";
import { clientApiFetch } from "@/lib/client-api";
import { refreshSubscription, useSubscription } from "@/lib/subscription";
import { useI18n } from "@/lib/i18n/client";
import { fmt } from "@/lib/i18n/format";
import { translateKnown } from "@/lib/i18n/known-text";

type CancelDetail = string | { code: "manage_with_apple"; message: string; url: string };

function dateTime(value: number | null, tag: string) {
  return value ? new Date(value * 1000).toLocaleString(tag, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
}

export function SubscriptionManager() {
  const { user, loading: authLoading, openSignIn } = useAuth();
  const { subscription, loading } = useSubscription();
  const router = useRouter();
  const { m, tag, path } = useI18n();
  const t = m.subscription;
  const date = (value: number | null) => dateTime(value, tag);
  // Without a subscription there is nothing to manage here - the upgrade page
  // is where plans are chosen, so a free account is sent straight there.
  const free = !authLoading && !loading && !!user && (!subscription || subscription.tier === "free");
  useEffect(() => {
    if (free) router.replace(path("/subscription/upgrade"));
  }, [free, router, path]);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the backend answers that this subscription has to be cancelled
  // with Apple: no server can cancel an App Store subscription.
  const [manageWithApple, setManageWithApple] = useState<{ message: string; url: string } | null>(null);

  async function cancel() {
    if (!subscription?.platform) return;
    setCancelling(true);
    setError(null);
    try {
      // The backend cancels through whichever store billed it; naming the
      // platform lets it refuse if what this page shows is out of date.
      const response = await clientApiFetch("/api/subscriptions/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: subscription.platform }),
      });
      const body = await response.json().catch(() => null) as { detail?: CancelDetail } | null;
      const detail = body?.detail;
      if (typeof detail === "object" && detail?.code === "manage_with_apple") {
        setManageWithApple({ message: detail.message, url: detail.url });
        setConfirming(false);
        return;
      }
      if (!response.ok) throw new Error(typeof detail === "string" ? translateKnown(detail, m) : t.cancelFailed);
      await refreshSubscription();
      setConfirming(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.cancelFailed);
    } finally {
      setCancelling(false);
    }
  }

  if (authLoading || loading) return <div className="wrap medium subscription-page"><p className="subscription-muted">{m.common.loadingSubscription}</p></div>;
  if (!user) {
    return <div className="wrap medium subscription-page"><h1 className="serif">{t.title}</h1><p>{t.signInToManage}</p><button type="button" className="btn-pill" onClick={() => openSignIn()}>{m.common.signIn}</button></div>;
  }
  // Free accounts are on their way to the upgrade page (see the effect above).
  if (free || !subscription) return <div className="wrap medium subscription-page"><p className="subscription-muted">{m.common.loadingSubscription}</p></div>;

  // A master account is premium without paying; unless it also bought a
  // subscription there is no plan to show and nothing to cancel.
  if (subscription.master && !subscription.platform) {
    return (
      <div className="wrap medium subscription-page">
        <div className="page-title-row"><h1 className="serif">{t.title}</h1></div>
        <section className="subscription-card manage-card">
          <dl>
            <div><dt>{t.plan}</dt><dd>{t.masterAccount}</dd></div>
            <div><dt>{t.status}</dt><dd>{t.masterStatus}</dd></div>
          </dl>
        </section>
      </div>
    );
  }

  const pending = subscription.cancel_at_period_end;
  return (
    <div className="wrap medium subscription-page">
      <div className="page-title-row"><h1 className="serif">{t.title}</h1></div>
      <section className="subscription-card manage-card">
        <dl>
          <div><dt>{t.plan}</dt><dd>{subscription.plan === "yearly" ? m.paywall.yearly : m.paywall.monthly}</dd></div>
          <div><dt>{t.status}</dt><dd>{pending ? t.cancelsAtEnd : subscription.status === "trialing" ? t.trialActive : t.active}</dd></div>
          <div><dt>{t.started}</dt><dd>{date(subscription.started_at)}</dd></div>
          <div><dt>{pending ? t.accessEnds : t.renews}</dt><dd>{date(subscription.current_period_end)}</dd></div>
        </dl>
        {pending ? (
          <p className="subscription-notice">{fmt(t.pending, { date: date(subscription.current_period_end) })}</p>
        ) : manageWithApple ? (
          <div className="subscription-notice">
            <p>{translateKnown(manageWithApple.message, m)}</p>
            <a href={manageWithApple.url} target="_blank" rel="noreferrer">{t.openApple}</a>
          </div>
        ) : confirming ? (
          <div className="subscription-confirm">
            <p>
              {fmt(subscription.status === "trialing" ? t.cancelTrialConfirm : t.cancelConfirm, { date: date(subscription.current_period_end) })}
            </p>
            <button type="button" className="btn-pill danger" onClick={cancel} disabled={cancelling}>{cancelling ? m.sheet.cancelling : t.confirmCancel}</button>
            <button type="button" className="btn-pill ghost" onClick={() => setConfirming(false)} disabled={cancelling}>{t.keep}</button>
          </div>
        ) : (
          <div className="subscription-confirm">
            {/* Apple subscriptions can only be cancelled with Apple, so
                there's nothing to confirm here - go straight to where. */}
            <button type="button" className="btn-pill danger" onClick={subscription.platform === "apple" ? cancel : () => setConfirming(true)} disabled={cancelling}>
              {t.cancelButton}
            </button>
          </div>
        )}
        {error && <p className="subscription-error">{error}</p>}
      </section>
    </div>
  );
}
