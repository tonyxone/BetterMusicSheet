"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../auth-context";
import { clientApiFetch } from "@/lib/client-api";
import { useSubscription } from "@/lib/subscription";

function planFromQuery(value: string | null): "monthly" | "yearly" | null {
  return value === "monthly" || value === "yearly" ? value : null;
}

// The same on both plans - they differ only in how they're billed.
const BENEFITS = [
  "Upload your own sheets",
  "Every note labelled",
  "Practise on a keyboard",
  "Unlimited sheet storage",
  "Access anywhere",
];

function Benefits() {
  return (
    <ul className="subscription-benefits">
      {BENEFITS.map((benefit) => <li key={benefit}>{benefit}</li>)}
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
        <button type="button" className="modal-close" title="Close" aria-label="Close" onClick={onClose} disabled={starting}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <h2 id="trial-terms-title" className="serif modal-title">Before you start</h2>
        <p className="modal-sub">
          {trial
            ? <>Your 7-day free trial starts today, then it&apos;s {plan === "monthly" ? "$1.99/month" : "$19.99/year"}.</>
            : <>Your subscription starts today, and you&apos;ll be charged {plan === "monthly" ? "$1.99/month" : "$19.99/year"} right away.</>}
        </p>
        <p className="modal-sub">
          {trial && <>Cancel during the trial and you won&apos;t be charged. After that, cancelling</>}
          {!trial && <>Cancelling</>} stops the next renewal:
          you keep access until the end of the {plan === "monthly" ? "month" : "year"} you&apos;ve paid for,
          and payments already made aren&apos;t refunded.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn-pill ghost" onClick={onClose} disabled={starting}>Close</button>
          <button type="button" className="btn-pill" onClick={onAgree} disabled={starting}>
            {starting ? "Opening checkout…" : "Agree"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Paywall() {
  const { user, loading, openSignIn } = useAuth();
  // Only an account that has never subscribed gets the trial; a signed-out
  // visitor is shown the trial, and the server re-checks at checkout.
  const { subscription, loading: subscriptionLoading } = useSubscription();
  const trial = subscription?.trial_eligible !== false;
  // Already subscribed - on the web or in the iOS app - so there's nothing to
  // buy; a second subscription would only bill them twice.
  const router = useRouter();
  const subscribed = subscription?.tier === "premium";
  useEffect(() => {
    if (subscribed) router.replace("/subscription");
  }, [subscribed, router]);
  const searchParams = useSearchParams();
  // Nothing is pre-selected: the visitor picks a billing period themselves.
  // A link that names one (?plan=yearly) still arrives with it chosen.
  const [plan, setPlan] = useState<"monthly" | "yearly" | null>(planFromQuery(searchParams.get("plan")));
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
          success_url: `${origin}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/subscription/cancelled`,
        }),
      });
      const body = await response.json().catch(() => null) as { checkout_url?: string; detail?: string } | null;
      if (!response.ok || !body?.checkout_url) throw new Error(body?.detail || "Could not start checkout.");
      window.location.assign(body.checkout_url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start checkout.");
      setStarting(false);
      setTermsOpen(false);
    }
  }

  return (
    <div className="wrap medium subscription-page">
      <div className="subscription-hero">
        <p className="subscription-kicker">Premium</p>
        <h1 className="serif">Your own sheet music, labelled</h1>
        <p>
          Upload your piano music and get it back with the letter name above every note, then practise it
          on a keyboard that lights up each note as it plays.
        </p>
      </div>
      <div className="subscription-plans" role="radiogroup" aria-label="Choose a billing period">
        <article
          className={`subscription-card${plan === "monthly" ? " selected" : ""}`}
          role="radio"
          aria-checked={plan === "monthly"}
          tabIndex={0}
          onClick={() => setPlan("monthly")}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPlan("monthly"); } }}
          style={{ cursor: "pointer" }}
        >
          <h2>Monthly</h2>
          <p className="subscription-price">$1.99 <small>/ month</small></p>
          <p>Flexible access, billed monthly.</p>
          <Benefits />
        </article>
        <article
          className={`subscription-card${plan === "yearly" ? " selected" : ""}`}
          role="radio"
          aria-checked={plan === "yearly"}
          tabIndex={0}
          onClick={() => setPlan("yearly")}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPlan("yearly"); } }}
          style={{ cursor: "pointer" }}
        >
          <h2>
            Yearly <span style={{ color: "var(--success)", fontSize: 11, fontWeight: 700, marginLeft: 4 }}>Save 20%</span>
          </h2>
          <p className="subscription-price">$19.99 <small>/ year</small></p>
          <p>Best value for a full year of practice.</p>
          <Benefits />
        </article>
      </div>
      <div className="subscription-action">
        <button type="button" className="btn-pill" onClick={start} disabled={!plan || starting || loading || subscriptionLoading}>
          {trial ? "Start 7-day free trial" : "Subscribe"}
        </button>
        <p>
          {!plan
            ? `Choose monthly or yearly to ${trial ? "start your 7-day free trial" : "subscribe"}.`
            : trial
              ? <>7-day free trial for new subscribers. Cancel anytime. Then {plan === "monthly" ? "$1.99/month" : "$19.99/year"}.</>
              : <>Billed {plan === "monthly" ? "$1.99/month" : "$19.99/year"} from today. Cancel anytime.</>}
        </p>
        {error && <p className="subscription-error">{error}</p>}
      </div>
      {termsOpen && plan && (
        <TrialTerms plan={plan} trial={trial} starting={starting} onAgree={checkout} onClose={() => setTermsOpen(false)} />
      )}
    </div>
  );
}
