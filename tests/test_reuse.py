"""The same file uploaded again reuses what was made from it (see
processed_sheets.py): copied when the settings match, only drawn again when
they don't, and never once every sheet made from it is deleted. Local
(in-memory) mode, like test_delete_sheet.py; test_serverless.py covers the
same through DynamoDB and S3.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import auth
import config
import controller
import db
import job_state
import processed_sheets
import run
import server
import storage
import worker

ALICE = "51515151-5151-4515-8515-515151515151"
BOB = "62626262-6262-4626-8626-626262626262"
CAROL = "73737373-7373-4737-8737-737373737373"
OPTIONS = {"style": "unicode", "octave": False, "notation": "letters", "font_size": 6.5, "dpi": None,
           "auto_retry": True, "color": "#000000"}
SHEET = b"%PDF-1.4 the same sheet"


def fake_runner(job, directory, tick):
    """What processor.py leaves behind, marked with the settings it used and
    whether it only drew the names again."""
    redrawn = (directory / "reuse" / "notes.json").exists()
    (directory / "annotated.pdf").write_bytes(f"%PDF {job['notation']} {job['color']}".encode())
    (directory / "timeline.json").write_text('{"version": 1, "notes": []}')
    (directory / "labels.json").write_text(json.dumps({"notation": job["notation"]}))
    (directory / "notes.json").write_text('{"version": 1}')
    return {"count": 7, "notes_named": 30, "notes_printed": 32, "redrawn": redrawn}


class ReuseCase(unittest.TestCase):
    """Uploads into a fresh local store, and helpers to read them."""

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

    def upload(self, job_id, user, data=SHEET, name="Sonata.pdf", **settings):
        job = job_state.create(job_id, user, name, {**OPTIONS, **settings}, len(data))
        self.jobs.append(job_id)
        storage._local_path(job["input_key"]).write_bytes(data)
        return worker.accept_input(job_id)

    def processed(self, job_id, user, **settings):
        self.assertEqual(self.upload(job_id, user, **settings)["status"], "queued")
        self.assertTrue(worker.process_job(job_id, runner=fake_runner))
        return db.get_annotation_job(job_id)

    def read(self, job, kind):
        return storage._local_path(job[f"{kind}_key"]).read_bytes()


class ReuseTests(ReuseCase):
    def test_every_upload_records_the_hash_of_its_file(self):
        job = self.upload("hash-1", ALICE)
        self.assertEqual(job["content_sha256"], __import__("hashlib").sha256(SHEET).hexdigest())

    def test_the_same_file_from_someone_else_under_another_name_is_copied_at_once(self):
        first = self.processed("first", ALICE)
        second = self.upload("second", BOB, name="My homework.pdf")

        self.assertEqual(second["status"], "done")
        self.assertEqual(second["reused_from"], "first")
        self.assertEqual(second["stage"], "Complete")
        self.assertEqual((second["labeled_groups"], second["notes_named"], second["notes_printed"]), (7, 30, 32))
        # Copies in the new sheet's own files, so either can be deleted alone.
        for kind in storage.REUSABLE:
            self.assertTrue(second[f"{kind}_key"].startswith(f"jobs/{BOB}/second/"))
            self.assertEqual(self.read(second, kind), self.read(first, kind))
        # Its upload slot is free again for Bob's next sheet.
        job_state.create("bobs-next", BOB, "Next.pdf", OPTIONS, 1)
        self.jobs.append("bobs-next")
        # The name is Bob's own, wherever it is shown.
        self.assertEqual(server.job_status("second", BOB)["sheet_name"], "My homework.pdf")

    def test_a_different_file_is_read_as_usual(self):
        self.processed("first", ALICE)
        other = self.upload("other", BOB, data=b"%PDF-1.4 another sheet")
        self.assertEqual(other["status"], "queued")
        self.assertNotIn("redraw_from", other)

    def test_other_names_are_only_drawn_again(self):
        self.processed("first", ALICE)
        second = self.upload("second", BOB, notation="numbers", color="#FF0000")
        self.assertEqual(second["status"], "queued")
        self.assertEqual(second["redraw_from"], "first")

        seen = {}

        def runner(job, directory, tick):
            seen["notes"] = (directory / "reuse" / "notes.json").read_text()
            seen["timeline"] = (directory / "reuse" / "timeline.json").exists()
            return fake_runner(job, directory, tick)

        self.assertTrue(worker.process_job("second", runner=runner))
        second = db.get_annotation_job("second")
        self.assertEqual(seen, {"notes": '{"version": 1}', "timeline": True})
        self.assertEqual(second["status"], "done")
        self.assertEqual(second["reused_from"], "first")
        self.assertEqual(self.read(second, "output"), b"%PDF numbers #FF0000")
        # And now that one is just as good a source as the first.
        self.assertEqual(len(processed_sheets._rows), 2)

    def test_a_third_upload_copies_whichever_sheet_has_its_settings(self):
        self.processed("first", ALICE)
        self.processed("second", BOB, notation="solfege")
        third = self.upload("third", CAROL, notation="solfege")
        self.assertEqual(third["status"], "done")
        self.assertEqual(third["reused_from"], "second")

    def test_a_different_reading_is_no_match(self):
        self.processed("first", ALICE)
        for job_id, settings in (("dpi", {"dpi": 400}), ("no-retry", {"auto_retry": False})):
            job = self.upload(job_id, BOB, **settings)
            self.assertEqual(job["status"], "queued")
            self.assertNotIn("redraw_from", job)
            job_state.fail(job, {"status": "queued"}, "test")

    def test_results_from_before_a_recognition_fix_are_not_reused(self):
        self.processed("first", ALICE)
        with patch.object(config, "CACHE_EPOCH", config.CACHE_EPOCH + 1):
            self.assertEqual(self.upload("second", BOB)["status"], "queued")

    def test_deleting_the_only_sheet_forgets_the_file(self):
        self.processed("first", ALICE)
        server.delete_job("first", ALICE)
        self.assertEqual(processed_sheets._rows, {})
        self.assertEqual(self.upload("second", BOB)["status"], "queued")

    def test_a_copy_outlives_the_sheet_it_was_copied_from(self):
        self.processed("first", ALICE)
        second = self.upload("second", BOB)
        server.delete_job("first", ALICE)
        self.assertEqual(self.read(second, "output"), b"%PDF letters #000000")
        third = self.upload("third", CAROL)
        self.assertEqual((third["status"], third["reused_from"]), ("done", "second"))

    def test_files_that_cannot_be_copied_mean_reading_it_again(self):
        first = self.processed("first", ALICE)
        storage.delete_job_files(first)
        second = self.upload("second", BOB)
        self.assertEqual(second["status"], "queued")
        self.assertNotIn("reused_from", second)

    def test_a_sheet_being_deleted_is_passed_over_and_forgotten(self):
        self.processed("first", ALICE)
        # Deleting marks the sheet first and removes its row a moment later.
        job_state.change("first", {"status": "done"}, status="deleting")
        self.assertEqual(self.upload("second", BOB)["status"], "queued")
        self.assertEqual(processed_sheets._rows, {})

    def test_a_republished_sheet_is_reused_as_republished(self):
        self.processed("first", ALICE)
        # As the manual republish does: new objects, and the job pointed at them.
        storage._local_path(f"jobs/{ALICE}/first/attempts/fixed/output").write_bytes(b"%PDF fixed")
        db.update_annotation_job("first", output_key=f"jobs/{ALICE}/first/attempts/fixed/output")
        second = self.upload("second", BOB)
        self.assertEqual(self.read(second, "output"), b"%PDF fixed")

    def test_a_sheet_deleted_while_finishing_is_never_offered(self):
        self.upload("first", ALICE)
        job_state.change("first", {"status": "queued"}, status="deleting")
        job = {**db.get_annotation_job("first"), "status": "done", "output_key": "x"}
        self.assertFalse(processed_sheets.add(job))
        self.assertEqual(processed_sheets._rows, {})

    def test_the_cleanup_sweep_forgets_the_file_too(self):
        first = self.processed("first", ALICE)
        job_state.change("first", {"status": "done"}, status="deleting", next_check_at=0)
        controller.reconcile(None, None, first["upload_expires_at"] + 1)
        self.assertEqual(processed_sheets._rows, {})

    def test_deleting_the_account_forgets_its_files(self):
        self.processed("first", ALICE)
        with patch.object(server, "delete_cognito_user"):
            client = TestClient(server.app)
            self.addCleanup(client.close)
            response = client.delete("/api/me",
                                     headers={"Authorization": f"Bearer {auth.mint_backend_token(ALICE)}"})
        self.assertEqual(response.status_code, 204)
        self.assertEqual(processed_sheets._rows, {})

    def test_a_failed_hash_only_costs_the_reuse(self):
        self.processed("first", ALICE)
        with patch.object(storage, "content_sha256", side_effect=OSError("disk")):
            second = self.upload("second", BOB)
        self.assertEqual(second["status"], "queued")
        self.assertNotIn("content_sha256", second)

    def test_the_local_upload_route_reuses_too(self):
        self.processed("first", ALICE)
        client = TestClient(server.app)
        self.addCleanup(client.close)
        with patch.object(server, "enqueue_local") as enqueue, \
                patch.object(server, "get_entitlement", return_value={"tier": "premium"}):
            response = client.post("/api/sheets", files={"file": ("Copy.pdf", SHEET, "application/pdf")},
                                   data={"notation": "letters"},
                                   headers={"Authorization": f"Bearer {auth.mint_backend_token(BOB)}"})
        self.assertEqual(response.status_code, 202, response.text)
        self.jobs.append(response.json()["job_id"])
        self.assertEqual(response.json()["status"], "done")
        enqueue.assert_not_called()


class CacheFailureTests(ReuseCase):
    """Whatever goes wrong in reusing, the sheet is read the way it was
    before reuse existed - never failed, stuck or retried because of it."""

    def assert_read_normally(self, job_id, runner=fake_runner):
        job = db.get_annotation_job(job_id)
        self.assertEqual(job["status"], "queued")
        self.assertTrue(worker.process_job(job_id, runner=runner))
        job = db.get_annotation_job(job_id)
        self.assertEqual((job["status"], job.get("reused_from")), ("done", None))
        return job

    def test_a_lookup_that_fails_is_a_miss(self):
        self.processed("first", ALICE)
        with patch.object(processed_sheets, "_candidates", side_effect=RuntimeError("table gone")):
            second = self.upload("second", BOB)
        self.assertIn("content_sha256", second)
        self.assert_read_normally("second")

    def test_a_copy_that_cannot_be_finished_is_read_instead(self):
        self.processed("first", ALICE)
        with patch.object(job_state, "reused", side_effect=RuntimeError("throttled")):
            self.upload("second", BOB)
        self.assert_read_normally("second")

    def test_queueing_with_a_redraw_that_fails_queues_it_plainly(self):
        self.processed("first", ALICE)
        ready = job_state.ready

        def refuse_redraws(job_id, version, **fields):
            if "redraw_from" in fields:
                raise RuntimeError("bad field")
            return ready(job_id, version, **fields)

        with patch.object(job_state, "ready", side_effect=refuse_redraws):
            second = self.upload("second", BOB, notation="numbers")
        self.assertNotIn("redraw_from", second)
        self.assert_read_normally("second")

    def test_notes_that_cannot_be_fetched_mean_reading_the_sheet(self):
        self.processed("first", ALICE)
        self.upload("second", BOB, notation="numbers")
        seen = []

        def runner(job, directory, tick):
            seen.append((directory / "reuse").exists())
            return fake_runner(job, directory, tick)

        with patch.object(storage, "download_reused", side_effect=OSError("S3 down")):
            self.assert_read_normally("second", runner)
        self.assertEqual(seen, [False])

    def test_an_earlier_sheet_gone_by_processing_time_means_reading_it(self):
        self.processed("first", ALICE)
        self.upload("second", BOB, notation="numbers")
        server.delete_job("first", ALICE)
        self.assert_read_normally("second")

    def test_a_retry_never_redraws(self):
        self.processed("first", ALICE)
        self.upload("second", BOB, notation="numbers")
        seen = []

        def crashes_once(job, directory, tick):
            seen.append((directory / "reuse").exists())
            if len(seen) == 1:
                raise RuntimeError("processor died")
            return fake_runner(job, directory, tick)

        self.assertFalse(worker.process_job("second", runner=crashes_once))
        self.assertTrue(worker.process_job("second", runner=crashes_once))
        self.assertEqual(seen, [True, False])
        self.assertEqual(db.get_annotation_job("second")["status"], "done")

    def test_offering_a_finished_sheet_that_fails_leaves_it_done(self):
        with patch.object(processed_sheets, "_row", side_effect=RuntimeError("bad row")):
            job = self.processed("first", ALICE)
        self.assertEqual(job["status"], "done")
        self.assertEqual(processed_sheets._rows, {})

    def test_notes_that_cannot_be_kept_leave_the_sheet_done(self):
        publish = storage.publish

        def no_notes(job, kind, path):
            if kind == "notes":
                raise OSError("S3 down")
            return publish(job, kind, path)

        with patch.object(storage, "publish", side_effect=no_notes):
            job = self.processed("first", ALICE)
        self.assertEqual(job["status"], "done")
        self.assertIsNone(job["notes_key"])

    def test_a_delete_goes_ahead_when_forgetting_the_row_fails(self):
        first = self.processed("first", ALICE)
        with patch.object(processed_sheets, "discard", side_effect=RuntimeError("table gone")):
            self.assertEqual(server.delete_job("first", ALICE).status_code, 204)
        self.assertFalse(storage._local_path(first["output_key"]).exists())
        # The row left behind is passed over, and dropped, by the next lookup.
        self.assertEqual(self.upload("second", BOB)["status"], "queued")
        self.assertEqual(processed_sheets._rows, {})

    def test_a_redraw_that_fails_inside_the_processor_reads_the_sheet(self):
        import processor
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / "reuse").mkdir()
            (directory / "reuse" / "notes.json").write_text("not json")
            (directory / "reuse" / "timeline.json").write_text("{}")
            stats = {"notes_named": 1}
            self.assertIsNone(processor.redraw(directory / "input.pdf", directory, OPTIONS, lambda _: None, stats))
            self.assertEqual(stats, {})
            self.assertEqual(sorted(p.name for p in directory.iterdir()), ["reuse"])


class SavedNotesTests(unittest.TestCase):
    def test_page_and_staff_numbers_survive_the_round_trip(self):
        resolved = {"pages": {1: {"regions": [], "notes": [], "tempo_events": [],
                                  "staff_lines_pt": {1: [10.0, 12.0], 2: [40.0, 42.0]}}},
                    "notes": [{"page": 1, "staff": 2, "bbox_pt": [1, 2, 3, 4]}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "notes.json"
            run.save_notes(path, resolved, [{"page": 1, "x": 1, "y": 2, "w": 3}])
            saved = run.load_notes(path)
        self.assertEqual(saved["resolved"], resolved)
        self.assertEqual(saved["unnamed"], [{"page": 1, "x": 1, "y": 2, "w": 3}])
        self.assertIsNone(saved["timeline"])

    def test_notes_saved_in_another_shape_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "notes.json"
            path.write_text('{"version": 0, "resolved": {}}')
            with self.assertRaises(ValueError):
                run.load_notes(path)


if __name__ == "__main__":
    unittest.main()
