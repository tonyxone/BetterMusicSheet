"""Nothing the API returns may be answered from the browser's cache: the
same URL means a different thing to each visitor, so a sheet file cached
while signed in must not play again after signing out. Runs in local
(non-serverless) mode, like test_delete_sheet.py.
"""
import unittest

from fastapi.testclient import TestClient

import auth
import db
import job_state
import server
import storage
import worker

OWNER = "11111111-1111-4111-8111-111111111111"
OPTIONS = {"style": "unicode", "octave": False, "font_size": 6.5, "dpi": None, "auto_retry": True, "color": "#000000"}


def fake_runner(job, directory, tick):
    """Stands in for processor.py/Audiveris - see test_serverless.py."""
    tick()
    (directory / "annotated.pdf").write_bytes(b"%PDF-annotated")
    (directory / "timeline.json").write_text('{"version": 1, "notes": []}')
    return 3


class NoStoreTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        job = job_state.create("no-store-job", OWNER, "Song.pdf", OPTIONS, 4)
        storage._local_path(job["input_key"]).write_bytes(b"%PDF-source")
        job_state.ready(job["job_id"], "local")
        self.assertTrue(worker.process_job(job["job_id"], runner=fake_runner))
        self.headers = {"Authorization": f"Bearer {auth.mint_backend_token(OWNER)}"}

    def tearDown(self):
        self.client.close()
        db.delete_annotation_job("no-store-job")
        db.delete_music_sheet("no-store-job")

    def test_sheet_files_are_never_cached(self):
        for path in ("", "/assets", "/timeline", "/download?inline=1", "/original"):
            with self.subTest(path=path):
                response = self.client.get(f"/api/sheets/no-store-job{path}", headers=self.headers)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.headers["cache-control"], "no-store")

    def test_refusals_are_not_cached_either(self):
        response = self.client.get("/api/sheets/no-store-job/timeline")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.headers["cache-control"], "no-store")


if __name__ == "__main__":
    unittest.main()
