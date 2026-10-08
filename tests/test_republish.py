"""A job records when it ended (finished_at), and a hand republish
(republish.py) leaves its own trace instead of only moving updated_at.
Local (in-memory) mode, like test_reuse.py.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import db
import job_state
import processed_sheets
import republish
import storage
import worker
from processor import InvalidSheet

ALICE = "84848484-8484-4848-8484-848484848484"
OPTIONS = {"style": "unicode", "octave": False, "notation": "letters", "font_size": 6.5, "dpi": None,
           "auto_retry": True, "color": "#000000"}


def fake_runner(job, directory, tick=None):
    (directory / "annotated.pdf").write_bytes(b"%PDF read")
    (directory / "timeline.json").write_text('{"version": 1, "measures": []}')
    (directory / "labels.json").write_text(json.dumps({"notation": job["notation"]}))
    return {"count": 7, "notes_named": 30, "notes_printed": 32}


def unreadable(job, directory, tick):
    raise InvalidSheet("No music notation was detected.")


class RepublishTests(unittest.TestCase):
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

    def _forget_jobs(self):
        for job_id in self.jobs:
            db.delete_annotation_job(job_id)
            db.delete_music_sheet(job_id)

    def processed(self, job_id, runner=fake_runner):
        job = job_state.create(job_id, ALICE, "Sonata.pdf", OPTIONS, 9)
        self.jobs.append(job_id)
        storage._local_path(job["input_key"]).write_bytes(b"%PDF-1.4 ")
        self.assertEqual(worker.accept_input(job_id)["status"], "queued")
        worker.process_job(job_id, runner=runner)
        return db.get_annotation_job(job_id)

    def test_a_finished_job_records_when_it_finished(self):
        job = self.processed("rp-done")
        self.assertEqual(job["status"], "done")
        self.assertGreaterEqual(job["finished_at"], job["queued_at"])

    def test_a_failed_job_records_when_it_finished(self):
        job = self.processed("rp-unreadable", runner=unreadable)
        self.assertEqual(job["status"], "failed")
        self.assertGreaterEqual(job["finished_at"], job["queued_at"])

    def test_a_job_failed_outside_a_worker_records_when_it_finished(self):
        job = job_state.create("rp-expired", ALICE, "Sonata.pdf", OPTIONS, 9)
        self.jobs.append("rp-expired")
        self.assertTrue(job_state.fail(job, {"status": "uploading"}, "Upload expired."))
        self.assertIn("finished_at", db.get_annotation_job("rp-expired"))

    def test_a_failed_sheet_republished_is_done_and_says_so(self):
        failed = self.processed("rp-failed", runner=unreadable)
        with patch("builtins.print") as printed:
            job = republish.republish("rp-failed", runner=fake_runner, reason="photo fix")
        self.assertEqual((job["status"], job["error"], job["labeled_groups"]), ("done", None, 7))
        self.assertEqual(job["republished_from"], None)
        self.assertGreaterEqual(job["republished_at"], failed["finished_at"])
        # When the reader got their answer is not rewritten by the republish.
        self.assertEqual(job["finished_at"], failed["finished_at"])
        self.assertEqual(storage._local_path(job["output_key"]).read_bytes(), b"%PDF read")
        event = json.loads(printed.call_args.args[0])
        self.assertEqual((event["event"], event["previous_status"], event["reason"]),
                         ("job_republished", "failed", "photo fix"))

    def test_republishing_keeps_the_earlier_attempt_for_rollback(self):
        before = self.processed("rp-again")
        with patch("builtins.print"):
            job = republish.republish("rp-again", runner=fake_runner)
        self.assertNotEqual(job["output_key"], before["output_key"])
        self.assertEqual(job["republished_from"], before["output_key"])
        self.assertTrue(storage._local_path(before["output_key"]).exists())

    def test_a_dry_run_publishes_nothing(self):
        before = self.processed("rp-dry", runner=unreadable)
        with patch("builtins.print"):
            republish.republish("rp-dry", runner=fake_runner, dry_run=True)
        self.assertEqual(db.get_annotation_job("rp-dry"), before)

    def test_a_sheet_a_reader_edited_is_refused_unless_allowed(self):
        before = self.processed("rp-edited")
        storage.write_edits(before, ALICE, b"{}")
        with self.assertRaises(republish.Refused):
            republish.republish("rp-edited", runner=fake_runner)
        self.assertEqual(db.get_annotation_job("rp-edited"), before)
        with patch("builtins.print"):
            self.assertIn("republished_at", republish.republish("rp-edited", runner=fake_runner, allow_edits=True))

    def test_a_sheet_still_being_read_is_refused(self):
        job = job_state.create("rp-uploading", ALICE, "Sonata.pdf", OPTIONS, 9)
        self.jobs.append("rp-uploading")
        with self.assertRaises(republish.Refused):
            republish.republish("rp-uploading", runner=fake_runner)

    def test_a_sheet_deleted_meanwhile_is_left_alone(self):
        self.processed("rp-raced")

        def deleted_meanwhile(job, directory):
            job_state.change("rp-raced", {"status": "done"}, status="deleting")
            return fake_runner(job, directory)

        with self.assertRaises(republish.Refused):
            republish.republish("rp-raced", runner=deleted_meanwhile)
        job = db.get_annotation_job("rp-raced")
        self.assertEqual(job["status"], "deleting")
        self.assertNotIn("republished_at", job)


if __name__ == "__main__":
    unittest.main()
