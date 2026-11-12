"""A sheet's title: named when it is uploaded, renamed later, and only ever
shown - the uploaded filename (sheet_name), which the stored files are found
and typed by, never changes. Runs in local (non-serverless) mode, like
test_upload_requires_sign_in.py.
"""
import unittest
import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient

import auth
import db
import job_state
import server
from config import DEMO_JOB_ID

OPTIONS = {"style": "unicode", "octave": False, "font_size": 6.5, "dpi": None, "auto_retry": True, "color": "#000000"}


class SheetTitleTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.user = str(uuid.uuid4())

    def tearDown(self):
        self.client.close()

    def signed_in(self, user_id=None):
        return {"Authorization": f"Bearer {auth.mint_backend_token(user_id or self.user)}"}

    def sheet(self, filename="IMG_0412.jpg", user_id=None, **options):
        """A sheet of the reader's own, as an upload reserves it."""
        job = job_state.create(uuid.uuid4().hex, user_id or self.user, filename, {**OPTIONS, **options}, 10)
        self.addCleanup(db.delete_annotation_job, job["job_id"])
        self.addCleanup(db.delete_music_sheet, job["music_sheet_id"])
        return job

    def upload(self, filename="Scan.jpg", **form):
        files = {"file": (filename, b"\xff\xd8\xff photo", "image/jpeg")}
        with patch.object(server, "enqueue_local"), patch.object(server, "_daily_sheet_limit", return_value=None):
            response = self.client.post("/api/sheets", files=files, data=form, headers=self.signed_in())
        self.assertEqual(response.status_code, 202, response.text)
        job_id = response.json()["job_id"]
        self.addCleanup(db.delete_annotation_job, job_id)
        self.addCleanup(db.delete_music_sheet, response.json()["music_sheet_id"])
        return job_id

    def rename(self, job_id, title, headers=None):
        return self.client.put(f"/api/sheets/{job_id}/title", json={"title": title},
                               headers=self.signed_in() if headers is None else headers)

    # ---- naming on upload ----

    def test_an_upload_keeps_the_title_it_was_given(self):
        job_id = self.upload("Scan.jpg", title="Clair de Lune")
        status = self.client.get(f"/api/sheets/{job_id}", headers=self.signed_in()).json()
        self.assertEqual(status["title"], "Clair de Lune")
        # The file is still known by the name it was uploaded with.
        self.assertEqual(status["sheet_name"], "Scan.jpg")
        listed = self.client.get("/api/sheets", headers=self.signed_in()).json()
        self.assertEqual([job["title"] for job in listed if job["job_id"] == job_id], ["Clair de Lune"])

    def test_an_upload_without_a_title_is_called_by_its_filename(self):
        job_id = self.upload("Menuet in G.jpg")
        status = self.client.get(f"/api/sheets/{job_id}", headers=self.signed_in()).json()
        self.assertEqual(status["title"], "Menuet in G")
        self.assertNotIn("title", db.get_annotation_job(job_id))

    def test_a_blank_title_on_upload_counts_as_none(self):
        job_id = self.upload("Menuet in G.jpg", title="   ")
        self.assertEqual(self.client.get(f"/api/sheets/{job_id}", headers=self.signed_in()).json()["title"],
                         "Menuet in G")

    def test_the_direct_upload_request_takes_a_title_too(self):
        body = server.UploadRequest(filename="Scan.jpg", size=10, title="  Scan 11 Nov 2026\n")
        self.assertEqual(body.title, "Scan 11 Nov 2026")
        with patch.object(server, "_daily_sheet_limit", return_value=None):
            job = server.reserve_upload(body, self.user)
        self.addCleanup(db.delete_annotation_job, job["job_id"])
        self.addCleanup(db.delete_music_sheet, job["music_sheet_id"])
        self.assertEqual(db.get_annotation_job(job["job_id"])["title"], "Scan 11 Nov 2026")
        self.assertEqual(db.get_annotation_job(job["job_id"])["sheet_name"], "Scan.jpg")

    def test_a_title_too_long_is_refused(self):
        with self.assertRaises(ValueError):
            server.UploadRequest(filename="Scan.jpg", size=10, title="x" * (server.TITLE_MAX_LENGTH + 1))

    # ---- renaming ----

    def test_renaming_changes_the_title_and_nothing_else(self):
        job = self.sheet("IMG_0412.jpg")
        response = self.rename(job["job_id"], "  Gymnopédie   No. 1 ")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["title"], "Gymnopédie No. 1")
        self.assertEqual(response.json()["sheet_name"], "IMG_0412.jpg")
        stored = db.get_annotation_job(job["job_id"])
        self.assertEqual(stored["title"], "Gymnopédie No. 1")
        self.assertEqual(stored["sheet_name"], "IMG_0412.jpg")
        self.assertEqual(stored["status"], job["status"])
        self.assertEqual(db.get_music_sheet(job["music_sheet_id"])["sheet_name"], "IMG_0412.jpg")
        listed = self.client.get("/api/sheets", headers=self.signed_in()).json()
        self.assertEqual([j["title"] for j in listed if j["job_id"] == job["job_id"]], ["Gymnopédie No. 1"])

    def test_a_sheet_can_be_renamed_again(self):
        job = self.sheet()
        self.rename(job["job_id"], "First")
        self.assertEqual(self.rename(job["job_id"], "Second").json()["title"], "Second")

    def test_a_reader_cannot_rename_someone_elses_sheet(self):
        theirs = self.sheet(user_id=str(uuid.uuid4()), title="Theirs")
        response = self.rename(theirs["job_id"], "Mine now")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(db.get_annotation_job(theirs["job_id"])["title"], "Theirs")

    def test_renaming_needs_a_signed_in_account(self):
        job = self.sheet()
        self.assertEqual(self.rename(job["job_id"], "Anything", headers={}).status_code, 401)
        # A guest id identifies a visitor, never an account that may change a sheet.
        guest = {"X-Guest-Id": self.user}
        self.assertEqual(self.rename(job["job_id"], "Anything", headers=guest).status_code, 401)
        self.assertNotIn("title", db.get_annotation_job(job["job_id"]))

    def test_an_empty_or_overlong_name_is_refused(self):
        job = self.sheet()
        self.assertEqual(self.rename(job["job_id"], " \n\t ").status_code, 422)
        self.assertEqual(self.rename(job["job_id"], "x" * (server.TITLE_MAX_LENGTH + 1)).status_code, 422)
        self.assertEqual(self.client.put(f"/api/sheets/{job['job_id']}/title", json={},
                                         headers=self.signed_in()).status_code, 422)
        self.assertNotIn("title", db.get_annotation_job(job["job_id"]))

    def test_a_deleted_or_missing_sheet_cannot_be_renamed(self):
        job = self.sheet()
        self.assertEqual(self.client.delete(f"/api/sheets/{job['job_id']}", headers=self.signed_in()).status_code, 204)
        self.assertEqual(self.rename(job["job_id"], "Back again").status_code, 404)
        self.assertEqual(self.rename("no-such-job", "Anything").status_code, 404)

    def test_the_demo_sheet_cannot_be_renamed(self):
        self.assertEqual(self.rename(DEMO_JOB_ID, "Mine").status_code, 403)

    # ---- what a title becomes ----

    def test_control_characters_never_reach_a_title(self):
        self.assertEqual(server.clean_title("Line one\r\nLine two\x00\x07"), "Line one Line two")
        self.assertEqual(server.clean_title("夏日漱石 🎹"), "夏日漱石 🎹")
        self.assertIsNone(server.clean_title(" 　 "))
        self.assertIsNone(server.clean_title(None))

    def test_a_sheet_without_a_title_is_called_by_its_filename_stem(self):
        self.assertEqual(server.sheet_title({"sheet_name": "Für Elise.pdf"}), "Für Elise")
        self.assertEqual(server.sheet_title({"title": "Bagatelle", "sheet_name": "Für Elise.pdf"}), "Bagatelle")
        # A legacy row has its name only on the sheet row.
        self.assertEqual(server.sheet_title({}, "Old upload.pdf"), "Old upload")
        self.assertIsNone(server.sheet_title({}))

    def test_downloads_are_named_after_the_title(self):
        job = {"title": "Scan 11 Nov 2026", "sheet_name": "Scan.pdf"}
        self.assertIn("Scan%2011%20Nov%202026.mxl", server._musicxml_disposition(job))
        self.assertIn('filename="Scan 11 Nov 2026.mxl"', server._musicxml_disposition(job))
        self.assertIn('filename="Menuet.mxl"', server._musicxml_disposition({"sheet_name": "Menuet.pdf"}))


if __name__ == "__main__":
    unittest.main()
