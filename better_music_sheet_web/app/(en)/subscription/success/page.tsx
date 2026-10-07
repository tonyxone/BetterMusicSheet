import { Suspense } from "react";
import { SubscriptionSuccess } from "./success-view";
import { getI18n } from "@/lib/i18n/server";

export default async function SubscriptionSuccessPage() {
  const { m } = await getI18n();
  return <Suspense fallback={<div className="wrap medium subscription-page"><p className="subscription-muted">{m.subscription.confirming}</p></div>}><SubscriptionSuccess /></Suspense>;
}
