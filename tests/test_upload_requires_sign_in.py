"""Uploading is a members feature (owner decision): every route that creates
a new job now requires a valid signed-in token - a guest id (or no identity
at all) authenticates reads of a job a guest already owns, never a new
upload. Runs in local (non-serverless) mode, like test_delete_sheet.py.
"""
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
