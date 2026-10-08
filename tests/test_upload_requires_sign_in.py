"""Uploading is a members feature (owner decision): every route that creates
a new job now requires a valid signed-in token - a guest id (or no identity
at all) authenticates reads of a job a guest already owns, never a new
upload. Runs in local (non-serverless) mode, like test_delete_sheet.py.
"""
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import auth
import config
import db
import job_state
import server
import storage
import worker

USER = "11111111-1111-4111-8111-111111111111"
GUEST = "22222222-2222-4222-8222-222222222222"

UPLOAD_BODY = {"filename": "Song.pdf", "size": 10, "style": "unicode", "octave": False,
               "font_size": 6.5, "dpi": None, "auto_retry": True, "color": "#000000"}
OPTIONS = {"style": "unicode", "octave": False, "font_size": 6.5, "dpi": None, "auto_retry": True, "color": "#000000"}


def fake_runner(job, directory, tick):
    """Stands in for processor.py/Audiveris - see test_serverless.py."""
    tick()
    (directory / "annotated.pdf").write_bytes(b"%PDF-annotated")
    (directory / "timeline.json").write_text('{"version": 1, "notes": []}')
    return 2


class UploadRequiresSignInTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)

    def tearDown(self):
        self.client.close()

    def signed_in(self, user_id=USER):
        return {"Authorization": f"Bearer {auth.mint_backend_token(user_id)}"}

    def test_direct_upload_reservation_rejects_anonymous_and_guest_requests(self):
        self.assertEqual(self.client.post("/api/uploads", json=UPLOAD_BODY).status_code, 401)
        self.assertEqual(
            self.client.post("/api/uploads", json=UPLOAD_BODY, headers={"X-Guest-Id": GUEST}).status_code, 401)

    def test_upload_completion_rejects_anonymous_and_guest_requests(self):
        self.assertEqual(self.client.post("/api/uploads/some-job/complete").status_code, 401)
        self.assertEqual(
            self.client.post("/api/uploads/some-job/complete", headers={"X-Guest-Id": GUEST}).status_code, 401)

    def test_legacy_multipart_upload_rejects_anonymous_and_guest_requests(self):
        files = {"file": ("Song.pdf", b"%PDF-1.4 test", "application/pdf")}
        self.assertEqual(self.client.post("/api/sheets", files=files).status_code, 401)
        self.assertEqual(
            self.client.post("/api/sheets", files=files, headers={"X-Guest-Id": GUEST}).status_code, 401)

    def test_signed_in_request_clears_the_sign_in_gate(self):
        # Direct uploads are only enabled with JOB_BACKEND=sqs; a signed-in
        # request still reaches that feature check (404), rather than being
        # turned away as anonymous (401) - proving the gate passed.
        response = self.client.post("/api/uploads", json=UPLOAD_BODY, headers=self.signed_in())
        self.assertEqual(response.status_code, 404)
        self.assertIn("not enabled", response.json()["detail"])

    def test_signed_in_user_can_still_upload_through_the_local_endpoint(self):
        files = {"file": ("Song.pdf", b"%PDF-1.4 test", "application/pdf")}
        with patch.object(server, "enqueue_local") as enqueue:
            response = self.client.post("/api/sheets", files=files, headers=self.signed_in())
        self.assertEqual(response.status_code, 202, response.text)
        job_id = response.json()["job_id"]
        self.addCleanup(db.delete_annotation_job, job_id)
        self.addCleanup(db.delete_music_sheet, response.json()["music_sheet_id"])
        self.assertEqual(db.get_annotation_job(job_id)["user_id"], USER)
        enqueue.assert_called_once_with(job_id)

    def upload(self, user_id=USER):
        files = {"file": ("Song.pdf", b"%PDF-1.4 test", "application/pdf")}
        with patch.object(server, "enqueue_local"):
            response = self.client.post("/api/sheets", files=files, headers=self.signed_in(user_id))
        if response.status_code == 202:
            self.addCleanup(db.delete_annotation_job, response.json()["job_id"])
            self.addCleanup(db.delete_music_sheet, response.json()["music_sheet_id"])
        return response

    def finish(self, job_id, status="done"):
        job = db.get_annotation_job(job_id)
        db.update_annotation_job(job_id, status=status)
        job_state.release(job)

    def test_a_free_account_keeps_one_sheet_at_a_time(self):
        free = "33333333-3333-4333-8333-333333333333"
        first = self.upload(free)
        self.assertEqual(first.status_code, 202, first.text)
        self.finish(first.json()["job_id"])

        second = self.upload(free)
        self.assertEqual(second.status_code, 403)
        self.assertIn("free plan keeps 1 sheet", second.json()["detail"])

        self.assertEqual(self.client.delete(f"/api/sheets/{first.json()['job_id']}",
                                            headers=self.signed_in(free)).status_code, 204)
        self.assertEqual(self.upload(free).status_code, 202)

    def test_a_failed_sheet_does_not_use_the_free_slot(self):
        free = "44444444-4444-4444-8444-444444444444"
        first = self.upload(free)
        self.finish(first.json()["job_id"], status="failed")
        self.assertEqual(self.upload(free).status_code, 202)

    def test_premium_accounts_have_no_sheet_limit(self):
        premium = "55555555-5555-4555-8555-555555555555"
        with patch.object(server, "get_entitlement", return_value={"tier": "premium"}):
            for _ in range(3):
                response = self.upload(premium)
                self.assertEqual(response.status_code, 202, response.text)
                self.finish(response.json()["job_id"])

    def started(self, user_id, count, status="failed"):
        """Start ``count`` sheets that end ``status``, each freeing the slot."""
        for _ in range(count):
            response = self.upload(user_id)
            self.assertEqual(response.status_code, 202, response.text)
            self.finish(response.json()["job_id"], status=status)

    def test_a_free_account_starts_five_sheets_a_day_however_they_end(self):
        free = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1"
        # Failed sheets free the one-sheet slot; they still count today.
        self.started(free, 5)
        refused = self.upload(free)
        self.assertEqual(refused.status_code, 429)
        self.assertIn("started 5 sheets today", refused.json()["detail"])
        self.assertIn("Premium allows 20 a day, or 30 on the yearly plan", refused.json()["detail"])
        self.assertGreater(int(refused.headers["Retry-After"]), 0)

    def test_deleting_a_sheet_does_not_give_back_a_days_sheet(self):
        free = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2"
        for _ in range(5):
            response = self.upload(free)
            self.finish(response.json()["job_id"])
            self.assertEqual(self.client.delete(f"/api/sheets/{response.json()['job_id']}",
                                                headers=self.signed_in(free)).status_code, 204)
        self.assertEqual(self.upload(free).status_code, 429)

    def test_a_monthly_account_starts_twenty_sheets_a_day(self):
        monthly = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3"
        with patch.object(server, "get_entitlement", return_value={"tier": "premium", "plan": "monthly"}):
            self.started(monthly, 20, status="done")
            refused = self.upload(monthly)
        self.assertEqual(refused.status_code, 429)
        self.assertIn("started 20 sheets today", refused.json()["detail"])
        self.assertIn("The yearly plan allows 30 a day", refused.json()["detail"])

    def test_a_yearly_account_starts_thirty_sheets_a_day(self):
        yearly = "d7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7"
        with patch.object(server, "get_entitlement", return_value={"tier": "premium", "plan": "yearly"}):
            self.started(yearly, 30, status="done")
            refused = self.upload(yearly)
        self.assertEqual(refused.status_code, 429)
        self.assertIn("started 30 sheets today", refused.json()["detail"])
        # The most there is: nothing to upgrade to after when it resets.
        self.assertRegex(refused.json()["detail"], r"another (in about \d+ hours?|within the hour)\.$")

    def test_a_master_account_without_a_subscription_gets_the_yearly_limit(self):
        master = "d8d8d8d8-d8d8-4d8d-8d8d-d8d8d8d8d8d8"
        with patch.object(server, "get_entitlement", return_value={"tier": "premium", "plan": None, "master": True}):
            self.assertEqual(server._daily_sheet_limit(master), 30)

    def test_reading_a_failed_sheet_again_counts_as_a_sheet_started(self):
        free = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4"
        self.started(free, 4)
        last = self.upload(free).json()["job_id"]
        self.finish(last, status="failed")
        db.update_annotation_job(last, storage_version=2, input_version="v1")
        self.assertEqual(self.client.post(f"/api/sheets/{last}/retry", headers=self.signed_in(free)).status_code, 429)
        self.assertEqual(db.get_annotation_job(last)["status"], "failed")

    def test_the_days_count_starts_over_at_midnight_utc(self):
        free = "d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5"
        self.started(free, 5)
        tomorrow = job_state.next_daily_reset(time.time()) + 60
        with patch.object(job_state.time, "time", return_value=tomorrow):
            self.assertEqual(self.upload(free).status_code, 202)

    def test_an_admin_has_no_daily_limit(self):
        admin = "d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6"
        db.add_admin(admin)
        self.addCleanup(db._admins.discard, admin)
        self.started(admin, 6)

    def test_a_guests_previously_uploaded_job_still_reads_and_lists(self):
        """Fallout check: gating new uploads must not touch reads of content
        a guest already owns from before this change."""
        db.create_music_sheet("guest-sheet", GUEST, "Old.pdf")
        db.create_annotation_job("guest-job", GUEST, "guest-sheet", "unicode", False, 6.5, None, True)
        db.update_annotation_job("guest-job", status="done")
        self.addCleanup(db.delete_annotation_job, "guest-job")
        self.addCleanup(db.delete_music_sheet, "guest-sheet")

        headers = {"X-Guest-Id": GUEST}
        self.assertEqual(self.client.get("/api/sheets/guest-job", headers=headers).status_code, 200)
        jobs = self.client.get("/api/sheets", headers=headers).json()
        self.assertEqual([j["job_id"] for j in jobs], ["guest-job"])

    def test_demo_read_carve_out_is_unaffected(self):
        """The demo's anonymous read carve-out (see test_demo_sheet.py) goes
        through neither dependency this change touches, and must keep
        working with no identity at all."""
        job = job_state.create(config.DEMO_JOB_ID, config.DEMO_OWNER_ID, config.DEMO_SHEET_NAME, OPTIONS, 4)
        storage._local_path(job["input_key"]).write_bytes(b"source")
        job_state.ready(job["job_id"], "local")
        self.assertTrue(worker.process_job(job["job_id"], runner=fake_runner))
        self.addCleanup(db.delete_annotation_job, config.DEMO_JOB_ID)
        self.addCleanup(db.delete_music_sheet, config.DEMO_JOB_ID)

        self.assertEqual(self.client.get(f"/api/sheets/{config.DEMO_JOB_ID}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/sheets/{config.DEMO_JOB_ID}/assets").status_code, 200)


if __name__ == "__main__":
    unittest.main()
