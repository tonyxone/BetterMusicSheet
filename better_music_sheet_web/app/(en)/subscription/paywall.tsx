"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../../auth-context";
import { clientApiFetch } from "@/lib/client-api";
import { useSubscription } from "@/lib/subscription";
import { useI18n } from "@/lib/i18n/client";
import { fmt } from "@/lib/i18n/format";
import { translateKnown } from "@/lib/i18n/known-text";
import { DAILY_SHEETS } from "@/lib/plan-limits";

function planFromQuery(value: string | null): "monthly" | "yearly" | null {
  return value === "monthly" || value === "yearly" ? value : null;
}

/** Drawn like a plan card, so the three read as one row - but not one of
 * the choices: it's outside the plans' radio group.
 *
 * What an account has without subscribing - the limits server.py
 * (FREE_SHEET_LIMIT, DAILY_SHEET_LIMITS) and play-view.tsx (FREE_LINES) enforce. Not a choice
 * on this page: it's the plan everyone starts on, shown beside Premium's for
 * comparison, as the iOS app's paywall does. */
export function FreePlanCard() {
  const { m } = useI18n();
  const t = m.paywall;
  const points = [
    { included: true, text: t.freePoints.labelled },
    { included: true, text: t.freePoints.edit },
    { included: false, text: t.freePoints.oneSheet },
    { included: false, text: fmt(t.dailySheets, { count: DAILY_SHEETS.free }) },
    { included: false, text: t.freePoints.twoLines },
  ];
  return (
    <section className="subscription-card free-plan-card" aria-label={t.freePlan}>
      <h2>{t.free}</h2>
      <p className="subscription-price">$0</p>
      <p>{t.freeSub}</p>
      <ul className="free-plan-points">
        {points.map((point) => (
          <li key={point.text} className={point.included ? "included" : "limited"}>
            <span className="free-plan-mark" aria-hidden="true">{point.included ? "✓" : "–"}</span>
            {point.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

// The same on both plans but for how many sheets each may upload a day.
function Benefits({ daily }: { daily: number }) {
  const { m } = useI18n();
  return (
    <ul className="subscription-benefits">
      <li>{fmt(m.paywall.dailySheets, { count: daily })}</li>
      {m.paywall.benefits.map((benefit) => <li key={benefit}>{benefit}</li>)}
    </ul>
  );
}

/** The cancellation and refund terms, agreed to before checkout opens. */
function TrialTerms({ plan, trial, starting, onAgree, onClose }: {
  plan: "monthly" | "yearly";
  trial: boolean;
  starting: boolean;
  onAgree: () => void;
  onClose: () => void;
}) {
  const { m } = useI18n();
  const t = m.paywall;
  const price = plan === "monthly" ? t.priceMonthly : t.priceYearly;
  const period = plan === "monthly" ? t.month : t.year;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !starting) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, starting]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !starting) onClose();
      }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="trial-terms-title">
        <button type="button" className="modal-close" title={m.common.close} aria-label={m.common.close} onClick={onClose} disabled={starting}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <h2 id="trial-terms-title" className="serif modal-title">{t.termsTitle}</h2>
        <p className="modal-sub">{fmt(trial ? t.trialStarts : t.chargedNow, { price })}</p>
        <p className="modal-sub">{fmt(trial ? t.cancelTermsTrial : t.cancelTerms, { period })}</p>
        <div className="modal-actions">
          <button type="button" className="btn-pill ghost" onClick={onClose} disabled={starting}>{m.common.close}</button>
          <button type="button" className="btn-pill" onClick={onAgree} disabled={starting}>
            {starting ? t.openingCheckout : t.agree}
          </button>
        </div>
      </div>
    </div>
  );
}

/** ``previewOnly``: the plans to look at, with nothing to choose or buy -
 * for someone not signed in yet (the sign-in window's "See Premium plans",
 * like the iOS app's). */
export function Paywall({ previewOnly = false }: { previewOnly?: boolean } = {}) {
  const { user, loading, openSignIn } = useAuth();
  const { m, path } = useI18n();
  const t = m.paywall;
  // Only an account that has never subscribed gets the trial; a signed-out
  // visitor is shown the trial, and the server re-checks at checkout.
  const { subscription, loading: subscriptionLoading } = useSubscription();
  const trial = subscription?.trial_eligible !== false;
  // Already subscribed - on the web or in the iOS app - so there's nothing to
  // buy; a second subscription would only bill them twice.
  const router = useRouter();
  const subscribed = subscription?.tier === "premium";
  useEffect(() => {
    if (subscribed && !previewOnly) router.replace(path("/subscription"));
  }, [subscribed, previewOnly, router, path]);
  const searchParams = useSearchParams();
  // Nothing is pre-selected: the visitor picks a billing period themselves.
  // A link that names one (?plan=yearly) still arrives with it chosen.
  const [chosen, setPlan] = useState<"monthly" | "yearly" | null>(planFromQuery(searchParams.get("plan")));
  const plan = previewOnly ? null : chosen;
  // In a preview the cards are only to read: no radio, no selection.
  const choice = (value: "monthly" | "yearly") => previewOnly ? {} : {
    role: "radio",
    "aria-checked": plan === value,
    tabIndex: 0,
    onClick: () => setPlan(value),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPlan(value); } },
    style: { cursor: "pointer" },
  };
  const [starting, setStarting] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start() {
    if (!plan) return;
    if (!user) {
      openSignIn();
      return;
    }
    setError(null);
    setTermsOpen(true);
  }

  async function checkout() {
    if (!plan) return;
    setStarting(true);
    setError(null);
    try {
      const origin = window.location.origin;
      const response = await clientApiFetch("/api/subscriptions/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan,
          success_url: `${origin}${path("/subscription/success")}?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}${path("/subscription/cancelled")}`,
        }),
      });
      const body = await response.json().catch(() => null) as { checkout_url?: string; detail?: string } | null;
      if (!response.ok || !body?.checkout_url) throw new Error(translateKnown(body?.detail, m) || t.checkoutFailed);
      window.location.assign(body.checkout_url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.checkoutFailed);
      setStarting(false);
      setTermsOpen(false);
    }
  }

  return (
    <div className="wrap medium subscription-page">
      <div className="subscription-hero">
        <p className="subscription-kicker">{t.kicker}</p>
        <h1 className="serif">{t.heroTitle}</h1>
        <p>{t.heroBody}</p>
      </div>
      {/* Free, Monthly and Yearly side by side; only the two plans are a choice. */}
      <div className="subscription-tiers">
      <FreePlanCard />
      <div className="subscription-plans" {...(previewOnly ? {} : { role: "radiogroup", "aria-label": t.chooseBilling })}>
        <article className={`subscription-card${plan === "monthly" ? " selected" : ""}`} {...choice("monthly")}>
          <h2>{t.monthly}</h2>
          <p className="subscription-price">{t.amountMonthly} <small>{t.perMonth}</small></p>
          <p>{t.monthlyBody}</p>
          <Benefits daily={DAILY_SHEETS.monthly} />
        </article>
        <article className={`subscription-card${plan === "yearly" ? " selected" : ""}`} {...choice("yearly")}>
          <h2>
            {t.yearly} <span style={{ color: "var(--success)", fontSize: 11, fontWeight: 700, marginLeft: 4 }}>{t.save}</span>
          </h2>
          <p className="subscription-price">{t.amountYearly} <small>{t.perYear}</small></p>
          <p>{t.yearlyBody}</p>
          <Benefits daily={DAILY_SHEETS.yearly} />
        </article>
      </div>
      </div>
      {previewOnly ? (
        <div className="subscription-action">
          <p>{t.signInToSubscribe}</p>
        </div>
      ) : (
      <div className="subscription-action">
        <button type="button" className="btn-pill" onClick={start} disabled={!plan || starting || loading || subscriptionLoading}>
          {trial ? t.startTrial : t.subscribe}
        </button>
        <p>
          {!plan
            ? (trial ? t.choosePlanTrial : t.choosePlan)
            : fmt(trial ? t.trialNote : t.billedNote, { price: plan === "monthly" ? t.priceMonthly : t.priceYearly })}
        </p>
        {error && <p className="subscription-error">{error}</p>}
      </div>
      )}
      {termsOpen && plan && (
        <TrialTerms plan={plan} trial={trial} starting={starting} onAgree={checkout} onClose={() => setTermsOpen(false)} />
      )}
    </div>
  );
}
