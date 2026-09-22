"""The bundled demo sheet (see demo-sheet/) is readable by anyone, signed in
or not, but stays exactly as mutable as any other job - which is to say,
not by a stranger. Runs in local (non-serverless) mode, like test_delete_sheet.py.
"""
import unittest

from fastapi.testclient import TestClient

import auth
import config
import db
import job_state
import server
import storage
import worker

OTHER_USER = "11111111-1111-4111-8111-111111111111"
OUTSIDER = "22222222-2222-4222-8222-222222222222"
OPTIONS = {"style": "unicode", "octave": False, "font_size": 6.5, "dpi": None, "auto_retry": True, "color": "#000000"}


def fake_runner(job, directory, tick):
    """Stands in for processor.py/Audiveris - see test_serverless.py."""
    tick()
    (directory / "annotated.pdf").write_bytes(b"%PDF-annotated")
    (directory / "timeline.json").write_text('{"version": 1, "notes": []}')
    return 3


class DemoSheetTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        # Seeds the demo job the same way _seed_local.py's seed_demo() does:
        # through the real local pipeline, under the fixed demo id/owner.
        job = job_state.create(config.DEMO_JOB_ID, config.DEMO_OWNER_ID, config.DEMO_SHEET_NAME, OPTIONS, 4)
        storage._local_path(job["input_key"]).write_bytes(b"%PDF-source")
        job_state.ready(job["job_id"], "local")
        self.assertTrue(worker.process_job(job["job_id"], runner=fake_runner))

        # An ordinary job, owned by someone else, to prove the carve-out stays
        # narrow to the one demo job id.
        db.create_music_sheet("other-sheet", OTHER_USER, "Other.pdf")
        db.create_annotation_job("other-job", OTHER_USER, "other-sheet", "unicode", False, 6.5, None, True)
        db.update_annotation_job("other-job", status="done")

    def tearDown(self):
        self.client.close()
        db.delete_annotation_job(config.DEMO_JOB_ID)
        db.delete_music_sheet(config.DEMO_JOB_ID)
        db.delete_annotation_job("other-job")
        db.delete_music_sheet("other-sheet")

    def demo_paths(self):
        return [
            f"/api/sheets/{config.DEMO_JOB_ID}",
            f"/api/sheets/{config.DEMO_JOB_ID}/assets",
            f"/api/sheets/{config.DEMO_JOB_ID}/timeline",
            f"/api/sheets/{config.DEMO_JOB_ID}/download",
            f"/api/sheets/{config.DEMO_JOB_ID}/original",
        ]

    def test_demo_job_is_readable_with_no_auth_header_and_no_guest_id(self):
        for path in self.demo_paths():
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200, response.text)

    def test_demo_job_is_readable_by_any_guest_or_signed_in_visitor_too(self):
        headers_variants = [
            {},
            {"X-Guest-Id": OUTSIDER},
            {"Authorization": f"Bearer {auth.mint_backend_token(OUTSIDER)}"},
        ]
        for headers in headers_variants:
            with self.subTest(headers=headers):
                response = self.client.get(f"/api/sheets/{config.DEMO_JOB_ID}", headers=headers)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["status"], "done")

    def test_other_jobs_stay_401_403_style_404_without_ownership(self):
        for headers in ({}, {"X-Guest-Id": OUTSIDER}):
            with self.subTest(headers=headers):
                self.assertEqual(self.client.get("/api/sheets/other-job", headers=headers).status_code, 404)
                self.assertEqual(self.client.get("/api/sheets/other-job/assets", headers=headers).status_code, 404)
                self.assertEqual(self.client.get("/api/sheets/other-job/download", headers=headers).status_code, 404)

        # The rightful owner is unaffected by the demo carve-out.
        owner_headers = {"X-Guest-Id": OTHER_USER}
        self.assertEqual(self.client.get("/api/sheets/other-job", headers=owner_headers).status_code, 200)

    def test_demo_job_cannot_be_deleted_even_with_spoofed_ownership(self):
        for headers in ({}, {"X-Guest-Id": config.DEMO_OWNER_ID}, {"X-Guest-Id": OUTSIDER}):
            with self.subTest(headers=headers):
                response = self.client.delete(f"/api/sheets/{config.DEMO_JOB_ID}", headers=headers)
                self.assertEqual(response.status_code, 403)
        job = db.get_annotation_job(config.DEMO_JOB_ID)
        self.assertIsNotNone(job)
        self.assertEqual(job["status"], "done")

    def test_other_jobs_still_require_ownership_to_delete(self):
        response = self.client.delete("/api/sheets/other-job", headers={"X-Guest-Id": OUTSIDER})
        self.assertEqual(response.status_code, 404)
        self.assertIsNotNone(db.get_annotation_job("other-job"))


if __name__ == "__main__":
    unittest.main()
