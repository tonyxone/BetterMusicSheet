"""Time spent with sheets (usage.py): the browser's reports, and what the
admin dashboard makes of them (admin.py's /engagement and the Users tab)."""
import os
import time
import unittest
import uuid
from unittest.mock import patch

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

import config
import db
import server
import usage
from test_admin import ADMIN, GUEST, MEMBER, SUBSCRIBER, AdminTestCase, add_job, token


def session():
    return str(uuid.uuid4())


class UsageTestCase(AdminTestCase):
    def setUp(self):
        super().setUp()
        patcher = patch.dict(usage._rows, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        add_job(self, config.DEMO_JOB_ID, config.DEMO_OWNER_ID, "done", self.now - 86400)

    def report(self, headers, **body):
        return self.client.post("/api/usage", headers=headers, json={"surface": "sheet", **body})

    def admin_get(self, route):
        response = self.client.get(route, headers=token(ADMIN))
        self.assertEqual(response.status_code, 200)
        return response.json()


class ReportTests(UsageTestCase):
    def test_reports_add_up_in_their_session(self):
        sid = session()
        self.assertEqual(self.report(token(MEMBER), session_id=sid, job_id="member-done", surface="practice",
                                     seconds=60, playing_seconds=40, events={"play": 2, "speed": 1}).status_code, 204)
        self.assertEqual(self.report(token(MEMBER), session_id=sid, job_id="member-done", surface="practice",
                                     seconds=30, events={"play": 1, "measure": 3}).status_code, 204)
        [row] = usage.user_sessions(MEMBER)
        self.assertEqual((row["job_id"], row["surface"], row["platform"], row["seconds"], row["playing_seconds"]),
                         ("member-done", "practice", "web", 90, 40))
        self.assertEqual(row["events"], {"play": 3, "speed": 1, "measure": 3})
        self.assertFalse(row["admin"])

    def test_only_a_sheet_the_reader_may_open(self):
        response = self.report(token(MEMBER), session_id=session(), job_id="guest-done", seconds=10)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.report({"X-Guest-Id": GUEST}, session_id=session(), job_id="guest-done",
                                     seconds=10).status_code, 204)
        # Anyone may open the demo, so anyone may report on it.
        self.assertEqual(self.report(token(SUBSCRIBER), session_id=session(), job_id=config.DEMO_JOB_ID,
                                     seconds=10).status_code, 204)
        self.assertEqual(usage.user_sessions(MEMBER), [])
        self.assertEqual([s["job_id"] for s in usage.user_sessions(GUEST)], ["guest-done"])
        self.assertEqual([s["job_id"] for s in usage.user_sessions(SUBSCRIBER)], [config.DEMO_JOB_ID])

    def test_a_visitor_without_an_id_is_not_recorded(self):
        self.assertEqual(self.report({}, session_id=session(), job_id=config.DEMO_JOB_ID, seconds=10).status_code, 204)
        self.assertEqual(usage.all_sessions(), [])

    def test_bad_reports_are_refused(self):
        good = {"session_id": session(), "job_id": "member-done", "seconds": 10}
        for bad in ({"events": {"teleport": 1}}, {"seconds": usage.MAX_REPORT_SECONDS + 1}, {"seconds": -1},
                    {"surface": "library"}, {"session_id": "not-a-uuid"}, {"platform": "android"},
                    {"events": {"play": 5000}}, {"extra": 1}):
            response = self.report(token(MEMBER), **{**good, **bad})
            self.assertEqual((bad, response.status_code), (bad, 422))
        self.assertEqual(usage.all_sessions(), [])

    def test_an_admins_sessions_are_marked(self):
        add_job(self, "admin-sheet", ADMIN, "done", self.now - 600)
        self.report(token(ADMIN), session_id=session(), job_id="admin-sheet", seconds=10)
        self.assertTrue(usage.user_sessions(ADMIN)[0]["admin"])

    def test_deleting_an_account_forgets_its_sessions(self):
        self.report(token(MEMBER), session_id=session(), job_id="member-done", seconds=10)
        self.report({"X-Guest-Id": GUEST}, session_id=session(), job_id="guest-done", seconds=10)
        with patch.object(server, "delete_cognito_user"), patch.object(server.db, "get_in_progress_job", return_value=None):
            self.assertEqual(self.client.delete("/api/me", headers=token(MEMBER)).status_code, 204)
        self.assertEqual(usage.user_sessions(MEMBER), [])
        self.assertEqual(len(usage.user_sessions(GUEST)), 1)


class EngagementTests(UsageTestCase):
    def setUp(self):
        super().setUp()
        day = 86400
        # The member: on the sheet and practising today, practising 3 days ago.
        usage.record(MEMBER, session(), "member-done", "sheet", 120, events={"view": 1, "download": 1}, now=self.now - 60)
        usage.record(MEMBER, session(), "member-done", "practice", 600, 400, {"play": 4, "speed": 2}, now=self.now - 30)
        usage.record(MEMBER, session(), "member-rough", "practice", 300, 100, {"play": 1, "paywall": 1},
                     now=self.now - 3 * day)
        # A guest on the demo today.
        usage.record(GUEST, session(), config.DEMO_JOB_ID, "practice", 90, 60, {"play": 1}, now=self.now - 10)
        # Too long ago for a 30-day view.
        usage.record(SUBSCRIBER, session(), "member-done", "sheet", 999, now=self.now - 40 * day)
        # The admin trying things out is left out.
        usage.record(ADMIN, session(), config.DEMO_JOB_ID, "practice", 5000, 5000, {"play": 9}, admin=True,
                     now=self.now - 10)

    def test_totals(self):
        totals = self.admin_get("/api/admin/engagement?days=30")["totals"]
        self.assertEqual((totals["users"], totals["accounts"], totals["guests"], totals["practicing_users"]),
                         (2, 1, 1, 2))
        self.assertEqual(totals["sessions"], {"sheet": 1, "practice": 3})
        self.assertEqual((totals["sheet_seconds"], totals["practice_seconds"], totals["playing_seconds"]),
                         (120, 990, 560))
        # Member today 720, member 3 days ago 300, guest today 90.
        self.assertEqual(totals["median_day_seconds"], 300)

    def test_days(self):
        days = self.admin_get("/api/admin/engagement?days=30")["days"]
        self.assertEqual(len(days), 30)
        today = time.strftime("%Y-%m-%d", time.gmtime(self.now))
        self.assertEqual(days[-1], {"date": today, "sheet_seconds": 120, "practice_seconds": 690,
                                    "playing_seconds": 460, "users": 2})
        self.assertEqual((days[-4]["practice_seconds"], days[-4]["users"]), (300, 1))
        # 40 days ago is in a 60-day view.
        self.assertEqual(sum(d["sheet_seconds"] for d in self.admin_get("/api/admin/engagement?days=60")["days"]),
                         120 + 999)

    def test_controls(self):
        controls = {c["event"]: c for c in self.admin_get("/api/admin/engagement")["controls"]}
        self.assertEqual(list(controls), list(usage.EVENTS))
        self.assertEqual(controls["play"], {"event": "play", "users": 2, "uses": 6, "sheet": 0, "practice": 3})
        self.assertEqual(controls["download"], {"event": "download", "users": 1, "uses": 1, "sheet": 1, "practice": 0})
        self.assertEqual(controls["paywall"]["users"], 1)
        self.assertEqual(controls["edit"]["uses"], 0)

    def test_sheets_that_held_readers_longest(self):
        sheets = self.admin_get("/api/admin/engagement")["sheets"]
        self.assertEqual([s["job_id"] for s in sheets], ["member-done", "member-rough", config.DEMO_JOB_ID])
        first, _, demo = sheets
        self.assertEqual((first["sheet_name"], first["users"], first["sheet_seconds"], first["practice_seconds"],
                          first["playing_seconds"], first["demo"]), ("member-done.pdf", 1, 120, 600, 400, False))
        self.assertEqual((demo["sheet_name"], demo["demo"]), (config.DEMO_SHEET_NAME, True))

    def test_users_list_time_spent_and_last_active(self):
        rows = {row["user_id"]: row for row in self.admin_get("/api/admin/users")["items"]}
        self.assertEqual((rows[MEMBER]["active_seconds_30d"], rows[MEMBER]["last_active_at"]), (1020, self.now - 30))
        # Last seen 40 days ago: nothing in the last 30.
        self.assertEqual((rows[SUBSCRIBER]["active_seconds_30d"], rows[SUBSCRIBER]["last_active_at"]),
                         (0, self.now - 40 * 86400))

    def test_a_users_sessions_newest_first(self):
        sessions = self.admin_get(f"/api/admin/users/{MEMBER}/usage")
        self.assertEqual([(s["sheet_name"], s["surface"], s["seconds"]) for s in sessions],
                         [("member-done.pdf", "practice", 600), ("member-done.pdf", "sheet", 120),
                          ("member-rough.pdf", "practice", 300)])
        self.assertEqual(sessions[0]["events"], {"play": 4, "speed": 2})


class DynamoDBTests(unittest.TestCase):
    """The production store: the same reports, written with UpdateItem."""

    def setUp(self):
        env = patch.dict(os.environ, {"USAGE_TABLE": "test-usage", "AWS_REGION": "us-west-1",
                                      "AWS_DEFAULT_REGION": "us-west-1", "AWS_ACCESS_KEY_ID": "testing",
                                      "AWS_SECRET_ACCESS_KEY": "testing"})
        env.start()
        self.addCleanup(env.stop)
        production = patch.object(config, "IS_PRODUCTION", True)
        production.start()
        self.addCleanup(production.stop)
        aws = mock_aws()
        aws.start()
        self.addCleanup(aws.stop)
        usage._tables.clear()
        self.addCleanup(usage._tables.clear)
        boto3.client("dynamodb").create_table(
            TableName="test-usage", BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"},
                                  {"AttributeName": "session_id", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"},
                       {"AttributeName": "session_id", "KeyType": "RANGE"}])

    def test_round_trip(self):
        sid = session()
        usage.record(MEMBER, sid, "job-1", "practice", 60, 30, {"play": 2}, now=1000)
        usage.record(MEMBER, sid, "job-2", "sheet", 30, 0, {"play": 1, "speed": 4}, admin=True, now=1060)
        usage.record(MEMBER, session(), "job-3", "sheet", 5, now=500)
        usage.record(GUEST, session(), "job-4", "sheet", 7, now=2000)
        newest, oldest = usage.user_sessions(MEMBER)
        # What the first report said stays; the counts add up.
        self.assertEqual({k: newest[k] for k in ("job_id", "surface", "platform", "started_at", "last_at",
                                                 "seconds", "playing_seconds", "admin", "events")},
                         {"job_id": "job-1", "surface": "practice", "platform": "web", "started_at": 1000,
                          "last_at": 1060, "seconds": 90, "playing_seconds": 30, "admin": True,
                          "events": {"play": 3, "speed": 4}})
        self.assertEqual(oldest["job_id"], "job-3")
        item = boto3.resource("dynamodb").Table("test-usage").get_item(
            Key={"user_id": MEMBER, "session_id": sid})["Item"]
        self.assertEqual((item["expires_at"], item["reports"]), (1000 + usage.KEEP_DAYS * 86400, 2))
        self.assertEqual(sorted(s["job_id"] for s in usage.all_sessions(since=1000)), ["job-1", "job-4"])
        usage.forget(MEMBER)
        self.assertEqual(usage.user_sessions(MEMBER), [])
        self.assertEqual(len(usage.all_sessions()), 1)

    def test_without_a_table_reports_are_dropped(self):
        with patch.dict(os.environ):
            del os.environ["USAGE_TABLE"]
            usage.record(MEMBER, session(), "job-1", "sheet", 60)
            self.assertEqual(usage.all_sessions(), [])
        self.assertEqual(usage.all_sessions(), [])


if __name__ == "__main__":
    unittest.main()
