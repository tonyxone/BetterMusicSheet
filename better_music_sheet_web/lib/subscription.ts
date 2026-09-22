"use client";

import { useCallback, useEffect, useState } from "react";
import { clientApiFetch } from "./client-api";

export type Subscription = {
  tier: "free" | "premium";
  plan: "monthly" | "yearly" | null;
  status: "trialing" | "active" | "past_due" | "canceled" | "expired" | null;
  current_period_end: number | null;
  cancel_at_period_end: boolean;
  platform: "stripe" | "apple" | null;
};

export const FREE_SUBSCRIPTION: Subscription = {
  tier: "free", plan: null, status: null, current_period_end: null,
  cancel_at_period_end: false, platform: null,
};

let cached: Subscription | null = null;
let request: Promise<Subscription> | null = null;
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
  request = clientApiFetch("/api/me/subscription", { cache: "no-store" })
    .then(async (response) => response.ok ? response.json() as Promise<Subscription> : FREE_SUBSCRIPTION)
    .catch(() => FREE_SUBSCRIPTION)
    .then(publish)
    .finally(() => { request = null; });
  return request;
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
