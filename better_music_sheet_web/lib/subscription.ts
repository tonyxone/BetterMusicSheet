"use client";

import { useCallback, useEffect, useState } from "react";
import { clientApiFetch } from "./client-api";

export type Subscription = {
  tier: "free" | "premium";
  plan: "monthly" | "yearly" | null;
  status: "trialing" | "active" | "past_due" | "canceled" | "expired" | null;
  /** When the current subscription began, trial included (epoch seconds). */
  started_at: number | null;
  current_period_end: number | null;
  cancel_at_period_end: boolean;
  platform: "stripe" | "apple" | null;
  /** Whether a new subscription would start with the 7-day free trial -
   * only an account that has never subscribed before gets one. */
  trial_eligible: boolean;
};

export const FREE_SUBSCRIPTION: Subscription = {
  tier: "free", plan: null, status: null, started_at: null, current_period_end: null,
  cancel_at_period_end: false, platform: null, trial_eligible: true,
};

let cached: Subscription | null = null;
let request: Promise<Subscription> | null = null;
// Bumped by every forced fetch, so an older request that settles late (say,
// one sent while signed out) can't overwrite the answer of a newer one.
let generation = 0;
const EVENT = "bms-subscription-change";

function publish(subscription: Subscription) {
  cached = subscription;
  window.dispatchEvent(new Event(EVENT));
  return subscription;
}

/** Read the account's entitlement. A guest or signed-out visitor is free. */
export function fetchSubscription(force = false): Promise<Subscription> {
  if (!force && cached) return Promise.resolve(cached);
  if (!force && request) return request;
  const mine = ++generation;
  const pending: Promise<Subscription> = clientApiFetch("/api/me/subscription", { cache: "no-store" })
    .then(async (response) => response.ok ? response.json() as Promise<Subscription> : FREE_SUBSCRIPTION)
    .catch(() => FREE_SUBSCRIPTION)
    .then((subscription) => mine === generation ? publish(subscription) : (cached ?? subscription))
    .finally(() => { if (request === pending) request = null; });
  request = pending;
  return pending;
}

/** Re-read after Checkout returns, a cancellation succeeds, or focus returns. */
export function refreshSubscription() {
  return fetchSubscription(true);
}

export function useSubscription() {
  const [subscription, setSubscription] = useState<Subscription | null>(cached);

  const refresh = useCallback(() => {
    void refreshSubscription().then(setSubscription);
  }, []);

  useEffect(() => {
    void fetchSubscription().then(setSubscription);
    window.addEventListener("focus", refresh);
    const onChange = () => setSubscription(cached ?? FREE_SUBSCRIPTION);
    window.addEventListener(EVENT, onChange);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(EVENT, onChange);
    };
  }, [refresh]);

  return { subscription, loading: subscription === null, refresh };
}
