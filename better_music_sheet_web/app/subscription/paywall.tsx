"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useAuth } from "../auth-context";
import { clientApiFetch } from "@/lib/client-api";

function planFromQuery(value: string | null): "monthly" | "yearly" | null {
  return value === "monthly" || value === "yearly" ? value : null;
}

export function Paywall() {
  const { user, loading, openSignIn } = useAuth();
  const searchParams = useSearchParams();
  const [plan, setPlan] = useState<"monthly" | "yearly">(planFromQuery(searchParams.get("plan")) ?? "yearly");
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
          <p>Flexible practice access, billed monthly.</p>
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
