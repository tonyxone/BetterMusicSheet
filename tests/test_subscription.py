import base64
import json
import unittest
from unittest.mock import MagicMock, Mock, patch
from urllib.error import HTTPError

import stripe
from fastapi import HTTPException
from fastapi.testclient import TestClient

import auth
import db
import server
import apple_billing
import stripe_billing


USER = "99999999-9999-4999-8999-999999999999"
GUEST = "88888888-8888-4888-8888-888888888888"
FREE_USER = "77777777-7777-4777-8777-777777777777"
ACTIVE_USER = "66666666-6666-4666-8666-666666666666"
STRIPE_USER = "55555555-5555-4555-8555-555555555555"
APPLE_USER = "44444444-4444-4444-8444-444444444444"
FIRST_TIME_USER = "33333333-3333-4333-8333-333333333333"
REJOINING_USER = "22222222-2222-4222-8222-222222222222"
CROSS_USER = "11111111-1111-4111-8111-111111111111"
MASTER_USER = "00000000-0000-4000-8000-000000000000"


def apple_jws(payload):
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return f"header.{encoded}.signature"


def apple_transaction(transaction_id="transaction_123", **extra):
    return {
        "transactionId": transaction_id,
        "appAccountToken": APPLE_USER,
        "originalTransactionId": "original_apple_123",
        "bundleId": "com.test.music",
        "productId": "apple_monthly",
        "purchaseDate": 1_700_000_000_000,
        "expiresDate": 2_000_000_000_000,
        **extra,
    }


def stripe_subscription(user_id, status="active", price="price_monthly", **extra):
    return {
        "id": "sub_123",
        "status": status,
        "metadata": {"user_id": user_id},
        "items": {"data": [{"price": {"id": price}}]},
        "start_date": 90,
        "current_period_start": 100,
        "current_period_end": 2_000_000_000,
        "cancel_at_period_end": False,
        **extra,
    }


class SubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)

    def tearDown(self):
        self.client.close()

    def headers(self, user_id=USER):
        return {"Authorization": f"Bearer {auth.mint_backend_token(user_id)}"}

    def stripe(self):
        stripe = Mock()
        settings = patch.multiple(
            stripe_billing,
            STRIPE_SECRET_KEY="sk_test",
            STRIPE_WEBHOOK_SECRET="whsec_test",
            STRIPE_PRICE_MONTHLY="price_monthly",
            STRIPE_PRICE_YEARLY="price_yearly",
        )
        return stripe, settings

    def apple(self):
        settings = patch.multiple(
            apple_billing,
            APPLE_KEY_ID="key_123",
            APPLE_ISSUER_ID="issuer_123",
            APPLE_APP_ID="123456789",
            APPLE_BUNDLE_ID="com.test.music",
            APPLE_PRIVATE_KEY="test-private-key",
            APPLE_ENV="sandbox",
            APPLE_PRODUCT_MONTHLY="apple_monthly",
            APPLE_PRODUCT_YEARLY="apple_yearly",
        )
        return settings

    def apple_api(self, transaction, renewal=None):
        """A urlopen stand-in for the two App Store Server API endpoints used:
        Get Transaction Info, and Get All Subscription Statuses (the latest
        transaction plus its renewal info)."""
        def respond(request, timeout=None):
            if "/inApps/v1/subscriptions/" in request.full_url:
                last = {"originalTransactionId": transaction["originalTransactionId"], "status": transaction.get("_appleStatus", 1),
                        "signedTransactionInfo": apple_jws(transaction)}
                if renewal is not None:
                    last["signedRenewalInfo"] = apple_jws(renewal)
                payload = {"data": [{"subscriptionGroupIdentifier": "group", "lastTransactions": [last]}]}
            else:
                payload = {"signedTransactionInfo": apple_jws(transaction)}
            response = MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps(payload).encode()
            return response
        return respond

    def test_local_store_upserts_and_validates_subscription(self):
        db.upsert_subscription(USER, "trialing", "monthly", "stripe", 100, 200, False,
                               subscription_id="sub_123")
        subscription = db.get_subscription(USER)
        self.assertEqual(subscription["status"], "trialing")
        self.assertEqual(subscription["subscription_id"], "sub_123")
        self.assertIn("updated_at", subscription)
        with self.assertRaises(ValueError):
            db.upsert_subscription(USER, "unknown", "monthly", "stripe", 100, 200, False)

    def test_subscription_endpoint_defaults_to_free(self):
        response = self.client.get("/api/me/subscription", headers=self.headers(FREE_USER))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "tier": "free", "plan": None, "status": None, "started_at": None,
            "current_period_end": None, "cancel_at_period_end": False,
            "platform": None, "trial_eligible": True, "master": False,
        })

    def test_subscription_endpoint_returns_active_entitlement(self):
        # Cancelling, but the paid period hasn't ended yet - still premium.
        db.upsert_subscription(ACTIVE_USER, "active", "yearly", "apple", 100, 2_000_000_000, True,
                               subscription_id="original_123")
        response = self.client.get("/api/me/subscription", headers=self.headers(ACTIVE_USER))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "tier": "premium", "plan": "yearly", "status": "active", "started_at": None,
            "current_period_end": 2_000_000_000, "cancel_at_period_end": True,
            "platform": "apple", "trial_eligible": False, "master": False,
        })

    def test_scheduled_cancellation_is_free_once_its_period_has_ended(self):
        # No webhook has marked it expired yet, but the paid period is over.
        db.upsert_subscription(ACTIVE_USER, "active", "monthly", "stripe", 100, 200, True,
                               subscription_id="sub_ended")
        self.assertEqual(auth.get_entitlement(ACTIVE_USER)["tier"], "free")

    def test_guests_are_free_and_premium_dependency_has_machine_code(self):
        db.upsert_subscription(GUEST, "active", "monthly", "stripe", 100, 200, False)
        self.assertEqual(auth.get_entitlement(GUEST, is_guest=True)["tier"], "free")
        with self.assertRaises(HTTPException) as error:
            auth.require_premium(authorization=None, x_guest_id=GUEST)
        self.assertEqual(error.exception.status_code, 403)
        self.assertEqual(error.exception.detail, {"code": "premium_required", "tier": "free"})

    def test_trialing_passes_premium_dependency(self):
        db.upsert_subscription(USER, "trialing", "monthly", "stripe", 100, 200, False)
        self.assertEqual(auth.require_premium(authorization=self.headers()["Authorization"]), USER)

    def test_master_user_is_premium_without_a_subscription(self):
        db.add_master_user(MASTER_USER)
        self.addCleanup(db.remove_master_user, MASTER_USER)
        response = self.client.get("/api/me/subscription", headers=self.headers(MASTER_USER))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "tier": "premium", "plan": None, "status": None, "started_at": None,
            "current_period_end": None, "cancel_at_period_end": False,
            "platform": None, "trial_eligible": True, "master": True,
        })
        self.assertEqual(auth.require_premium(authorization=self.headers(MASTER_USER)["Authorization"]), MASTER_USER)

    def test_master_user_keeps_its_own_subscription_fields(self):
        db.add_master_user(MASTER_USER)
        self.addCleanup(db.remove_master_user, MASTER_USER)
        db.upsert_subscription(MASTER_USER, "active", "yearly", "stripe", 100, 2_000_000_000, False,
                               subscription_id="sub_master")
        self.addCleanup(db._subscriptions.pop, MASTER_USER, None)
        entitlement = auth.get_entitlement(MASTER_USER)
        self.assertEqual((entitlement["tier"], entitlement["platform"], entitlement["master"]),
                         ("premium", "stripe", True))

    def test_master_status_is_not_a_subscription(self):
        # Billing checks still see no subscription: nothing to cancel, and a
        # real subscription may still be recorded.
        db.add_master_user(MASTER_USER)
        self.addCleanup(db.remove_master_user, MASTER_USER)
        self.assertFalse(auth.has_active_subscription(MASTER_USER))
        response = self.client.post("/api/subscriptions/cancel", json={"platform": "stripe"},
                                    headers=self.headers(MASTER_USER))
        self.assertEqual(response.status_code, 404)

    def test_removing_a_master_user_revokes_the_bypass(self):
        db.add_master_user(MASTER_USER)
        db.remove_master_user(MASTER_USER)
        self.assertEqual(auth.get_entitlement(MASTER_USER)["tier"], "free")

    def test_a_guest_id_is_never_a_master_user(self):
        db.add_master_user(GUEST)
        self.addCleanup(db.remove_master_user, GUEST)
        self.assertEqual(auth.get_entitlement(GUEST, is_guest=True)["tier"], "free")

    def checkout(self, user_id):
        stripe, settings = self.stripe()
        stripe.checkout.Session.create.return_value = {"url": "https://checkout.stripe.test/session"}
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/subscriptions/stripe/checkout", json={
                "success_url": "https://site.test/success",
                "cancel_url": "https://site.test/cancel",
                "plan": "yearly",
            }, headers=self.headers(user_id))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"checkout_url": "https://checkout.stripe.test/session"})
        return stripe.checkout.Session.create

    def test_stripe_checkout_gives_a_first_time_subscriber_the_trial(self):
        self.checkout(FIRST_TIME_USER).assert_called_once_with(
            mode="subscription",
            line_items=[{"price": "price_yearly", "quantity": 1}],
            success_url="https://site.test/success",
            cancel_url="https://site.test/cancel",
            client_reference_id=FIRST_TIME_USER,
            metadata={"user_id": FIRST_TIME_USER},
            subscription_data={"metadata": {"user_id": FIRST_TIME_USER}, "trial_period_days": 7},
        )

    def test_stripe_checkout_bills_a_rejoining_subscriber_without_a_trial(self):
        # Any earlier subscription - here one that already expired - uses up
        # the trial, and the endpoint tells the paywall so it can say so.
        db.upsert_subscription(REJOINING_USER, "expired", "monthly", "stripe", 100, 200, False,
                               subscription_id="sub_old")
        response = self.client.get("/api/me/subscription", headers=self.headers(REJOINING_USER))
        self.assertEqual(response.json()["tier"], "free")
        self.assertFalse(response.json()["trial_eligible"])
        create = self.checkout(REJOINING_USER)
        self.assertEqual(create.call_args.kwargs["subscription_data"], {"metadata": {"user_id": REJOINING_USER}})

    def test_stripe_checkout_failure_reaches_the_visitor_as_a_plain_message(self):
        # Reproduces a misconfigured price id (STRIPE_PRICE_MONTHLY/YEARLY set
        # to a Payment Link id instead of a Price id): Stripe rejects the
        # session, and that must not reach the browser as a bare 500 with a
        # server-log-flavored detail (see server.py's json_errors and
        # stripe_billing.create_checkout).
        mocked, settings = self.stripe()
        mocked.checkout.Session.create.side_effect = stripe.error.InvalidRequestError(
            "No such price: 'plink_bad'", param="line_items[0][price]",
        )
        with settings, patch.object(stripe_billing, "stripe", mocked):
            response = self.client.post("/api/subscriptions/stripe/checkout", json={
                "success_url": "https://site.test/success",
                "cancel_url": "https://site.test/cancel",
                "plan": "monthly",
            }, headers=self.headers(FREE_USER))
        self.assertEqual(response.status_code, 502)
        detail = response.json()["detail"]
        self.assertNotIn("plink_bad", detail)
        self.assertNotIn("Traceback", detail)
        self.assertIn("try again", detail)

    def test_stripe_confirm_syncs_entitlement_from_a_completed_session(self):
        # This is what the success page calls right after Stripe redirects
        # back with ?session_id=... - it must not depend on the webhook,
        # which has nowhere reachable to reach in local dev.
        stripe, settings = self.stripe()
        stripe.checkout.Session.retrieve.return_value = {
            "client_reference_id": STRIPE_USER,
            "subscription": stripe_subscription(STRIPE_USER, "active", "price_yearly"),
        }
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/subscriptions/stripe/confirm",
                json={"session_id": "cs_test_123"}, headers=self.headers(STRIPE_USER))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {
            "tier": "premium", "plan": "yearly", "status": "active", "started_at": 90,
            "current_period_end": 2_000_000_000, "cancel_at_period_end": False,
            "platform": "stripe", "master": False,
        })
        stripe.checkout.Session.retrieve.assert_called_once_with("cs_test_123", expand=["subscription"])

    def test_stripe_confirm_rejects_a_different_accounts_session(self):
        stripe, settings = self.stripe()
        stripe.checkout.Session.retrieve.return_value = {
            "client_reference_id": "someone-else",
            "subscription": stripe_subscription(STRIPE_USER),
        }
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/subscriptions/stripe/confirm",
                json={"session_id": "cs_test_123"}, headers=self.headers(STRIPE_USER))
        self.assertEqual(response.status_code, 403)

    def test_stripe_confirm_treats_an_incomplete_checkout_as_not_ready(self):
        stripe, settings = self.stripe()
        stripe.checkout.Session.retrieve.return_value = {
            "client_reference_id": STRIPE_USER, "subscription": None,
        }
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/subscriptions/stripe/confirm",
                json={"session_id": "cs_test_123"}, headers=self.headers(STRIPE_USER))
        self.assertEqual(response.status_code, 409)

    def test_stripe_plan_switch_moves_an_existing_subscription(self):
        db.upsert_subscription(STRIPE_USER, "active", "monthly", "stripe", 100, 2_000_000_000,
                               False, subscription_id="sub_123")
        stripe, settings = self.stripe()
        stripe.Subscription.retrieve.return_value = {
            "items": {"data": [{"id": "si_123", "price": {"id": "price_monthly"}}]},
        }
        stripe.Subscription.modify.return_value = stripe_subscription(STRIPE_USER, "active", "price_yearly")
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/subscriptions/stripe/plan",
                json={"plan": "yearly"}, headers=self.headers(STRIPE_USER))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["plan"], "yearly")
        stripe.Subscription.modify.assert_called_once_with(
            "sub_123", items=[{"id": "si_123", "price": "price_yearly"}],
            proration_behavior="create_prorations",
        )

    def test_stripe_plan_switch_requires_an_existing_stripe_subscription(self):
        response = self.client.post("/api/subscriptions/stripe/plan",
            json={"plan": "yearly"}, headers=self.headers(FREE_USER))
        self.assertEqual(response.status_code, 404)

    def test_stripe_plan_switch_rejects_the_plan_already_in_use(self):
        db.upsert_subscription(STRIPE_USER, "active", "monthly", "stripe", 100, 2_000_000_000,
                               False, subscription_id="sub_123")
        settings = patch.multiple(
            stripe_billing, STRIPE_PRICE_MONTHLY="price_monthly", STRIPE_PRICE_YEARLY="price_yearly",
        )
        with settings:
            response = self.client.post("/api/subscriptions/stripe/plan",
                json={"plan": "monthly"}, headers=self.headers(STRIPE_USER))
        self.assertEqual(response.status_code, 409)

    def test_stripe_cancel_failure_reaches_the_visitor_as_a_plain_message(self):
        db.upsert_subscription(STRIPE_USER, "active", "monthly", "stripe", 100, 2_000_000_000,
                               False, subscription_id="sub_123")
        mocked, settings = self.stripe()
        mocked.Subscription.modify.side_effect = stripe.error.APIConnectionError("Could not reach Stripe")
        with settings, patch.object(stripe_billing, "stripe", mocked):
            response = self.client.post("/api/subscriptions/cancel", json={"platform": "stripe"}, headers=self.headers(STRIPE_USER))
        self.assertEqual(response.status_code, 502)
        self.assertIn("try again", response.json()["detail"])

    def test_stripe_webhook_maps_created_updated_and_deleted_subscriptions(self):
        stripe, settings = self.stripe()
        with settings, patch.object(stripe_billing, "stripe", stripe):
            cases = [
                ("customer.subscription.created", stripe_subscription(STRIPE_USER, "trialing"), "trialing", "monthly"),
                ("customer.subscription.updated", stripe_subscription(STRIPE_USER, "active", "price_yearly"), "active", "yearly"),
                ("customer.subscription.deleted", stripe_subscription(STRIPE_USER, "canceled"), "expired", "monthly"),
            ]
            for event_type, subscription, status, plan in cases:
                with self.subTest(event_type=event_type):
                    stripe.Webhook.construct_event.return_value = {
                        "type": event_type, "data": {"object": subscription},
                    }
                    response = self.client.post("/api/webhooks/stripe", content=b"{}", headers={
                        "stripe-signature": "test-signature",
                    })
                    self.assertEqual(response.status_code, 200, response.text)
                    record = db.get_subscription(STRIPE_USER)
                    self.assertEqual(record["status"], status)
                    self.assertEqual(record["plan"], plan)
                    self.assertEqual(record["platform"], "stripe")
                    self.assertEqual(record["subscription_id"], "sub_123")

    def test_stripe_webhook_reads_billing_period_from_item_on_newer_api_versions(self):
        # API 2025-03-31+ (the webhook endpoint's version) drops the period
        # from the subscription and carries it on each item instead. A renewal
        # arrives as customer.subscription.updated with the next period.
        stripe, settings = self.stripe()
        with settings, patch.object(stripe_billing, "stripe", stripe):
            for start, end in ((100, 2_000_000_000), (2_000_000_000, 2_002_592_000)):
                with self.subTest(end=end):
                    subscription = stripe_subscription(STRIPE_USER, items={"data": [{
                        "price": {"id": "price_monthly"},
                        "current_period_start": start, "current_period_end": end,
                    }]})
                    del subscription["current_period_start"], subscription["current_period_end"]
                    stripe.Webhook.construct_event.return_value = {
                        "type": "customer.subscription.updated", "data": {"object": subscription},
                    }
                    response = self.client.post("/api/webhooks/stripe", content=b"{}", headers={
                        "stripe-signature": "test-signature",
                    })
                    self.assertEqual(response.status_code, 200, response.text)
                    record = db.get_subscription(STRIPE_USER)
                    self.assertEqual(record["current_period_start"], start)
                    self.assertEqual(record["current_period_end"], end)

    def test_stripe_webhook_maps_payment_failure_from_retrieved_subscription(self):
        stripe, settings = self.stripe()
        stripe.Subscription.retrieve.return_value = stripe_subscription(STRIPE_USER, "past_due")
        stripe.Webhook.construct_event.return_value = {
            "type": "invoice.payment_failed", "data": {"object": {"subscription": "sub_123"}},
        }
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/webhooks/stripe", content=b"{}", headers={
                "stripe-signature": "test-signature",
            })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(db.get_subscription(STRIPE_USER)["status"], "past_due")
        stripe.Subscription.retrieve.assert_called_once_with("sub_123")

    def test_stripe_cancel_marks_subscription_for_period_end(self):
        db.upsert_subscription(STRIPE_USER, "active", "monthly", "stripe", 100, 2_000_000_000,
                               False, subscription_id="sub_123")
        stripe, settings = self.stripe()
        stripe.Subscription.modify.return_value = stripe_subscription(
            STRIPE_USER, cancel_at_period_end=True,
        )
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/subscriptions/cancel", json={"platform": "stripe"}, headers=self.headers(STRIPE_USER))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "active")
        self.assertTrue(response.json()["cancel_at_period_end"])
        stripe.Subscription.modify.assert_called_once_with("sub_123", cancel_at_period_end=True)

    # ---- one subscription, either store ----

    def test_an_apple_subscription_is_refused_a_second_stripe_checkout(self):
        db.upsert_subscription(CROSS_USER, "active", "monthly", "apple", 100, 2_000_000_000, False,
                               subscription_id="original_cross")
        stripe, settings = self.stripe()
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/subscriptions/stripe/checkout", json={
                "success_url": "https://site.test/success",
                "cancel_url": "https://site.test/cancel",
                "plan": "monthly",
            }, headers=self.headers(CROSS_USER))
        self.assertEqual(response.status_code, 409)
        stripe.checkout.Session.create.assert_not_called()

    def test_a_lapsed_stripe_subscription_cannot_overwrite_an_active_apple_one(self):
        # Re-subscribed on iOS; the old Stripe subscription's deletion arrives later.
        db.upsert_subscription(CROSS_USER, "active", "monthly", "apple", 100, 2_000_000_000, False,
                               subscription_id="original_cross")
        stripe, settings = self.stripe()
        stripe.Webhook.construct_event.return_value = {
            "type": "customer.subscription.deleted",
            "data": {"object": stripe_subscription(CROSS_USER, "canceled", id="sub_old")},
        }
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/webhooks/stripe", content=b"{}", headers={
                "stripe-signature": "test-signature",
            })
        self.assertEqual(response.status_code, 200, response.text)
        record = db.get_subscription(CROSS_USER)
        self.assertEqual((record["platform"], record["subscription_id"], record["status"]),
                         ("apple", "original_cross", "active"))

    def test_moving_stores_is_allowed_once_the_old_subscription_is_inactive(self):
        db.upsert_subscription(CROSS_USER, "expired", "monthly", "stripe", 100, 200, False,
                               subscription_id="sub_old")
        self.assertTrue(auth.can_record_subscription(CROSS_USER, "apple", "original_new"))
        db.upsert_subscription(CROSS_USER, "active", "monthly", "stripe", 100, 2_000_000_000, False,
                               subscription_id="sub_old")
        self.assertFalse(auth.can_record_subscription(CROSS_USER, "apple", "original_new"))
        self.assertTrue(auth.can_record_subscription(CROSS_USER, "stripe", "sub_old"))

    def test_cancelling_an_apple_subscription_points_to_apple(self):
        db.upsert_subscription(CROSS_USER, "active", "yearly", "apple", 100, 2_000_000_000, False,
                               subscription_id="original_cross")
        response = self.client.post("/api/subscriptions/cancel", json={"platform": "apple"},
                                    headers=self.headers(CROSS_USER))
        self.assertEqual(response.status_code, 409)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "manage_with_apple")
        self.assertEqual(detail["url"], apple_billing.MANAGE_SUBSCRIPTIONS_URL)
        self.assertFalse(db.get_subscription(CROSS_USER)["cancel_at_period_end"])

    def test_cancel_refuses_a_platform_that_does_not_match_the_record(self):
        db.upsert_subscription(CROSS_USER, "active", "monthly", "apple", 100, 2_000_000_000, False,
                               subscription_id="original_cross")
        stripe, settings = self.stripe()
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/subscriptions/cancel", json={"platform": "stripe"},
                                        headers=self.headers(CROSS_USER))
        self.assertEqual(response.status_code, 409)
        stripe.Subscription.modify.assert_not_called()

    def test_cancel_without_an_active_subscription_is_not_found(self):
        response = self.client.post("/api/subscriptions/cancel", json={"platform": "stripe"},
                                    headers=self.headers(FREE_USER))
        self.assertEqual(response.status_code, 404)

    def test_apple_transaction_maps_active_trial_and_expired_entitlements(self):
        cases = [
            (apple_transaction("active_transaction"), "active"),
            (apple_transaction("trial_transaction", offerType=1), "trialing"),
            (apple_transaction("expired_transaction", expiresDate=1_000_000_000_000), "expired"),
        ]
        for transaction, status in cases:
            with self.subTest(status=status):
                headers = self.headers(APPLE_USER)
                with self.apple(), patch.object(apple_billing.jwt, "encode", return_value="client-jwt") as encode, \
                        patch.object(apple_billing, "urlopen",
                                     side_effect=self.apple_api(transaction, {"autoRenewStatus": 0})) as urlopen:
                    response = self.client.post("/api/subscriptions/apple/transaction", json={
                        "transaction": apple_jws({"transactionId": transaction["transactionId"]}),
                    }, headers=headers)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["tier"], "premium" if status != "expired" else "free")
                self.assertEqual(response.json()["platform"], "apple" if status != "expired" else None)
                record = db.get_subscription(APPLE_USER)
                self.assertEqual(record["status"], status)
                self.assertEqual(record["plan"], "monthly")
                self.assertEqual(record["current_period_start"], 1_700_000_000)
                self.assertEqual(record["current_period_end"], transaction["expiresDate"] // 1000)
                self.assertTrue(record["cancel_at_period_end"])
                # The transaction itself, then the subscription's current state.
                self.assertEqual(encode.call_count, 2)
                self.assertEqual(urlopen.call_count, 2)

    def test_apple_transaction_rejects_unknown_product_and_apple_404(self):
        unknown = apple_transaction(productId="unknown_product")
        headers = self.headers(APPLE_USER)
        with self.apple(), patch.object(apple_billing.jwt, "encode", return_value="client-jwt"), \
                patch.object(apple_billing, "urlopen", side_effect=self.apple_api(unknown)):
            response = self.client.post("/api/subscriptions/apple/transaction", json={
                "transaction": apple_jws({"transactionId": "transaction_123"}),
            }, headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertIn("unknown product", response.json()["detail"])

        missing = HTTPError("https://apple.test", 404, "not found", {}, None)
        headers = self.headers(APPLE_USER)
        with self.apple(), patch.object(apple_billing.jwt, "encode", return_value="client-jwt"), \
                patch.object(apple_billing, "urlopen", side_effect=missing):
            response = self.client.post("/api/subscriptions/apple/transaction", json={
                "transaction": apple_jws({"transactionId": "missing_transaction"}),
            }, headers=headers)
        self.assertEqual(response.status_code, 404)
        self.assertIn("not found", response.json()["detail"])

    def notify(self, notification_type, claimed_transaction, apple_says, renewal=None):
        """Post a notification about `claimed_transaction` while Apple's API
        reports `apple_says` for that subscription."""
        notification = {
            "notificationType": notification_type,
            "data": {"bundleId": "com.test.music", "signedTransactionInfo": apple_jws(claimed_transaction)},
        }
        with self.apple(), patch.object(apple_billing.jwt, "encode", return_value="client-jwt"), \
                patch.object(apple_billing, "urlopen", side_effect=self.apple_api(apple_says, renewal)) as urlopen:
            response = self.client.post("/api/webhooks/apple", json={"signedPayload": apple_jws(notification)})
        return response, urlopen

    def test_apple_webhook_maps_renewal_status_expired_refund_and_renewal(self):
        cases = [
            ("DID_CHANGE_RENEWAL_STATUS", apple_transaction(), {"autoRenewStatus": 0}, "active", True),
            ("EXPIRED", apple_transaction(expiresDate=1_000_000_000_000), {"autoRenewStatus": 0}, "expired", True),
            ("REFUND", apple_transaction(revocationDate=1_750_000_000_000), None, "expired", False),
            ("RENEWAL", apple_transaction(), {"autoRenewStatus": 1}, "active", False),
            ("DID_RENEW", apple_transaction(), {"autoRenewStatus": 1}, "active", False),
        ]
        for notification_type, apple_says, renewal, status, cancelling in cases:
            with self.subTest(notification_type=notification_type):
                db.upsert_subscription(APPLE_USER, "active", "monthly", "apple", 100, 200, False,
                                       subscription_id=apple_says["originalTransactionId"])
                response, urlopen = self.notify(notification_type, apple_says, apple_says, renewal)
                self.assertEqual(response.status_code, 200, response.text)
                record = db.get_subscription(APPLE_USER)
                self.assertEqual(record["status"], status)
                self.assertEqual(record["platform"], "apple")
                self.assertEqual(record["cancel_at_period_end"], cancelling)
                self.assertIn("/inApps/v1/subscriptions/original_apple_123", urlopen.call_args.args[0].full_url)

    def test_a_forged_apple_notification_cannot_change_the_subscription(self):
        # The notification claims the subscription was refunded and expired;
        # Apple says it's active and renewing, and that's what is recorded.
        truth = apple_transaction()
        db.upsert_subscription(APPLE_USER, "active", "monthly", "apple", 100, 2_000_000_000, False,
                               subscription_id=truth["originalTransactionId"])
        forged = apple_transaction(expiresDate=1_000_000_000_000, revocationDate=1_000_000_000_000)
        response, _ = self.notify("REFUND", forged, truth, {"autoRenewStatus": 1})
        self.assertEqual(response.status_code, 200, response.text)
        record = db.get_subscription(APPLE_USER)
        self.assertEqual((record["status"], record["current_period_end"]), ("active", 2_000_000_000))

    def test_apple_notification_for_an_unknown_subscription_is_not_found(self):
        stranger = apple_transaction(originalTransactionId="original_nobody")
        response, urlopen = self.notify("DID_RENEW", stranger, stranger)
        self.assertEqual(response.status_code, 404)
        urlopen.assert_not_called()

    def test_apple_purchase_cannot_be_claimed_by_a_different_account(self):
        headers = self.headers(FIRST_TIME_USER)
        with self.apple(), patch.object(apple_billing.jwt, "encode", return_value="client-jwt"), \
                patch.object(apple_billing, "urlopen", side_effect=self.apple_api(apple_transaction())):
            response = self.client.post("/api/subscriptions/apple/transaction", json={
                "transaction": apple_jws({"transactionId": "transaction_123"}),
            }, headers=headers)
        self.assertEqual(response.status_code, 409)

    def test_unbound_apple_purchase_cannot_be_claimed_by_knowing_its_id(self):
        transaction = apple_transaction(originalTransactionId="unowned_legacy", appAccountToken=None)
        headers = self.headers(APPLE_USER)
        with self.apple(), patch.object(apple_billing.jwt, "encode", return_value="client-jwt"), \
                patch.object(apple_billing, "urlopen", side_effect=self.apple_api(transaction)):
            response = self.client.post("/api/subscriptions/apple/transaction", json={
                "transaction": apple_jws({"transactionId": "transaction_123"}),
            }, headers=headers)
        self.assertEqual(response.status_code, 409)

    def test_real_v2_test_notification_and_malformed_envelopes(self):
        with self.apple():
            response = self.client.post("/api/webhooks/apple", json={
                "signedPayload": apple_jws({"notificationType": "TEST"}),
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.client.post("/api/webhooks/apple", json={}).status_code, 400)
            self.assertEqual(self.client.post("/api/webhooks/apple", content="not JSON").status_code, 400)

    def test_grace_period_retains_access_but_billing_retry_does_not(self):
        for status, expected in ((4, "active"), (3, "expired")):
            with self.subTest(status=status):
                transaction = apple_transaction(expiresDate=1_000_000_000_000, _appleStatus=status)
                db.upsert_subscription(APPLE_USER, "active", "monthly", "apple", 100, 200, False,
                                       subscription_id=transaction["originalTransactionId"])
                response, _ = self.notify("DID_FAIL_TO_RENEW", transaction, transaction,
                                          {"gracePeriodExpiresDate": 2_000_000_000_000})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(db.get_subscription(APPLE_USER)["status"], expected)

    def test_auto_environment_falls_back_to_sandbox_only_on_not_found(self):
        not_found = HTTPError("https://apple.test", 404, "not found", {}, None)
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        with self.apple(), patch.object(apple_billing, "APPLE_ENV", "auto"), \
                patch.object(apple_billing.jwt, "encode", return_value="client-jwt"), \
                patch.object(apple_billing, "urlopen", side_effect=[not_found, response]) as request:
            self.assertEqual(apple_billing._apple_get("/test"), {"ok": True})
            self.assertIn("api.storekit.itunes.apple.com", request.call_args_list[0].args[0].full_url)
            self.assertIn("api.storekit-sandbox.itunes.apple.com", request.call_args_list[1].args[0].full_url)


if __name__ == "__main__":
    unittest.main()
