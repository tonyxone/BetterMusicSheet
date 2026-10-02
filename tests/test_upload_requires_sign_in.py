"""Uploading is a members feature (owner decision): every route that creates
a new job now requires a valid signed-in token - a guest id (or no identity
at all) authenticates reads of a job a guest already owns, never a new
upload. Runs in local (non-serverless) mode, like test_delete_sheet.py.
"""
import unittest
import uuid
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

    def upload(self, user_id=USER, website=True):
        """An upload from the website - which, as any browser request to the
        API, carries an Origin - or, with website=False, from the iOS app."""
        files = {"file": ("Song.pdf", b"%PDF-1.4 test", "application/pdf")}
        headers = {**self.signed_in(user_id), **({"Origin": "https://bettermusicsheet.com"} if website else {})}
        with patch.object(server, "enqueue_local"):
            response = self.client.post("/api/sheets", files=files, headers=headers)
        if response.status_code == 202:
            self.addCleanup(db.delete_annotation_job, response.json()["job_id"])
            self.addCleanup(db.delete_music_sheet, response.json()["music_sheet_id"])
        return response

    def finish(self, job_id, status="done"):
        job = db.get_annotation_job(job_id)
        db.update_annotation_job(job_id, status=status)
        job_state.release(job)

    def delete(self, user_id, job_id):
        return self.client.delete(f"/api/sheets/{job_id}", headers=self.signed_in(user_id)).status_code

    def free_upload_used(self, user_id):
        return self.client.get("/api/me/subscription", headers=self.signed_in(user_id)).json()["free_upload_used"]

    def test_a_free_account_uploads_one_sheet_for_good(self):
        free = str(uuid.uuid4())
        first = self.upload(free)
        self.assertEqual(first.status_code, 202, first.text)
        self.finish(first.json()["job_id"])

        second = self.upload(free)
        self.assertEqual(second.status_code, 403)
        self.assertIn("used the free plan's 1 sheet upload", second.json()["detail"])

        # Deleting the sheet doesn't give the upload back.
        self.assertFalse(self.free_upload_used(free))
        self.assertEqual(self.delete(free, first.json()["job_id"]), 204)
        self.assertTrue(self.free_upload_used(free))
        third = self.upload(free)
        self.assertEqual(third.status_code, 403)
        self.assertIn("used the free plan's 1 sheet upload", third.json()["detail"])

    def test_a_failed_sheet_does_not_use_the_free_upload(self):
        free = str(uuid.uuid4())
        first = self.upload(free)
        self.finish(first.json()["job_id"], status="failed")
        self.assertEqual(self.upload(free).status_code, 202)

    def test_deleting_a_failed_sheet_does_not_use_the_free_upload(self):
        free = str(uuid.uuid4())
        first = self.upload(free)
        self.finish(first.json()["job_id"], status="failed")
        self.assertEqual(self.delete(free, first.json()["job_id"]), 204)
        self.assertFalse(self.free_upload_used(free))
        self.assertEqual(self.upload(free).status_code, 202)

    def test_cancelling_a_sheet_before_it_finishes_does_not_use_the_free_upload(self):
        free = str(uuid.uuid4())
        first = self.upload(free)
        self.assertEqual(db.get_annotation_job(first.json()["job_id"])["status"], "queued")
        self.delete(free, first.json()["job_id"])
        self.assertFalse(self.free_upload_used(free))

    def test_a_sheet_that_finishes_while_being_deleted_still_uses_the_free_upload(self):
        # The delete reads "processing", loses the race to the worker, and
        # retries on the now-finished sheet: that pass must mark the account.
        free = str(uuid.uuid4())
        first = self.upload(free)
        job_id = first.json()["job_id"]
        real_change = job_state.change
        def finish_first(changed_id, expected, **fields):
            if fields.get("status") == "deleting" and expected.get("status") != "done":
                self.finish(job_id)  # the worker gets there first
                return False
            return real_change(changed_id, expected, **fields)
        with patch.object(job_state, "change", side_effect=finish_first):
            self.client.delete(f"/api/sheets/{job_id}", headers=self.signed_in(free))
        self.assertTrue(self.free_upload_used(free))

    def account(self, email):
        user_id = str(uuid.uuid4())
        db.create_user_if_missing(user_id, email, "Reader")
        return user_id

    def delete_account(self, user_id):
        with patch.object(server, "delete_cognito_user"):
            return self.client.delete("/api/me", headers=self.signed_in(user_id)).status_code

    def test_signing_up_again_with_the_same_email_doesnt_bring_the_free_upload_back(self):
        email = f"reader.{uuid.uuid4().hex[:8]}@gmail.com"
        first = self.account(email)
        sheet = self.upload(first)
        self.finish(sheet.json()["job_id"])
        self.assertEqual(self.delete_account(first), 204)

        # The same inbox, written another way, as a brand-new account.
        local, _, domain = email.partition("@")
        again = self.account(f"{local.upper().replace('.', '')}+again@googlemail.com")
        self.assertTrue(self.free_upload_used(again))
        refused = self.upload(again)
        self.assertEqual(refused.status_code, 403)
        self.assertIn("used the free plan's 1 sheet upload", refused.json()["detail"])
        # A different address is a different reader.
        self.assertEqual(self.upload(self.account(f"other.{uuid.uuid4().hex[:8]}@gmail.com")).status_code, 202)

    def test_deleting_an_account_that_never_finished_a_sheet_leaves_no_claim(self):
        email = f"new.{uuid.uuid4().hex[:8]}@example.com"
        first = self.account(email)
        failed = self.upload(first)
        self.finish(failed.json()["job_id"], status="failed")
        self.assertEqual(self.delete_account(first), 204)
        self.assertEqual(self.upload(self.account(email)).status_code, 202)

    def test_the_email_claim_only_applies_on_the_website(self):
        email = f"ios.{uuid.uuid4().hex[:8]}@example.com"
        first = self.account(email)
        sheet = self.upload(first)
        self.finish(sheet.json()["job_id"])
        self.assertEqual(self.delete_account(first), 204)
        self.assertEqual(self.upload(self.account(email), website=False).status_code, 202)

    def test_the_ios_app_keeps_its_one_sheet_at_a_time_rule(self):
        # The app sends no Origin. Its free accounts may still delete their
        # sheet and add another, and hear the same message they always have.
        free = str(uuid.uuid4())
        first = self.upload(free, website=False)
        self.finish(first.json()["job_id"])
        second = self.upload(free, website=False)
        self.assertEqual(second.status_code, 403)
        self.assertIn("free plan keeps 1 sheet at a time", second.json()["detail"])
        self.assertEqual(self.delete(free, first.json()["job_id"]), 204)
        self.assertEqual(self.upload(free, website=False).status_code, 202)

    def test_the_website_holds_to_the_lifetime_limit_whichever_app_deleted_the_sheet(self):
        # Deleted in the iOS app, the sheet still used up the website's upload.
        free = str(uuid.uuid4())
        first = self.upload(free, website=False)
        self.finish(first.json()["job_id"])
        self.assertEqual(self.delete(free, first.json()["job_id"]), 204)
        self.assertEqual(self.upload(free, website=True).status_code, 403)

    def test_a_premium_account_deleting_a_sheet_still_uploads_freely(self):
        premium = str(uuid.uuid4())
        with patch.object(server, "get_entitlement", return_value={"tier": "premium"}):
            first = self.upload(premium)
            self.finish(first.json()["job_id"])
            self.assertEqual(self.delete(premium, first.json()["job_id"]), 204)
            self.assertEqual(self.upload(premium).status_code, 202)

    def test_premium_accounts_have_no_sheet_limit(self):
        premium = "55555555-5555-4555-8555-555555555555"
        with patch.object(server, "get_entitlement", return_value={"tier": "premium"}):
            for _ in range(3):
                response = self.upload(premium)
                self.assertEqual(response.status_code, 202, response.text)
                self.finish(response.json()["job_id"])

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
