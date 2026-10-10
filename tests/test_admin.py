"""The admin dashboard's API (admin.py), in local (in-memory) mode.

The part that matters most is the first test class: to anyone but an admin,
every admin route must look exactly like a route that doesn't exist.
"""
import importlib
import sys
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import apple_billing
import auth
import config
import db
import server

ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
GUEST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
SUBSCRIBER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

ROUTES = ["/api/admin/me", "/api/admin/overview", "/api/admin/users", f"/api/admin/users/{MEMBER}/uploads",
          "/api/admin/uploads", "/api/admin/uploads?status=failed", "/api/admin/subscriptions", "/api/admin/system",
          "/api/admin/uploads/member-done/files", "/api/admin/uploads/member-done/file/input"]


def token(user_id):
    return {"Authorization": f"Bearer {auth.mint_backend_token(user_id)}"}


def add_job(test, job_id, user_id, status, created_at, **fields):
    db._annotation_jobs[job_id] = {
        "job_id": job_id, "user_id": user_id, "music_sheet_id": job_id, "sheet_name": f"{job_id}.pdf",
        "status": status, "error": None, "stage": None, "created_at": created_at,
        "updated_at": created_at + 60, "queued_at": created_at, "storage_version": 2, **fields}
    db._music_sheets[job_id] = {"music_sheet_id": job_id, "user_id": user_id,
                                "sheet_name": f"{job_id}.pdf", "created_at": created_at}


def isolate(test):
    """Other test files share db's in-memory store; start each test empty."""
    for store in (db._users, db._subscriptions, db._music_sheets, db._annotation_jobs):
        patcher = patch.dict(store, clear=True)
        patcher.start()
        test.addCleanup(patcher.stop)


class AdminTestCase(unittest.TestCase):
    def setUp(self):
        isolate(self)
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)
        now = int(time.time())
        db.add_admin(ADMIN)
        self.addCleanup(db._admins.discard, ADMIN)
        for user_id, email, created_at in ((ADMIN, "me@example.com", now - 90 * 86400),
                                           (MEMBER, "member@example.com", now - 3 * 86400),
                                           (SUBSCRIBER, "sub@example.com", now - 40 * 86400)):
            db._users[user_id] = {"user_id": user_id, "email": email, "display_name": None, "created_at": created_at}
        add_job(self, "member-done", MEMBER, "done", now - 2 * 86400)
        add_job(self, "member-rough", MEMBER, "done", now - 86400, review_reasons=["5 of 10 measures have recognition warnings"])
        add_job(self, "member-failed", MEMBER, "failed", now - 3600, error="No music notation was detected")
        add_job(self, "member-deleted", MEMBER, "deleted", now - 5 * 86400)
        add_job(self, "guest-done", GUEST, "done", now - 86400)
        add_job(self, "demo", config.DEMO_OWNER_ID, "done", now - 86400)
        self.now = now


class HiddenFromEveryoneElseTests(AdminTestCase):
    def test_every_route_looks_missing_to_non_admins(self):
        missing = self.client.get("/api/no-such-route")
        self.assertEqual(missing.status_code, 404)
        for headers in ({}, {"X-Guest-Id": GUEST}, {"Authorization": "Bearer forged"}, token(MEMBER)):
            for route in ROUTES:
                response = self.client.get(route, headers=headers)
                self.assertEqual((route, response.status_code, response.json()), (route, 404, missing.json()))

    def test_a_guest_id_naming_the_admin_is_not_the_admin(self):
        self.assertEqual(self.client.get("/api/admin/me", headers={"X-Guest-Id": ADMIN}).status_code, 404)

    def test_the_admin_gets_every_route(self):
        # Not the local file route: this test has no file for it to serve.
        for route in ROUTES[:-1]:
            self.assertEqual((route, self.client.get(route, headers=token(ADMIN)).status_code), (route, 200))
        self.assertEqual(self.client.get("/api/admin/me", headers=token(ADMIN)).json(), {"user_id": ADMIN})


class DashboardDataTests(AdminTestCase):
    def get(self, route):
        response = self.client.get(route, headers=token(ADMIN))
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_users_list_subscriptions_and_upload_counts(self):
        db.upsert_subscription(SUBSCRIBER, "active", "yearly", "stripe", self.now - 100, self.now + 1000, True,
                               subscription_id="sub_admin", started_at=self.now - 500, canceled_at=self.now - 50)
        listed = self.get("/api/admin/users")
        rows = {row["user_id"]: row for row in listed["items"]}
        self.assertEqual([row["user_id"] for row in listed["items"]], [MEMBER, SUBSCRIBER, ADMIN])
        self.assertEqual((listed["total"], listed["page"], listed["pages"]), (3, 1, 1))
        member = rows[MEMBER]
        # The deleted upload doesn't count; the failed one does, and is counted.
        self.assertEqual((member["uploads"], member["failed"], member["subscription"]), (3, 1, None))
        subscription = rows[SUBSCRIBER]["subscription"]
        self.assertEqual((subscription["premium"], subscription["started_at"], subscription["canceled_at"],
                          subscription["cancel_at_period_end"]), (True, self.now - 500, self.now - 50, True))

    def test_a_users_uploads_include_deleted_ones_newest_first(self):
        uploads = self.get(f"/api/admin/users/{MEMBER}/uploads")
        self.assertEqual([u["job_id"] for u in uploads], ["member-failed", "member-rough", "member-done", "member-deleted"])
        self.assertEqual(uploads[0]["error"], "No music notation was detected")
        self.assertEqual(uploads[2]["sheet_name"], "member-done.pdf")
        self.assertEqual(uploads[2]["seconds"], 60)

    def test_uploads_filter_and_mark_guests_but_never_list_the_demo(self):
        everything = self.get("/api/admin/uploads")["items"]
        self.assertNotIn("demo", [u["job_id"] for u in everything])
        guest = next(u for u in everything if u["job_id"] == "guest-done")
        member = next(u for u in everything if u["job_id"] == "member-done")
        self.assertEqual((guest["guest"], member["guest"]), (True, False))
        self.assertEqual([u["job_id"] for u in self.get("/api/admin/uploads?status=failed")["items"]], ["member-failed"])
        self.assertEqual([u["job_id"] for u in self.get("/api/admin/uploads?status=review")["items"]], ["member-rough"])

    def test_users_and_uploads_come_a_page_at_a_time(self):
        first = self.get("/api/admin/users?page_size=2")
        second = self.get("/api/admin/users?page_size=2&page=2")
        self.assertEqual((first["total"], first["pages"], len(first["items"]), len(second["items"])), (3, 2, 2, 1))
        self.assertEqual([u["user_id"] for u in first["items"] + second["items"]], [MEMBER, SUBSCRIBER, ADMIN])
        # A page past the end shows the last one, not an empty list.
        self.assertEqual(self.get("/api/admin/users?page_size=2&page=9")["page"], 2)
        uploads = self.get("/api/admin/uploads?page_size=2&page=3")
        self.assertEqual((uploads["total"], uploads["pages"], [u["job_id"] for u in uploads["items"]]),
                         (5, 3, ["member-deleted"]))

    def test_user_id_search(self):
        self.assertEqual([u["user_id"] for u in self.get(f"/api/admin/users?q={MEMBER[:8].upper()}")["items"]], [MEMBER])
        self.assertEqual({u["user_id"] for u in self.get(f"/api/admin/uploads?q={GUEST[:8]}")["items"]}, {GUEST})

    def test_no_name_or_email_leaves_the_api(self):
        db._users[MEMBER]["display_name"] = "Member Name"
        db.upsert_subscription(MEMBER, "active", "monthly", "apple", 1, 2, False, subscription_id="s1")
        for route in ROUTES[:-1] + ["/api/admin/users?q=b", "/api/admin/uploads?status=done"]:
            body = self.client.get(route, headers=token(ADMIN)).text
            for secret in ("member@example.com", "me@example.com", "Member Name", '"email"', '"display_name"'):
                self.assertNotIn(secret, body, route)

    def test_users_filtered_by_column(self):
        def ids(route):
            return {u["user_id"] for u in self.get(route)["items"]}
        db.upsert_subscription(SUBSCRIBER, "trialing", "monthly", "stripe", self.now - 100, self.now + 1000, True,
                               subscription_id="sub_f", started_at=self.now - 2 * 86400, canceled_at=self.now - 60)
        self.assertEqual(ids("/api/admin/users?joined=7"), {MEMBER})
        self.assertEqual(ids("/api/admin/users?plan=canceling"), {SUBSCRIBER})
        self.assertEqual(ids("/api/admin/users?plan=free"), {MEMBER, ADMIN})
        self.assertEqual(ids("/api/admin/users?subscribed=7"), {SUBSCRIBER})
        self.assertEqual(ids("/api/admin/users?subscribed=1"), set())
        self.assertEqual(ids("/api/admin/users?canceled=1"), {SUBSCRIBER})
        self.assertEqual(ids("/api/admin/users?uploads=failed"), {MEMBER})
        self.assertEqual(ids("/api/admin/users?uploads=none"), {SUBSCRIBER, ADMIN})
        self.assertEqual(ids("/api/admin/users?plan=free&uploads=some"), {MEMBER})

    def test_uploads_filtered_by_column_with_outcome_totals(self):
        def ids(route):
            return [u["job_id"] for u in self.get(route)["items"]]
        db._annotation_jobs["member-done"]["size"] = 20 * 1024 * 1024
        db._annotation_jobs["guest-done"]["updated_at"] += 600
        everything = self.get("/api/admin/uploads")
        # member-done, guest-done; member-rough; member-failed. Not the deleted one.
        self.assertEqual(everything["summary"], {"done": 2, "warning": 1, "failed": 1, "processed": 4})
        self.assertEqual(ids("/api/admin/uploads?status=done"), ["guest-done", "member-done"])
        self.assertEqual(ids("/api/admin/uploads?status=warning"), ["member-rough"])
        self.assertEqual(ids("/api/admin/uploads?owner=guest"), ["guest-done"])
        self.assertEqual(len(ids("/api/admin/uploads?owner=account")), 4)
        self.assertEqual(ids("/api/admin/uploads?sheet=ROUGH"), ["member-rough"])
        recent = ids("/api/admin/uploads?since=1")  # The day-old ones sit right on the edge.
        self.assertEqual((recent[0], "member-done" in recent), ("member-failed", False))
        self.assertEqual(ids("/api/admin/uploads?min_seconds=300"), ["guest-done"])
        self.assertEqual(ids("/api/admin/uploads?size=large"), ["member-done"])
        # The totals follow every filter but the result one.
        narrowed = self.get("/api/admin/uploads?owner=account&status=failed")
        self.assertEqual(narrowed["summary"], {"done": 1, "warning": 1, "failed": 1, "processed": 3})
        self.assertEqual([u["job_id"] for u in narrowed["items"]], ["member-failed"])

    def test_subscriptions_counted_by_state(self):
        later, earlier = self.now + 1000, self.now - 1000
        for user_id, status, cancel, period_end in (
                ("paying", "active", False, later), ("trying", "trialing", False, later),
                ("leaving", "active", True, later), ("leaving-trial", "trialing", True, later),
                ("lapsed", "active", True, earlier), ("gone", "canceled", False, earlier),
                ("unpaid", "past_due", False, later)):
            db.upsert_subscription(user_id, status, "monthly", "stripe", earlier, period_end, cancel,
                                   subscription_id=f"sub_{user_id}", started_at=self.now - len(user_id))
        listed = self.get("/api/admin/subscriptions")
        self.assertEqual(listed["counts"], {"active": 1, "trial": 1, "canceling": 2, "past_due": 1, "canceled": 2})
        states = {row["user_id"]: row["state"] for row in listed["items"]}
        self.assertEqual((states["leaving-trial"], states["lapsed"]), ("canceling", "canceled"))
        # Newest first; the filter narrows the list but not the counts.
        self.assertEqual(listed["items"][0]["user_id"], "gone")
        canceling = self.get("/api/admin/subscriptions?state=canceling")
        self.assertEqual({row["user_id"] for row in canceling["items"]}, {"leaving", "leaving-trial"})
        self.assertEqual(canceling["counts"], listed["counts"])

    def test_overview_counts(self):
        overview = self.get("/api/admin/overview")
        self.assertEqual(overview["users"], {"total": 3, "new_7d": 1, "new_30d": 1})
        uploads = overview["uploads"]
        self.assertEqual((uploads["total"], uploads["last_30d"], uploads["failed_30d"], uploads["review_30d"]),
                         (5, 5, 1, 1))
        self.assertEqual(uploads["failure_rate_30d"], 0.25)


class CancellationDatesTests(unittest.TestCase):
    """canceled_at and ended_at are recorded from now on (owner decision), by
    db.upsert_subscription, whichever store billed the subscription."""

    def setUp(self):
        isolate(self)

    def upsert(self, status, cancel_at_period_end, **provider_times):
        db.upsert_subscription(SUBSCRIBER, status, "monthly", "apple", 100, 200, cancel_at_period_end,
                               subscription_id="original_1", **provider_times)
        return db.get_subscription(SUBSCRIBER)

    def test_first_heard_time_is_kept_across_later_syncs(self):
        self.assertNotIn("canceled_at", self.upsert("active", False))
        canceled_at = self.upsert("active", True)["canceled_at"]
        db._subscriptions[SUBSCRIBER]["canceled_at"] = canceled_at - 1000
        self.assertEqual(self.upsert("active", True)["canceled_at"], canceled_at - 1000)
        ended = self.upsert("expired", True)
        self.assertEqual(ended["canceled_at"], canceled_at - 1000)
        self.assertIn("ended_at", ended)

    def test_resuming_or_resubscribing_clears_them(self):
        self.upsert("expired", False)
        row = self.upsert("active", False)
        self.assertNotIn("canceled_at", row)
        self.assertNotIn("ended_at", row)

    def test_the_providers_own_times_win(self):
        row = self.upsert("expired", False, canceled_at=150, ended_at=180)
        self.assertEqual((row["canceled_at"], row["ended_at"]), (150, 180))


class IsolationTests(AdminTestCase):
    """Nothing the dashboard adds may take the rest of the app down with it."""

    def test_the_api_serves_everyone_else_if_the_admin_module_cannot_load(self):
        self.addCleanup(importlib.reload, server)  # runs last, with admin loadable again
        broken = patch.dict(sys.modules, {"admin": None})  # makes `import admin` raise
        broken.start()
        self.addCleanup(broken.stop)
        importlib.reload(server)
        with TestClient(server.app) as client:
            self.assertEqual(client.get("/api/health").status_code, 200)
            self.assertEqual(client.get("/api/sheets", headers={"X-Guest-Id": GUEST}).status_code, 200)
            self.assertEqual(client.get("/api/admin/me", headers=token(ADMIN)).status_code, 404)

    def test_an_unreadable_admin_table_is_a_404_not_an_error(self):
        with patch.object(db, "is_admin", side_effect=RuntimeError("no such table")):
            self.assertEqual(self.client.get("/api/admin/me", headers=token(ADMIN)).status_code, 404)

    def test_a_broken_cancellation_record_never_fails_a_subscription(self):
        with patch.object(db, "_cancellation", side_effect=RuntimeError("boom")):
            db.upsert_subscription(SUBSCRIBER, "active", "monthly", "stripe", 100, 200, True, subscription_id="s")
        self.assertEqual(db.get_subscription(SUBSCRIBER)["status"], "active")

    def test_an_unreadable_apple_revocation_date_never_fails_a_sync(self):
        self.assertEqual(apple_billing._ended_at({"revocationDate": "junk"}, 100), 100)
        self.assertIsNone(apple_billing._ended_at({"revocationDate": "junk"}, None))


if __name__ == "__main__":
    unittest.main()
