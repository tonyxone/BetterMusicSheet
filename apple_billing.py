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


def _apple_url(transaction_id):
    host = "api.storekit-sandbox.itunes.apple.com" if APPLE_ENV == "sandbox" else "api.storekit.itunes.apple.com"
    return f"https://{host}/inApps/v1/transactions/{transaction_id}"


def _fetch_transaction(transaction_id):
    _require_api_settings()
    request = Request(_apple_url(transaction_id), headers={"Authorization": f"Bearer {_client_jwt()}"})
    try:
        with urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(404, "Apple transaction was not found.") from exc
        raise HTTPException(502, "Apple App Store Server API request failed.") from exc
    except (URLError, UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(502, "Apple App Store Server API returned an invalid response.") from exc
    transaction = payload.get("signedTransactionInfo", payload.get("transactionInfo"))
    if isinstance(transaction, str):
        transaction = _decode_jws(transaction, "transaction")
    if not isinstance(transaction, dict):
        raise HTTPException(502, "Apple App Store Server API did not return transaction information.")
    renewal = payload.get("signedRenewalInfo")
    if isinstance(renewal, str):
        renewal = _decode_jws(renewal, "renewal")
    return transaction, renewal if isinstance(renewal, dict) else None


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


def _sync_transaction(user_id, transaction, renewal=None, force_expired=False):
    _require_api_settings()
    original_transaction_id = transaction.get("originalTransactionId")
    if not original_transaction_id:
        raise HTTPException(400, "Apple transaction is missing originalTransactionId.")
    period_start = _timestamp(transaction.get("purchaseDate"))
    period_end = _timestamp(transaction.get("expiresDate"))
    auto_renew = transaction.get("autoRenewStatus")
    if auto_renew is None and renewal:
        auto_renew = renewal.get("autoRenewStatus")
    active = (not force_expired and not transaction.get("revocationDate") and period_end
              and period_end > int(time.time()))
    status = "expired" if not active else ("trialing" if transaction.get("offerType") in (1, "1") else "active")
    db.upsert_subscription(
        user_id, status, _plan(transaction), "apple", period_start, period_end,
        str(auto_renew) == "0", apple_original_transaction_id=original_transaction_id,
    )
    return db.get_subscription(user_id)


def record_transaction(user_id, signed_transaction):
    submitted = _decode_jws(signed_transaction, "transaction")
    transaction_id = submitted.get("transactionId")
    if not transaction_id:
        raise HTTPException(400, "Apple transaction is missing transactionId.")
    transaction, renewal = _fetch_transaction(transaction_id)
    if transaction.get("bundleId") != APPLE_BUNDLE_ID:
        raise HTTPException(400, "Apple transaction bundle ID does not match this app.")
    return _sync_transaction(user_id, transaction, renewal)


def _notification_transaction(data):
    transaction = data.get("latestTransactionInfo") or data.get("transactionInfo") or data.get("signedTransactionInfo")
    if isinstance(transaction, str):
        transaction = _decode_jws(transaction, "transaction")
    renewal = data.get("signedRenewalInfo")
    if isinstance(renewal, str):
        renewal = _decode_jws(renewal, "renewal")
    return transaction if isinstance(transaction, dict) else None, renewal if isinstance(renewal, dict) else None


def handle_webhook(payload):
    _require(("APPLE_BUNDLE_ID", APPLE_BUNDLE_ID))
    try:
        token = payload.decode("utf-8") if isinstance(payload, bytes) else payload
    except UnicodeDecodeError as exc:
        raise HTTPException(400, "Invalid Apple notification payload.") from exc
    notification = _decode_jws(token, "notification")
    notification_type = notification.get("notificationType")
    if notification_type not in ("DID_CHANGE_RENEWAL_STATUS", "EXPIRED", "REFUND", "RENEWAL", "DID_RENEW"):
        return {"received": True}
    data = notification.get("data")
    if not isinstance(data, dict):
        raise HTTPException(400, "Invalid Apple notification payload.")
    transaction, renewal = _notification_transaction(data)
    bundle_id = data.get("bundleId") or (transaction or {}).get("bundleId")
    if bundle_id != APPLE_BUNDLE_ID:
        raise HTTPException(400, "Apple notification bundle ID does not match this app.")
    if not transaction or not transaction.get("expiresDate"):
        transaction_id = (transaction or {}).get("transactionId")
        if not transaction_id:
            raise HTTPException(400, "Apple notification is missing transaction information.")
        transaction, fetched_renewal = _fetch_transaction(transaction_id)
        renewal = renewal or fetched_renewal
    original_transaction_id = transaction.get("originalTransactionId")
    subscription = db.get_subscription_by_apple_original_transaction_id(original_transaction_id)
    if not subscription:
        raise HTTPException(404, "No subscription owner found for Apple transaction.")
    _sync_transaction(subscription["user_id"], transaction, renewal,
                      force_expired=notification_type in ("EXPIRED", "REFUND"))
    return {"received": True}
