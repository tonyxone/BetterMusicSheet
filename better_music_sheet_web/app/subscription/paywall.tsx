"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "../auth-context";
import { clientApiFetch } from "@/lib/client-api";

export function Paywall() {
  const { user, loading, openSignIn } = useAuth();
  const [plan, setPlan] = useState<"monthly" | "yearly">("yearly");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkout() {
    if (!user) {
      openSignIn();
      return;
    }
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
    }
  }

  return (
    <div className="wrap medium subscription-page">
      <div className="subscription-hero">
        <p className="subscription-kicker">Practice mode</p>
        <h1 className="serif">Learn with every note lit up</h1>
        <p>Play your annotated sheets with a keyboard that follows every note, measure by measure.</p>
      </div>
      <div className="plan-toggle" role="group" aria-label="Choose a billing period">
        <button type="button" className={plan === "monthly" ? "active" : ""} onClick={() => setPlan("monthly")}>Monthly</button>
        <button type="button" className={plan === "yearly" ? "active" : ""} onClick={() => setPlan("yearly")}>Yearly <span>Save 20%</span></button>
      </div>
      <div className="subscription-plans">
        <article className={`subscription-card${plan === "monthly" ? " selected" : ""}`}>
          <h2>Monthly</h2>
          <p className="subscription-price">$1.99 <small>/ month</small></p>
          <p>Flexible practice access, billed monthly.</p>
        </article>
        <article className={`subscription-card${plan === "yearly" ? " selected" : ""}`}>
          <h2>Yearly</h2>
          <p className="subscription-price">$19.99 <small>/ year</small></p>
          <p>Best value for a full year of practice.</p>
        </article>
      </div>
      <div className="subscription-action">
        <button type="button" className="btn-pill" onClick={checkout} disabled={starting || loading}>
          {starting ? "Opening checkout…" : "Start 7-day free trial"}
        </button>
        <p>7-day free trial. Cancel anytime. Then {plan === "monthly" ? "$1.99/month" : "$19.99/year"}.</p>
        {error && <p className="subscription-error">{error}</p>}
        <Link href="/subscription">Manage subscription</Link>
      </div>
    </div>
  );
}
