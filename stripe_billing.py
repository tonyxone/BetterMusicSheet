"""Stripe Checkout, webhook, and cancellation helpers.

Configuration is checked at the point of use so an API instance can serve
non-billing routes without Stripe credentials configured.
"""
import logging
import re
import time

import stripe
# Imported by name, not read off the `stripe` module at call time: tests
# patch stripe_billing.stripe with a Mock() (see test_subscription.py), and
# `except stripe.error.StripeError` would then try to match against a Mock
# attribute instead of a real exception class.
from stripe.error import (
    APIConnectionError,
    APIError,
    InvalidRequestError,
    RateLimitError,
    StripeError,
)
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

logger = logging.getLogger(__name__)

# Failures where Stripe never gave an answer, or a transient one; trying
# again later can work. Every other StripeError is Stripe refusing the call.
_UNREACHABLE = (APIConnectionError, APIError, RateLimitError)


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


def _stripe_failed(action, exc):
    """Log what Stripe actually answered, and turn it into a message that
    says what happened. Only a failure to get an answer is worth retrying;
    a refusal (no such subscription, a key without permission) will fail
    the same way every time, so it shouldn't be dressed up as a network
    blip. Stripe's own text can quote part of the API key, so the visitor
    gets just its error code; the log has the rest."""
    logger.warning("Stripe failed to %s: %s: %s", action, type(exc).__name__, exc)
    if isinstance(exc, _UNREACHABLE):
        return HTTPException(502, f"We couldn't reach Stripe to {action}. Please try again in a moment.")
    code = f" ({exc.code})" if getattr(exc, "code", None) else ""
    return HTTPException(
        502, f"Stripe declined to {action}{code}. Please contact bettermusicsheet@gmail.com.",
    )


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
        # Stripe's own times, for the admin dashboard. canceled_at is when the
        # cancellation was requested, even one that waits for the period end.
        canceled_at=_value(subscription, "canceled_at"),
        ended_at=_value(subscription, "ended_at"),
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
        raise _stripe_failed("confirm that checkout", exc) from exc
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
        raise _stripe_failed("change your plan", exc) from exc
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
    subscription_id = subscription["subscription_id"]
    try:
        updated = stripe.Subscription.modify(subscription_id, cancel_at_period_end=True)
    except StripeError as exc:
        # Stripe refuses to schedule the end of a subscription that has
        # already ended - cancelled from its dashboard, say, with the
        # webhook that would have said so missed. Then there is nothing
        # left to cancel: record the end, as that webhook would have.
        ended = _ended_in_stripe(subscription_id) if isinstance(exc, InvalidRequestError) else None
        if ended is None:
            raise _stripe_failed("cancel your subscription", exc) from exc
        logger.warning("Stripe subscription %s had already ended; recording that", subscription_id)
        return _sync_subscription(ended, deleted=True)
    return _sync_subscription(updated)


def _ended_in_stripe(subscription_id):
    """The subscription as Stripe has it, if Stripe says it has ended."""
    try:
        current = stripe.Subscription.retrieve(subscription_id)
    except StripeError:
        return None
    return current if _value(current, "status") in ("canceled", "incomplete_expired") else None


# Stripe counts most currencies in hundredths, these in whole units, and these
# in thousandths (https://docs.stripe.com/currencies#zero-decimal).
_ZERO_DECIMAL = {"bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv",
                 "xaf", "xof", "xpf"}
_THREE_DECIMAL = {"bhd", "jod", "kwd", "omr", "tnd"}
# Why an invoice was raised. A plan change is a prorated top-up, so the
# dashboard marks it; the rest are just the subscription billing as usual.
_PLAN_CHANGE = "subscription_update"
_SEARCHABLE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def _major(amount, currency):
    digits = 0 if currency in _ZERO_DECIMAL else 3 if currency in _THREE_DECIMAL else 2
    return (amount or 0) / 10 ** digits


def _payment(invoice, prices):
    """One invoice as the admin dashboard lists it, or None for one that
    never asked for money: a free trial's $0 invoice, a draft, a voided one."""
    status = _value(invoice, "status")
    due, paid = _value(invoice, "amount_due", 0), _value(invoice, "amount_paid", 0)
    if status in ("draft", "void") or not (due or paid):
        return None
    currency = _value(invoice, "currency", "usd")
    charge = _value(invoice, "charge")
    # Expanded, the charge says how much went back; a bare id says nothing.
    refunded = _value(charge, "amount_refunded", 0) if not isinstance(charge, str) else 0
    lines = _value(_value(invoice, "lines", {}), "data", [])
    starts = [_value(_value(line, "period", {}), "start") for line in lines]
    ends = [_value(_value(line, "period", {}), "end") for line in lines]
    price_ids = [_value(_value(line, "price", {}), "id") for line in lines]
    plan = next((plan for plan, price in prices.items() if price in price_ids), None)
    if status == "paid":
        state = "refunded" if paid and refunded >= paid else "paid"
    else:
        # open (awaiting payment or a retry) or uncollectible (gave up).
        state = "unpaid"
    return {
        "id": _value(invoice, "id"),
        "platform": "stripe",
        "paid_at": _value(_value(invoice, "status_transitions", {}), "paid_at") if status == "paid" else None,
        "created_at": _value(invoice, "created"),
        "amount": _major(paid if status == "paid" else due, currency),
        "refunded": _major(refunded, currency),
        "currency": currency,
        "status": state,
        "plan": plan,
        "plan_change": _value(invoice, "billing_reason") == _PLAN_CHANGE,
        "period_start": min((s for s in starts if s), default=None),
        "period_end": max((e for e in ends if e), default=None),
    }


def payments(user_id, subscription_id=None):
    """What the account has been charged through Stripe, newest first, plus
    notes on anything that couldn't be read.

    Every Stripe subscription the account has had counts, not just the one
    on record: a subscriber who left and came back has two. They are found by
    the user_id each carries in its metadata (see create_checkout). Search
    lags new subscriptions by about a minute, so the recorded one is added if
    it hasn't shown up yet."""
    _configure_api()
    # Only to name each payment's plan; a missing price just leaves it blank.
    prices = {plan: price for plan, price in (("monthly", STRIPE_PRICE_MONTHLY), ("yearly", STRIPE_PRICE_YEARLY))
              if price}
    notes = []
    try:
        ids = []
        if _SEARCHABLE_ID.match(user_id):
            found = stripe.Subscription.search(query=f"metadata['user_id']:'{user_id}'", limit=100)
            ids = [_value(s, "id") for s in found.auto_paging_iter()]
        if subscription_id and subscription_id not in ids:
            ids.append(subscription_id)
        rows = []
        for sid in ids:
            try:
                invoices = stripe.Invoice.list(subscription=sid, limit=100, expand=["data.charge"])
                rows.extend(row for row in (_payment(inv, prices) for inv in invoices.auto_paging_iter()) if row)
            except InvalidRequestError as exc:
                # Typically a test-mode subscription recorded by a local
                # server sharing the production table - the live key can't
                # see it.
                logger.warning("Stripe could not list invoices for %s: %s", sid, exc)
                notes.append(f"Stripe has no subscription {sid} under this key (a test-mode one, perhaps).")
    except StripeError as exc:
        raise _stripe_failed("list payments", exc) from exc
    rows.sort(key=lambda row: row["paid_at"] or row["created_at"] or 0, reverse=True)
    return rows, notes
