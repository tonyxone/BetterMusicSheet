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
import run
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
            # ...and says why, for the worker's attempt log.
            crash = json.loads((directory / "result.json").read_text())["crash"]
            self.assertEqual(crash, "RuntimeError: Audiveris died")

    def test_an_audiveris_crash_is_described_from_its_own_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "options.json").write_text("{}")
            (directory / "work").mkdir()
            (directory / "work" / "input-20261004T1721.log").write_text(
                "INFO  [input#2]  StepMonitoring 98 | LINKS\n" + STUB_CRASH + "\njava.util.concurrent.ExecutionException: ...\n")
            failure = subprocess.CalledProcessError(1, ["java"])
            with patch.object(processor, "generate", side_effect=failure):
                with self.assertRaises(subprocess.CalledProcessError):
                    processor.main(directory)
            crash = json.loads((directory / "result.json").read_text())["crash"]
            self.assertIn("[input#2]", crash)
            self.assertIn("no such edge in graph: Exclusion", crash)


STUB_CRASH = ("WARN  [input#2]                      Book 2044 | Error processing stub "
              "java.lang.RuntimeException: java.lang.IllegalArgumentException: no such edge in graph: Exclusion")


SHEET_REMOVED = ("WARN  [input#1]                 SheetStub 411  | input#1   With a too low interline value of 7 pixels,  "
                 "either this sheet contains no multi-line staves,  or the picture resolution is too low (try 300 DPI).\n"
                 "WARN  [input#1]                      Book 2044 | Error processing stub "
                 "org.audiveris.omr.step.StepException: Sheet removed\n")


class CrashRerunTests(unittest.TestCase):
    """A page crash that comes and goes between runs of the same file is read
    again at once, rather than costing a whole job attempt and its wait."""

    def setUp(self):
        import pymupdf
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name)
        self.pdf = self.work / "input.pdf"
        with pymupdf.open() as doc:
            for _ in range(3):
                doc.new_page()
            doc.save(self.pdf)

    def tearDown(self):
        self.tmp.cleanup()

    def audiveris(self, *outcomes):
        """A run_audiveris stand-in: each call writes its own log, then
        crashes with that log line, splits into movements, or succeeds."""
        calls = iter(outcomes)
        self.runs, self.sheets = [], []

        def fake(pdf_path, out_dir, dpi=None, sheets=None, constants=None):
            self.runs.append((dpi, constants))
            self.sheets.append(sheets)
            outcome = next(calls)
            (out_dir / "input.omr").write_text("partial book")
            if outcome == "ok":
                (out_dir / "input-1.log").write_text("all good")
                return out_dir / "input.mxl", out_dir / "input.omr"
            if outcome == "movements":
                raise run.SplitIntoMovements("split")
            (out_dir / "input-1.log").write_text(outcome)
            raise subprocess.CalledProcessError(1, ["java"])
        return fake

    def recognize(self, *outcomes):
        log = []
        with patch.object(run, "run_audiveris", side_effect=self.audiveris(*outcomes)) as calls,                 patch.object(run, "number_pages") as self.numbered:
            try:
                return run.recognize_book(self.pdf, self.work, log=log.append), calls.call_count, log
            except (subprocess.CalledProcessError, run.SplitIntoMovements):
                return None, calls.call_count, log

    def test_a_page_crash_is_read_again_at_once(self):
        result, calls, log = self.recognize(STUB_CRASH, STUB_CRASH, "ok")
        self.assertEqual(result, (self.work / "input.mxl", self.work / "input.omr", None))
        self.assertEqual(calls, 3)
        self.assertIn("reading the sheet again (2 of 2)", log[-1])

    def test_a_page_that_keeps_crashing_is_left_out(self):
        result, calls, log = self.recognize(STUB_CRASH, STUB_CRASH, STUB_CRASH, "ok")
        self.assertEqual(calls, 2 + run.CRASH_RERUNS)
        self.assertEqual(self.sheets, [None, None, None, [1, 3]])
        self.assertIn("No music could be read on page 2", log[-1])
        self.numbered.assert_called_once_with(self.work / "input.mxl", [1, 3])
        self.assertIsNotNone(result)

    def test_a_crash_on_every_page_is_still_a_crash(self):
        everywhere = "\n".join(STUB_CRASH.replace("input#2", f"input#{page}") for page in (1, 2, 3))
        result, calls, _ = self.recognize(everywhere, everywhere, everywhere)
        self.assertIsNone(result)
        self.assertEqual(calls, 1 + run.CRASH_RERUNS)

    def test_any_other_failure_is_not_rerun(self):
        result, calls, _ = self.recognize("java.lang.OutOfMemoryError", "ok")
        self.assertIsNone(result)
        self.assertEqual(calls, 1)

    def test_a_long_book_leaves_the_rerun_to_the_job_retry(self):
        with patch.object(run.time, "monotonic", side_effect=[0, run.CRASH_RERUN_BUDGET_SECONDS]):
            result, calls, _ = self.recognize(STUB_CRASH, "ok")
        self.assertIsNone(result)
        self.assertEqual(calls, 1)

    def test_a_page_with_no_music_is_left_out_not_rerun(self):
        # A cover picture: Audiveris drops it, then refuses to export the book.
        result, calls, _ = self.recognize(SHEET_REMOVED.replace("too low interline", "too high interline"), "ok")
        self.assertEqual(calls, 2)
        self.assertEqual(self.sheets, [None, [2, 3]])
        self.assertIsNotNone(result)

    def test_a_book_with_no_page_of_music_is_not_music(self):
        nothing = "\n".join(SHEET_REMOVED.replace("too low interline", "too high interline")
                            .replace("input#1", f"input#{page}") for page in (1, 2, 3))
        with self.assertRaises(run.NotMusic):
            self.recognize(nothing)

    def test_too_coarse_a_page_is_read_again_finer(self):
        result, calls, log = self.recognize(SHEET_REMOVED, "ok")
        self.assertEqual(result, (self.work / "input.mxl", self.work / "input.omr", 700))
        self.assertEqual([dpi for dpi, _ in self.runs], [None, 700])
        self.assertIn("700 DPI", log[-1])

    def test_a_page_still_too_coarse_at_the_limit_is_left_out(self):
        result, calls, _ = self.recognize(SHEET_REMOVED.replace("of 7 pixels", "of 3 pixels"),
                                          SHEET_REMOVED.replace("of 7 pixels", "of 5 pixels"), "ok")
        self.assertEqual([dpi for dpi, _ in self.runs], [None, run.MAX_UPSCALE_DPI, run.MAX_UPSCALE_DPI])
        self.assertEqual(self.sheets[-1], [2, 3])
        self.assertIsNotNone(result)

    def test_a_book_split_into_movements_is_read_as_one_piece(self):
        result, calls, _ = self.recognize("movements", "ok")
        self.assertEqual(result, (self.work / "input.mxl", self.work / "input.omr", None))
        self.assertEqual([constants for _, constants in self.runs], [None, run.NO_MOVEMENTS])

    def test_every_read_allows_a_two_digit_time_signature(self):
        # Without it Audiveris skips a 12/8 and loses the chords past 4/4.
        with patch.object(run.subprocess, "run") as audiveris:
            with self.assertRaises(RuntimeError):  # the stand-in writes no output
                run.run_audiveris(self.pdf, self.work, constants=run.NO_MOVEMENTS)
        cmd = audiveris.call_args.args[0]
        self.assertIn("org.audiveris.omr.sheet.time.TimeBuilder.maxTimeWidth=3", cmd)
        self.assertIn("org.audiveris.omr.sheet.SystemManager.minIndentation=1000", cmd)

    def test_movements_are_given_up_on_after_one_more_read(self):
        result, calls, _ = self.recognize("movements", "movements", "ok")
        self.assertIsNone(result)
        self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
