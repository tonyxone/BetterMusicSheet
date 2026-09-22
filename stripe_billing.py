"""Stripe Checkout, webhook, and cancellation helpers.

Configuration is checked at the point of use so an API instance can serve
non-billing routes without Stripe credentials configured.
"""
import time

import stripe
from fastapi import HTTPException

import db
from config import (
    STRIPE_PRICE_MONTHLY,
    STRIPE_PRICE_YEARLY,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
)


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
    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": prices[plan], "quantity": 1}],
        success_url=success_url,
        cancel_url=cancel_url,
        client_reference_id=user_id,
        metadata={"user_id": user_id},
        # Session metadata does not automatically appear on the subscription.
        # The webhook sees the subscription, so store the owner there too.
        subscription_data={"metadata": {"user_id": user_id}},
    )
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


def _sync_subscription(subscription, deleted=False):
    metadata = _value(subscription, "metadata", {})
    user_id = _value(metadata, "user_id")
    if not user_id:
        raise HTTPException(400, "Stripe subscription is missing metadata.user_id.")
    period_end = _value(subscription, "current_period_end")
    status = "expired" if deleted else _value(subscription, "status")
    if status not in ("trialing", "active", "past_due", "canceled", "expired"):
        raise HTTPException(400, f"Unhandled Stripe subscription status: {status}")
    # A scheduled cancellation remains usable through its paid period. Stripe
    # sends subscription.deleted after that period, which becomes expired.
    if _value(subscription, "cancel_at_period_end", False) and period_end and period_end > int(time.time()):
        status = "active"
    db.upsert_subscription(
        user_id,
        status,
        _plan(subscription),
        "stripe",
        _value(subscription, "current_period_start"),
        period_end,
        bool(_value(subscription, "cancel_at_period_end", False)),
        stripe_subscription_id=_value(subscription, "id"),
    )
    return db.get_subscription(user_id)


def handle_webhook(payload, signature):
    _require(("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET))
    try:
        event = stripe.Webhook.construct_event(payload, signature, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError) as exc:
        raise HTTPException(400, "Invalid Stripe webhook signature.") from exc

    event_type = _value(event, "type")
    data = _value(_value(event, "data", {}), "object", {})
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
    return {"received": True}


def cancel_subscription(user_id):
    subscription = db.get_subscription(user_id)
    if (not subscription or subscription.get("platform") != "stripe"
            or subscription.get("status") not in ("active", "trialing")
            or not subscription.get("stripe_subscription_id")):
        raise HTTPException(404, "No active Stripe subscription found.")
    _configure_api()
    updated = stripe.Subscription.modify(
        subscription["stripe_subscription_id"], cancel_at_period_end=True,
    )
    return _sync_subscription(updated)
