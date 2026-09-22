import { Suspense } from "react";
import { SubscriptionSuccess } from "./success-view";

export default function SubscriptionSuccessPage() {
  return <Suspense fallback={<div className="wrap medium subscription-page"><p className="subscription-muted">Confirming your subscription…</p></div>}><SubscriptionSuccess /></Suspense>;
}
