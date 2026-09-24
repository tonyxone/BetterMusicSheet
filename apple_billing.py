"""Apple App Store transaction and notification helpers.

Apple signs transaction data as JWS. Version one decodes those payloads so
the App Store Server API remains the authoritative source for transactions.
"""
import base64
import json
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import HTTPException
from jose import jwt

import db
from auth import can_record_subscription
from config import (
    APPLE_APP_ID,
    APPLE_BUNDLE_ID,
    APPLE_ENV,
    APPLE_ISSUER_ID,
    APPLE_KEY_ID,
    APPLE_PRIVATE_KEY,
    APPLE_PRODUCT_MONTHLY,
    APPLE_PRODUCT_YEARLY,
)


# Apple offers no API for a server to cancel someone's subscription - only
# the subscriber can, from their Apple ID settings (the iOS app opens the same
# screen with StoreKit's manageSubscriptionsSheet).
MANAGE_SUBSCRIPTIONS_URL = "https://apps.apple.com/account/subscriptions"


def _require(*settings):
    missing = [name for name, value in settings if not value]
    if missing:
        raise HTTPException(503, f"Apple billing is not configured: set {', '.join(missing)}.")


def _require_api_settings():
    _require(
        ("APPLE_KEY_ID", APPLE_KEY_ID),
        ("APPLE_ISSUER_ID", APPLE_ISSUER_ID),
        ("APPLE_APP_ID", APPLE_APP_ID),
        ("APPLE_BUNDLE_ID", APPLE_BUNDLE_ID),
        ("APPLE_PRIVATE_KEY", APPLE_PRIVATE_KEY),
        ("APPLE_ENV", APPLE_ENV),
        ("APPLE_PRODUCT_MONTHLY", APPLE_PRODUCT_MONTHLY),
        ("APPLE_PRODUCT_YEARLY", APPLE_PRODUCT_YEARLY),
    )
    if APPLE_ENV not in ("sandbox", "production"):
        raise HTTPException(503, "Apple billing is not configured: APPLE_ENV must be sandbox or production.")


def _decode_jws(token, label="JWS"):
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
    except (AttributeError, IndexError, UnicodeDecodeError, ValueError, TypeError) as exc:
        raise HTTPException(400, f"Invalid Apple {label} payload.") from exc
    if not isinstance(decoded, dict):
        raise HTTPException(400, f"Invalid Apple {label} payload.")
    return decoded


def _client_jwt():
    now = int(time.time())
    return jwt.encode(
        {"iss": APPLE_ISSUER_ID, "iat": now, "exp": now + 20 * 60,
         "aud": "appstoreconnect-v1", "bid": APPLE_BUNDLE_ID},
        APPLE_PRIVATE_KEY.replace("\\n", "\n"), algorithm="ES256", headers={"kid": APPLE_KEY_ID},
    )


def _apple_get(path):
    """GET from the App Store Server API, authenticated as this app.

    What comes back is trusted: it arrived over TLS from Apple in answer to
    our own signed request. That is the only source subscription state is
    read from - never a JWS someone posted to us (see handle_webhook)."""
    _require_api_settings()
    host = "api.storekit-sandbox.itunes.apple.com" if APPLE_ENV == "sandbox" else "api.storekit.itunes.apple.com"
    request = Request(f"https://{host}{path}", headers={"Authorization": f"Bearer {_client_jwt()}"})
    try:
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(404, "Apple transaction was not found.") from exc
        raise HTTPException(502, "Apple App Store Server API request failed.") from exc
    except (URLError, UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(502, "Apple App Store Server API returned an invalid response.") from exc


def _fetch_transaction(transaction_id):
    """One transaction, as Apple has it (Get Transaction Info)."""
    payload = _apple_get(f"/inApps/v1/transactions/{transaction_id}")
    transaction = payload.get("signedTransactionInfo", payload.get("transactionInfo"))
    if isinstance(transaction, str):
        transaction = _decode_jws(transaction, "transaction")
    if not isinstance(transaction, dict):
        raise HTTPException(502, "Apple App Store Server API did not return transaction information.")
    return transaction


def _fetch_subscription(original_transaction_id):
    """The subscription's latest transaction and its renewal info, as Apple
    has them now (Get All Subscription Statuses).

    Transaction info alone can't say whether the subscriber turned
    auto-renew off - i.e. cancelled - so this is what both the iOS report and
    the webhook sync from."""
    payload = _apple_get(f"/inApps/v1/subscriptions/{original_transaction_id}")
    for group in payload.get("data") or []:
        for last in group.get("lastTransactions") or []:
            if last.get("originalTransactionId") != original_transaction_id:
                continue
            transaction = last.get("signedTransactionInfo")
            transaction = _decode_jws(transaction, "transaction") if isinstance(transaction, str) else None
            renewal = last.get("signedRenewalInfo")
            renewal = _decode_jws(renewal, "renewal") if isinstance(renewal, str) else None
            if transaction:
                return transaction, renewal
    raise HTTPException(404, "Apple transaction was not found.")


def _timestamp(value):
    if value is None:
        return None
    try:
        value = int(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "Apple transaction has an invalid timestamp.") from exc
    return value // 1000 if value > 10_000_000_000 else value


def _plan(transaction):
    product_id = transaction.get("productId")
    if product_id == APPLE_PRODUCT_MONTHLY:
        return "monthly"
    if product_id == APPLE_PRODUCT_YEARLY:
        return "yearly"
    raise HTTPException(400, "Apple transaction uses an unknown product.")


def _sync_transaction(user_id, transaction, renewal=None):
    _require_api_settings()
    original_transaction_id = transaction.get("originalTransactionId")
    if not original_transaction_id:
        raise HTTPException(400, "Apple transaction is missing originalTransactionId.")
    period_start = _timestamp(transaction.get("purchaseDate"))
    period_end = _timestamp(transaction.get("expiresDate"))
    auto_renew = transaction.get("autoRenewStatus")
    if auto_renew is None and renewal:
        auto_renew = renewal.get("autoRenewStatus")
    active = not transaction.get("revocationDate") and period_end and period_end > int(time.time())
    status = "expired" if not active else ("trialing" if transaction.get("offerType") in (1, "1") else "active")
    if not can_record_subscription(user_id, "apple", original_transaction_id):
        raise HTTPException(409, "This account already has an active subscription.")
    db.upsert_subscription(
        user_id, status, _plan(transaction), "apple", period_start, period_end,
        str(auto_renew) == "0", subscription_id=original_transaction_id,
        started_at=_timestamp(transaction.get("originalPurchaseDate")),
    )
    return db.get_subscription(user_id)


def record_transaction(user_id, signed_transaction):
    submitted = _decode_jws(signed_transaction, "transaction")
    transaction_id = submitted.get("transactionId")
    if not transaction_id:
        raise HTTPException(400, "Apple transaction is missing transactionId.")
    # The posted JWS isn't signature-checked here, so all it's trusted for is
    # the id to look up; Apple confirms the transaction exists, and the state
    # recorded is the subscription's current one, renewal status included.
    transaction = _fetch_transaction(transaction_id)
    if transaction.get("bundleId") != APPLE_BUNDLE_ID:
        raise HTTPException(400, "Apple transaction bundle ID does not match this app.")
    original_transaction_id = transaction.get("originalTransactionId")
    if not original_transaction_id:
        raise HTTPException(400, "Apple transaction is missing originalTransactionId.")
    latest, renewal = _fetch_subscription(original_transaction_id)
    return _sync_transaction(user_id, latest, renewal)


def _notification_original_transaction_id(data):
    transaction = data.get("signedTransactionInfo") or data.get("transactionInfo") or data.get("latestTransactionInfo")
    if isinstance(transaction, str):
        transaction = _decode_jws(transaction, "transaction")
    return transaction.get("originalTransactionId") if isinstance(transaction, dict) else None


def handle_webhook(payload):
    """App Store Server Notifications V2.

    The endpoint is public and the notification's JWS signature isn't
    verified, so nothing in it is believed: it only says which subscription
    to look at. Its current state - active, cancelled (auto-renew off),
    expired, refunded - is then read from Apple's API. A forged notification
    can at most make us re-read the truth.
    """
    _require(("APPLE_BUNDLE_ID", APPLE_BUNDLE_ID))
    try:
        token = payload.decode("utf-8") if isinstance(payload, bytes) else payload
    except UnicodeDecodeError as exc:
        raise HTTPException(400, "Invalid Apple notification payload.") from exc
    notification = _decode_jws(token, "notification")
    if notification.get("notificationType") not in (
            "DID_CHANGE_RENEWAL_STATUS", "EXPIRED", "REFUND", "RENEWAL", "DID_RENEW"):
        return {"received": True}
    data = notification.get("data")
    if not isinstance(data, dict):
        raise HTTPException(400, "Invalid Apple notification payload.")
    original_transaction_id = _notification_original_transaction_id(data)
    if not original_transaction_id:
        raise HTTPException(400, "Apple notification is missing transaction information.")
    subscription = db.get_subscription_by_platform_id("apple", original_transaction_id)
    if not subscription:
        raise HTTPException(404, "No subscription owner found for Apple transaction.")
    transaction, renewal = _fetch_subscription(original_transaction_id)
    if transaction.get("bundleId") != APPLE_BUNDLE_ID:
        raise HTTPException(400, "Apple notification bundle ID does not match this app.")
    _sync_transaction(subscription["user_id"], transaction, renewal)
    return {"received": True}


def cancel_subscription():
    """Apple subscriptions can't be cancelled from here (see
    MANAGE_SUBSCRIPTIONS_URL), so this answers where the subscriber can."""
    raise HTTPException(409, {
        "code": "manage_with_apple",
        "message": "This subscription was bought through Apple, so it's cancelled in your "
                   "Apple ID settings. Open Subscriptions there and choose Cancel Subscription.",
        "url": MANAGE_SUBSCRIPTIONS_URL,
    })
