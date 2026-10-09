"""A sheet is readable as soon as its upload finishes: the original can be
shown, marked up and downloaded while the note names are worked out, and
after that failed. A failed sheet keeps its upload and can be read again
(POST /api/sheets/{id}/retry) - no deleting and uploading anew. Local
(in-memory) mode, like test_delete_sheet.py.
"""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import auth
import db
import job_state
import processor
import server
import storage

USER = "12121212-1212-4121-8121-121212121212"
OTHER = "34343434-3434-4343-8343-343434343434"
OPTIONS = {"style": "unicode", "octave": False, "font_size": 6.5, "dpi": None, "auto_retry": True, "color": "#000000"}


def signed_in(user_id=USER):
    return {"Authorization": f"Bearer {auth.mint_backend_token(user_id)}"}


class ReadableBeforeNamesTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)
        # Retrying hands the job to the local worker thread; not here.
        enqueue = patch.object(server, "enqueue_local")
        self.enqueued = enqueue.start()
        self.addCleanup(enqueue.stop)
        # Premium, so the free plan's one-sheet limit stays out of the way
        # except where a test asks for it.
        premium = patch.object(server, "get_entitlement", return_value={"tier": "premium"})
        self.entitlement = premium.start()
        self.addCleanup(premium.stop)

    def seed(self, job_id, status="failed", user_id=USER, uploaded=True):
        job = job_state.create(job_id, user_id, "Song.pdf", OPTIONS, 9)
        self.addCleanup(db.delete_annotation_job, job_id)
        self.addCleanup(db.delete_music_sheet, job_id)
        if uploaded:
            storage._local_path(job["input_key"]).write_bytes(b"%PDF-1.4")
            job_state.ready(job_id, "local")
        if status == "failed":
            job_state.fail(db.get_annotation_job(job_id), {}, job_state.UNREADABLE)
        return db.get_annotation_job(job_id)

    def test_a_queued_sheet_shows_its_original_and_takes_edits(self):
        self.seed("queued-1", status="queued")
        status = self.client.get("/api/sheets/queued-1", headers=signed_in()).json()
        self.assertEqual((status["status"], status["original_ready"], status["can_retry"]), ("queued", True, False))
        assets = self.client.get("/api/sheets/queued-1/assets", headers=signed_in()).json()
        self.assertEqual((assets["pdf"], assets["timeline"], assets["labels"]), (None, None, None))
        self.assertEqual(self.client.get(assets["original"], headers=signed_in()).content, b"%PDF-1.4")
        revision = self.client.get("/api/sheets/queued-1/edits", headers=signed_in()).json()["revision"]
        saved = self.client.put("/api/sheets/queued-1/edits", headers=signed_in(),
                                json={"revision": revision, "doc": {"version": 1}})
        self.assertEqual(saved.status_code, 200)

    def test_a_failed_sheet_stays_readable_and_can_be_tried_again(self):
        self.seed("failed-1")
        status = self.client.get("/api/sheets/failed-1", headers=signed_in()).json()
        self.assertEqual((status["original_ready"], status["can_retry"], status["error"]),
                         (True, True, job_state.UNREADABLE))
        self.assertEqual(self.client.get("/api/sheets/failed-1/original", headers=signed_in()).status_code, 200)
        retried = self.client.post("/api/sheets/failed-1/retry", headers=signed_in())
        self.assertEqual(retried.status_code, 202)
        job = retried.json()
        self.assertEqual((job["status"], job["attempt_count"], job["error"]), ("queued", 0, None))
        self.enqueued.assert_called_once_with("failed-1")
        # Only a failed sheet waits for a retry - a second click is refused.
        self.assertEqual(self.client.post("/api/sheets/failed-1/retry", headers=signed_in()).status_code, 409)

    def test_an_upload_that_never_finished_has_nothing_to_retry(self):
        self.seed("expired-1", uploaded=False)
        job_state.fail(db.get_annotation_job("expired-1"), {"status": "uploading"}, "Upload expired.")
        status = self.client.get("/api/sheets/expired-1", headers=signed_in()).json()
        self.assertEqual((status["original_ready"], status["can_retry"]), (False, False))
        self.assertEqual(self.client.get("/api/sheets/expired-1/assets", headers=signed_in()).status_code, 409)
        self.assertEqual(self.client.post("/api/sheets/expired-1/retry", headers=signed_in()).status_code, 409)

    def test_one_sheet_in_progress_at_a_time(self):
        self.seed("failed-2")
        self.seed("busy-1", status="queued")
        response = self.client.post("/api/sheets/failed-2/retry", headers=signed_in())
        self.assertEqual(response.status_code, 409)
        self.assertEqual(db.get_annotation_job("failed-2")["status"], "failed")

    def test_the_free_plan_limit_still_applies(self):
        self.entitlement.return_value = {"tier": "free"}
        self.seed("failed-3")
        self.seed("kept-1", status="queued")
        job_state.change("kept-1", {}, status="done")
        self.assertEqual(self.client.post("/api/sheets/failed-3/retry", headers=signed_in()).status_code, 403)

    def test_only_the_signed_in_owner_can_retry(self):
        self.seed("failed-4")
        self.assertEqual(self.client.post("/api/sheets/failed-4/retry").status_code, 401)
        self.assertEqual(self.client.post("/api/sheets/failed-4/retry", headers={"X-Guest-Id": USER}).status_code, 401)
        self.assertEqual(self.client.post("/api/sheets/failed-4/retry", headers=signed_in(OTHER)).status_code, 404)


class NotMusicTests(unittest.TestCase):
    """"No music notation was detected" is a final answer the reader sees,
    not a crash that is retried three times behind a generic message."""

    def test_not_music_is_reported_to_the_reader(self):
        from run import NOT_MUSIC_MESSAGE, NotMusic
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "options.json").write_text("{}")
            with patch.object(processor, "generate", side_effect=NotMusic(NOT_MUSIC_MESSAGE)):
                self.assertEqual(processor.main(directory), 2)
            result = json.loads((directory / "result.json").read_text())
        self.assertEqual(result, {"error": NOT_MUSIC_MESSAGE, "permanent": True})

    def test_a_finished_run_reports_its_counts(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "options.json").write_text("{}")
            counts = {"count": 7, "notes_named": 606, "notes_printed": 634}
            with patch.object(processor, "generate", return_value=counts):
                self.assertEqual(processor.main(directory), 0)
            self.assertEqual(json.loads((directory / "result.json").read_text()), counts)

    def test_a_real_crash_still_propagates_to_be_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "options.json").write_text("{}")
            with patch.object(processor, "generate", side_effect=RuntimeError("Audiveris died")):
                with self.assertRaises(RuntimeError):
                    processor.main(directory)


if __name__ == "__main__":
    unittest.main()


class AudiverisCrashTests(unittest.TestCase):
    """Audiveris sometimes crashes deterministically (a NullPointerException in
    its STEMS step on a phone photo). Read again at other resolutions, and if
    all crash, fail at once instead of retrying the identical job."""

    def crash(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "input-1.log").write_text("WARN Book 2044 | Error processing stub java.lang.RuntimeException")
        raise subprocess.CalledProcessError(1, "java")

    def annotate(self, runner, directory):
        import run
        pdf = directory / "input.pdf"
        pdf.write_bytes(b"")
        with patch.object(run, "run_audiveris", side_effect=runner), \
                patch.object(run.page_size, "shrink_oversized", return_value=(pdf, {})), \
                patch.object(run, "count_pages", return_value=1), \
                patch.object(run, "has_any_staff", side_effect=RuntimeError("past recognition")):
            return run.annotate_pdf(pdf, directory / "out.pdf", directory / "work", log=lambda m: None)

    def test_a_crash_is_read_again_at_another_resolution(self):
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)

            def runner(pdf, out_dir, dpi=None, **kwargs):
                calls.append(dpi)
                if dpi is None:
                    self.crash(out_dir)
                return out_dir / "a.mxl", out_dir / "a.omr"

            with self.assertRaisesRegex(RuntimeError, "past recognition"):
                self.annotate(runner, directory)
        self.assertEqual(calls, [None, 220])

    def test_every_resolution_crashing_is_a_final_answer(self):
        import run
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)

            def runner(pdf, out_dir, dpi=None, **kwargs):
                calls.append(dpi)
                self.crash(out_dir)

            with self.assertRaises(run.Unreadable):
                self.annotate(runner, directory)
        self.assertEqual(calls, [None, *run.CRASH_FALLBACK_DPIS])

    def test_an_unrelated_failure_is_still_retried_as_a_crash(self):
        with tempfile.TemporaryDirectory() as temporary:
            def runner(pdf, out_dir, dpi=None, **kwargs):
                raise subprocess.CalledProcessError(1, "java")

            with self.assertRaises(subprocess.CalledProcessError):
                self.annotate(runner, Path(temporary))

    def test_unreadable_is_reported_to_the_reader(self):
        import run
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "options.json").write_text("{}")
            with patch.object(processor, "generate", side_effect=run.Unreadable(run.UNREADABLE_MESSAGE)):
                self.assertEqual(processor.main(directory), 2)
            result = json.loads((directory / "result.json").read_text())
        self.assertEqual(result, {"error": run.UNREADABLE_MESSAGE, "permanent": True})
