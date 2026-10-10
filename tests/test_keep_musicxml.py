"""A finished sheet keeps Audiveris's reading beside it - the MusicXML a
reader can download, and the .omr book - stored after the sheet is done, on
a thread of its own, so it can neither hold up nor fail the sheet. Local
(in-memory) mode, like test_republish.py.
"""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import auth
import db
import job_state
import processed_sheets
import republish
import server
import storage
import worker

ALICE = "85858585-8585-4858-8585-858585858585"
OPTIONS = {"style": "unicode", "octave": False, "notation": "letters", "font_size": 6.5, "dpi": None,
           "auto_retry": True, "color": "#000000"}


def reading_runner(job, directory, tick=None):
    """processor.py's output, with the book Audiveris left in work/."""
    (directory / "annotated.pdf").write_bytes(b"%PDF read")
    (directory / "timeline.json").write_text('{"version": 1, "measures": []}')
    (directory / "work").mkdir()
    (directory / "work" / "input.mxl").write_bytes(b"PK musicxml")
    (directory / "work" / "input.omr").write_bytes(b"PK omr book")
    return {"count": 7, "notes_named": 30, "notes_printed": 32,
            "recognition": {"musicxml": str(Path("work") / "input.mxl"), "omr": str(Path("work") / "input.omr")}}


def wait_for_recognition():
    for thread in threading.enumerate():
        if thread.name.startswith("recognition-"):
            thread.join(10)


class KeepMusicXmlTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        local = patch.object(storage, "_LOCAL_DIR", Path(directory.name))
        local.start()
        self.addCleanup(local.stop)
        processed_sheets._rows.clear()
        self.addCleanup(processed_sheets._rows.clear)
        self.jobs = []
        self.addCleanup(self._forget_jobs)
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)

    def _forget_jobs(self):
        for job_id in self.jobs:
            db.delete_annotation_job(job_id)
            db.delete_music_sheet(job_id)

    def processed(self, job_id, runner=reading_runner):
        job = job_state.create(job_id, ALICE, "Sonata.pdf", OPTIONS, 9)
        self.jobs.append(job_id)
        storage._local_path(job["input_key"]).write_bytes(b"%PDF-1.4 ")
        worker.accept_input(job_id)
        self.assertTrue(worker.process_job(job_id, runner=runner))
        wait_for_recognition()
        return db.get_annotation_job(job_id)

    def stored(self, key):
        return storage._local_path(key).read_bytes()

    def test_a_finished_sheet_keeps_its_musicxml_and_omr(self):
        job = self.processed("keep-1")
        self.assertEqual(job["status"], "done")
        self.assertEqual(self.stored(job["musicxml_key"]), b"PK musicxml")
        self.assertEqual(self.stored(job["omr_key"]), b"PK omr book")
        # Beside the attempt that read them.
        self.assertEqual(job["musicxml_key"].rsplit("/", 1)[0], job["output_key"].rsplit("/", 1)[0])

    def test_failing_to_store_them_never_fails_the_sheet(self):
        publish = storage.publish

        def broken(job, kind, path):
            if kind == "musicxml":
                raise OSError("S3 is down")
            return publish(job, kind, path)

        with patch.object(storage, "publish", side_effect=broken):
            job = self.processed("keep-2")
        self.assertEqual(job["status"], "done")
        self.assertNotIn("musicxml_key", job)
        self.assertEqual(self.stored(job["omr_key"]), b"PK omr book")

    def test_the_sheet_is_done_before_they_are_stored(self):
        seen = []
        original = worker._store_recognition

        def store(job, output_key, kept, source_id):
            seen.append(db.get_annotation_job(job["job_id"])["status"])
            original(job, output_key, kept, source_id)

        with patch.object(worker, "_store_recognition", side_effect=store):
            self.processed("keep-3")
        self.assertEqual(seen, ["done"])

    def test_a_sheet_read_again_meanwhile_keeps_what_it_has(self):
        job = self.processed("keep-4")
        kept = Path(tempfile.mkdtemp())
        (kept / "musicxml").write_bytes(b"PK stale")
        # Stored for an attempt whose output is no longer the sheet's.
        worker._store_recognition({**job, "lease_owner": "old"}, "an earlier output", kept, None)
        self.assertEqual(self.stored(db.get_annotation_job("keep-4")["musicxml_key"]), b"PK musicxml")
        self.assertFalse(kept.exists())

    def test_a_sheet_without_a_reading_stores_nothing(self):
        def plain(job, directory, tick=None):
            (directory / "annotated.pdf").write_bytes(b"%PDF read")
            return 7
        job = self.processed("keep-5", runner=plain)
        self.assertEqual(job["status"], "done")
        self.assertNotIn("musicxml_key", job)

    def test_only_files_inside_the_job_directory_are_set_aside(self):
        with tempfile.TemporaryDirectory() as outside, tempfile.TemporaryDirectory() as inside:
            (Path(outside) / "secret").write_bytes(b"x")
            self.assertIsNone(worker.set_aside_recognition(
                {"recognition": {"musicxml": str(Path(outside) / "secret")}}, Path(inside)))

    def test_reusing_a_sheet_copies_them_and_a_missing_one_is_left_out(self):
        source = self.processed("keep-6")
        storage._local_path(source["omr_key"]).unlink()
        copy = job_state.create("keep-7", ALICE, "Sonata.pdf", OPTIONS, 9)
        self.jobs.append("keep-7")
        keys = storage.copy_reused(copy, source)
        self.assertEqual(self.stored(keys["musicxml_key"]), b"PK musicxml")
        self.assertNotIn("omr_key", keys)

    def test_a_republished_sheet_gets_its_own_reading(self):
        self.processed("keep-8")
        before = db.get_annotation_job("keep-8")["musicxml_key"]
        after = republish.republish("keep-8", runner=lambda job, directory: reading_runner(job, directory))
        self.assertNotEqual(after["musicxml_key"], before)
        self.assertEqual(self.stored(after["musicxml_key"]), b"PK musicxml")

    def test_the_musicxml_is_offered_for_download_by_sheet_name(self):
        self.processed("keep-9")
        headers = {"Authorization": f"Bearer {auth.mint_backend_token(ALICE)}"}
        assets = self.client.get("/api/sheets/keep-9/assets", headers=headers).json()
        self.assertEqual(assets["musicxml"], "/api/sheets/keep-9/musicxml")
        response = self.client.get(assets["musicxml"], headers=headers)
        self.assertEqual(response.content, b"PK musicxml")
        self.assertEqual(response.headers["content-type"], "application/vnd.recordare.musicxml")
        self.assertIn('filename="Sonata.mxl"', response.headers["content-disposition"])

    def test_a_sheet_without_one_offers_none(self):
        def plain(job, directory, tick=None):
            (directory / "annotated.pdf").write_bytes(b"%PDF read")
            return 7
        self.processed("keep-10", runner=plain)
        headers = {"Authorization": f"Bearer {auth.mint_backend_token(ALICE)}"}
        self.assertIsNone(self.client.get("/api/sheets/keep-10/assets", headers=headers).json()["musicxml"])
        self.assertEqual(self.client.get("/api/sheets/keep-10/musicxml", headers=headers).status_code, 404)


if __name__ == "__main__":
    unittest.main()
