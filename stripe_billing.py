"""Stripe Checkout, webhook, and cancellation helpers.

Configuration is checked at the point of use so an API instance can serve
non-billing routes without Stripe credentials configured.
"""
import time

import stripe
# Imported by name, not read off the `stripe` module at call time: tests
# patch stripe_billing.stripe with a Mock() (see test_subscription.py), and
# `except stripe.error.StripeError` would then try to match against a Mock
# attribute instead of a real exception class.
from stripe.error import StripeError
from fastapi import HTTPException

import db
from auth import can_record_subscription, has_active_subscription, is_trial_eligible
from config import (
    STRIPE_PRICE_MONTHLY,
    STRIPE_PRICE_YEARLY,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
)

TRIAL_DAYS = 7

ALREADY_SUBSCRIBED = "This account already has an active subscription."


def _value(item, key, default=None):
    if item is None:
        return default
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _require(*settings):
    missing = [name for name, value in settings if not value]
    if missing:
        raise HTTPException(503, f"Stripe billing is not configured: set {', '.join(missing)}.")


def _configure_api():
    _require(("STRIPE_SECRET_KEY", STRIPE_SECRET_KEY))
    stripe.api_key = STRIPE_SECRET_KEY


def _prices():
    _require(
        ("STRIPE_PRICE_MONTHLY", STRIPE_PRICE_MONTHLY),
        ("STRIPE_PRICE_YEARLY", STRIPE_PRICE_YEARLY),
    )
    return {"monthly": STRIPE_PRICE_MONTHLY, "yearly": STRIPE_PRICE_YEARLY}


def create_checkout(user_id, plan, success_url, cancel_url):
    """Create one hosted Checkout Session for the selected recurring plan."""
    _configure_api()
    prices = _prices()
    if plan not in prices:
        raise HTTPException(422, "plan must be monthly or yearly")
    # A subscription from either store already covers web and iOS; a second
    # one would just bill the same person twice.
    if has_active_subscription(user_id):
        raise HTTPException(409, ALREADY_SUBSCRIBED)
    # Session metadata does not automatically appear on the subscription.
    # The webhook sees the subscription, so store the owner there too.
    subscription_data = {"metadata": {"user_id": user_id}}
    # Neither Price has a trial of its own, so the trial is asked for here -
    # and only for a first-time subscriber (see auth.is_trial_eligible). The
    # card is still collected up front and first charged when the trial ends.
    if is_trial_eligible(user_id):
        subscription_data["trial_period_days"] = TRIAL_DAYS
    try:
        session = stripe.checkout.Session.create(
            mode="subscription",
            line_items=[{"price": prices[plan], "quantity": 1}],
            success_url=success_url,
            cancel_url=cancel_url,
            client_reference_id=user_id,
            metadata={"user_id": user_id},
            subscription_data=subscription_data,
        )
    except StripeError as exc:
        # A bad price id (e.g. STRIPE_PRICE_MONTHLY/YEARLY misconfigured -
        # they must be Price ids, not Payment Link ids), a revoked key, or
        # Stripe itself being briefly unreachable would otherwise surface as
        # a bare 500 - not something a visitor trying to subscribe can act on.
        raise HTTPException(502, "We couldn't start checkout with Stripe. Please try again in a moment.") from exc
    url = _value(session, "url")
    if not url:
        raise HTTPException(502, "Stripe did not return a checkout URL.")
    return {"checkout_url": url}


def _plan(subscription):
    prices = _prices()
    items = _value(subscription, "items", {})
    item_list = _value(items, "data", [])
    price = _value(_value(item_list[0], "price", {}), "id") if item_list else None
    for plan, price_id in prices.items():
        if price == price_id:
            return plan
    raise HTTPException(400, "Stripe subscription uses an unknown price.")


def _period(subscription, key):
    """current_period_start/end, wherever this payload's API version put it.

    Stripe moved the billing period off the subscription and onto each
    subscription item in API 2025-03-31. The webhook endpoint is pinned to a
    newer version than this library, so webhook payloads carry it only on the
    item while API calls made here still carry it on the subscription."""
    value = _value(subscription, key)
    if value is None:
        items = _value(_value(subscription, "items", {}), "data", [])
        value = _value(items[0], key) if items else None
    return value


def _sync_subscription(subscription, deleted=False):
    metadata = _value(subscription, "metadata", {})
    user_id = _value(metadata, "user_id")
    if not user_id:
        raise HTTPException(400, "Stripe subscription is missing metadata.user_id.")
    period_end = _period(subscription, "current_period_end")
    status = "expired" if deleted else _value(subscription, "status")
    if status not in ("trialing", "active", "past_due", "canceled", "expired"):
        raise HTTPException(400, f"Unhandled Stripe subscription status: {status}")
    # A scheduled cancellation remains usable through its paid period. Stripe
    # sends subscription.deleted after that period, which becomes expired.
    if _value(subscription, "cancel_at_period_end", False) and period_end and period_end > int(time.time()):
        status = "active"
    subscription_id = _value(subscription, "id")
    if not can_record_subscription(user_id, "stripe", subscription_id):
        raise HTTPException(409, ALREADY_SUBSCRIBED)
    db.upsert_subscription(
        user_id,
        status,
        _plan(subscription),
        "stripe",
        _period(subscription, "current_period_start"),
        period_end,
        bool(_value(subscription, "cancel_at_period_end", False)),
        subscription_id=subscription_id,
        # When this subscription began (trial included) - unlike the period
        # start, it doesn't move on each renewal. Per subscription, so a
        # rejoining account shows its new start, not its first-ever one.
        started_at=_value(subscription, "start_date"),
    )
    return db.get_subscription(user_id)


def confirm_checkout(user_id, session_id):
    """Sync entitlement right away from a just-completed Checkout Session,
    rather than waiting on customer.subscription.created to arrive by
    webhook. In local dev Stripe has no reachable URL to deliver it to at
    all; even in production the browser's own redirect back to /success can
    beat the webhook there. success_url already carries {CHECKOUT_SESSION_ID}
    (see paywall.tsx's checkout()), so the success page has this for free.
    """
    _configure_api()
    try:
        session = stripe.checkout.Session.retrieve(session_id, expand=["subscription"])
    except StripeError as exc:
        raise HTTPException(502, "We couldn't confirm that checkout with Stripe. Please try again in a moment.") from exc
    if _value(session, "client_reference_id") != user_id:
        raise HTTPException(403, "This checkout session belongs to a different account.")
    subscription = _value(session, "subscription")
    if not subscription:
        raise HTTPException(409, "That checkout hasn't finished yet. Please try again in a moment.")
    return _sync_subscription(subscription)


def change_plan(user_id, plan):
    """Move an existing, active Stripe subscription onto the other recurring
    price - e.g. monthly to yearly - rather than starting a second one."""
    subscription = db.get_subscription(user_id)
    if (not subscription or subscription.get("platform") != "stripe"
            or subscription.get("status") not in ("active", "trialing")
            or not subscription.get("subscription_id")):
        raise HTTPException(404, "No active Stripe subscription found.")
    prices = _prices()
    if plan not in prices:
        raise HTTPException(422, "plan must be monthly or yearly")
    if subscription.get("plan") == plan:
        raise HTTPException(409, f"Already on the {plan} plan.")
    _configure_api()
    try:
        current = stripe.Subscription.retrieve(subscription["subscription_id"])
        items = _value(_value(current, "items", {}), "data", [])
        item_id = _value(items[0], "id") if items else None
        updated = stripe.Subscription.modify(
            subscription["subscription_id"],
            items=[{"id": item_id, "price": prices[plan]}],
            proration_behavior="create_prorations",
        )
    except StripeError as exc:
        raise HTTPException(502, "We couldn't reach Stripe to change your plan. Please try again in a moment.") from exc
    return _sync_subscription(updated)


def handle_webhook(payload, signature):
    _require(("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET))
    try:
        event = stripe.Webhook.construct_event(payload, signature, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError) as exc:
        raise HTTPException(400, "Invalid Stripe webhook signature.") from exc

    event_type = _value(event, "type")
    data = _value(_value(event, "data", {}), "object", {})
    try:
        if event_type in ("customer.subscription.created", "customer.subscription.updated"):
            _sync_subscription(data)
        elif event_type == "customer.subscription.deleted":
            _sync_subscription(data, deleted=True)
        elif event_type == "invoice.payment_failed":
            _configure_api()
            subscription_id = _value(data, "subscription")
            subscription_id = _value(subscription_id, "id", subscription_id)
            if subscription_id:
                _sync_subscription(stripe.Subscription.retrieve(subscription_id))
    except HTTPException as exc:
        # About a Stripe subscription the account no longer uses while another
        # one is active (see auth.can_record_subscription). Nothing to record,
        # and answering an error would only make Stripe keep retrying it.
        if exc.status_code != 409:
            raise
        return {"received": True, "ignored": exc.detail}
    return {"received": True}


def cancel_subscription(user_id):
    subscription = db.get_subscription(user_id)
    if (not subscription or subscription.get("platform") != "stripe"
            or subscription.get("status") not in ("active", "trialing")
            or not subscription.get("subscription_id")):
        raise HTTPException(404, "No active Stripe subscription found.")
    _configure_api()
    try:
        updated = stripe.Subscription.modify(
            subscription["subscription_id"], cancel_at_period_end=True,
        )
    except StripeError as exc:
        raise HTTPException(502, "We couldn't reach Stripe to cancel your subscription. Please try again in a moment.") from exc
    return _sync_subscription(updated)
