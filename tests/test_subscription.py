import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

import auth
import db
import server
import stripe_billing


USER = "99999999-9999-4999-8999-999999999999"
GUEST = "88888888-8888-4888-8888-888888888888"
FREE_USER = "77777777-7777-4777-8777-777777777777"
ACTIVE_USER = "66666666-6666-4666-8666-666666666666"
STRIPE_USER = "55555555-5555-4555-8555-555555555555"


def stripe_subscription(user_id, status="active", price="price_monthly", **extra):
    return {
        "id": "sub_123",
        "status": status,
        "metadata": {"user_id": user_id},
        "items": {"data": [{"price": {"id": price}}]},
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

    def test_local_store_upserts_and_validates_subscription(self):
        db.upsert_subscription(USER, "trialing", "monthly", "stripe", 100, 200, False,
                               stripe_subscription_id="sub_123")
        subscription = db.get_subscription(USER)
        self.assertEqual(subscription["status"], "trialing")
        self.assertEqual(subscription["stripe_subscription_id"], "sub_123")
        self.assertIn("updated_at", subscription)
        with self.assertRaises(ValueError):
            db.upsert_subscription(USER, "unknown", "monthly", "stripe", 100, 200, False)

    def test_subscription_endpoint_defaults_to_free(self):
        response = self.client.get("/api/me/subscription", headers=self.headers(FREE_USER))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "tier": "free", "plan": None, "status": None,
            "current_period_end": None, "cancel_at_period_end": False,
            "platform": None,
        })

    def test_subscription_endpoint_returns_active_entitlement(self):
        db.upsert_subscription(ACTIVE_USER, "active", "yearly", "apple", 100, 200, True,
                               apple_original_transaction_id="original_123")
        response = self.client.get("/api/me/subscription", headers=self.headers(ACTIVE_USER))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "tier": "premium", "plan": "yearly", "status": "active",
            "current_period_end": 200, "cancel_at_period_end": True,
            "platform": "apple",
        })

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

    def test_stripe_checkout_creates_selected_plan_session(self):
        stripe, settings = self.stripe()
        stripe.checkout.Session.create.return_value = {"url": "https://checkout.stripe.test/session"}
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/subscriptions/stripe/checkout", json={
                "success_url": "https://site.test/success",
                "cancel_url": "https://site.test/cancel",
                "plan": "yearly",
            }, headers=self.headers(STRIPE_USER))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"checkout_url": "https://checkout.stripe.test/session"})
        stripe.checkout.Session.create.assert_called_once_with(
            mode="subscription",
            line_items=[{"price": "price_yearly", "quantity": 1}],
            success_url="https://site.test/success",
            cancel_url="https://site.test/cancel",
            client_reference_id=STRIPE_USER,
            metadata={"user_id": STRIPE_USER},
            subscription_data={"metadata": {"user_id": STRIPE_USER}},
        )

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
                    self.assertEqual(record["stripe_subscription_id"], "sub_123")

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
                               False, stripe_subscription_id="sub_123")
        stripe, settings = self.stripe()
        stripe.Subscription.modify.return_value = stripe_subscription(
            STRIPE_USER, cancel_at_period_end=True,
        )
        with settings, patch.object(stripe_billing, "stripe", stripe):
            response = self.client.post("/api/subscriptions/stripe/cancel", headers=self.headers(STRIPE_USER))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "active")
        self.assertTrue(response.json()["cancel_at_period_end"])
        stripe.Subscription.modify.assert_called_once_with("sub_123", cancel_at_period_end=True)


if __name__ == "__main__":
    unittest.main()
