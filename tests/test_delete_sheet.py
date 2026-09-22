import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

import config
import server
import storage
import job_state
import worker
import db


USER_ID = "11111111-1111-4111-8111-111111111111"
OPTIONS = {"style": "unicode", "octave": False, "font_size": 6.5, "dpi": None, "auto_retry": True, "color": "#000000"}


def _job(status="done", *, user_id=USER_ID, sheet_id="sheet-1", job_id="job-1"):
    return {
        "job_id": job_id,
        "user_id": user_id,
        "music_sheet_id": sheet_id,
        "status": status,
    }


def fake_runner(job, directory, tick):
    """Stands in for processor.py/Audiveris - see test_serverless.py."""
    tick()
    (directory / "annotated.pdf").write_bytes(b"%PDF-annotated")
    (directory / "timeline.json").write_text('{"version": 1, "notes": []}')
    return 5


class DeleteSheetTests(unittest.TestCase):
    def test_local_database_delete_functions_remove_both_rows(self):
        db.create_music_sheet("delete-test-sheet", USER_ID, "Delete test.pdf")
        db.create_annotation_job(
            "delete-test-job", USER_ID, "delete-test-sheet",
            "unicode", False, 6.5, None, True,
        )

        db.delete_annotation_job("delete-test-job")
        db.delete_music_sheet("delete-test-sheet")

        self.assertIsNone(db.get_annotation_job("delete-test-job"))
        self.assertIsNone(db.get_music_sheet("delete-test-sheet"))

    def test_local_storage_deletes_all_artifacts_and_tolerates_missing_files(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, "_LOCAL_DIR", Path(directory)):
            paths = [
                storage._local_path(storage._input_key(USER_ID, "Song.pdf")),
                storage._local_path(storage._output_key(USER_ID, "Song.pdf")),
                storage._local_path(storage._timeline_key(USER_ID, "Song.pdf")),
            ]
            for path in paths:
                path.write_bytes(b"test")

            storage.delete_sheet_files(USER_ID, "Song.pdf")
            storage.delete_sheet_files(USER_ID, "Song.pdf")

            self.assertTrue(all(not path.exists() for path in paths))

    def test_delete_rejects_another_users_job(self):
        with patch.object(server.db, "get_annotation_job", return_value=_job(user_id="other-user")):
            with self.assertRaises(HTTPException) as error:
                server.delete_job("job-1", USER_ID)
        self.assertEqual(error.exception.status_code, 404)

    def test_delete_rejects_a_job_that_is_still_running(self):
        with patch.object(server.db, "get_annotation_job", return_value=_job("processing")):
            with self.assertRaises(HTTPException) as error:
                server.delete_job("job-1", USER_ID)
        self.assertEqual(error.exception.status_code, 409)

    def test_delete_removes_files_sheet_job_and_local_working_directory(self):
        job = _job()
        sheet = {"music_sheet_id": "sheet-1", "user_id": USER_ID, "sheet_name": "Song.pdf"}
        with tempfile.TemporaryDirectory() as directory:
            jobs_dir = Path(directory)
            (jobs_dir / "job-1").mkdir()
            with (
                patch.object(server, "JOBS_DIR", jobs_dir),
                patch.object(server.db, "get_annotation_job", return_value=job),
                patch.object(server.db, "list_annotation_jobs", return_value=[job]),
                patch.object(server.db, "get_music_sheet", return_value=sheet),
                patch.object(server.db, "list_music_sheets", return_value=[sheet]),
                patch.object(server.storage, "delete_sheet_files") as delete_files,
                patch.object(server.db, "delete_music_sheet") as delete_sheet,
                patch.object(server.db, "delete_annotation_job") as delete_job,
            ):
                response = server.delete_job("job-1", USER_ID)

            self.assertEqual(response.status_code, 204)
            delete_files.assert_called_once_with(USER_ID, "Song.pdf")
            delete_sheet.assert_called_once_with("sheet-1")
            delete_job.assert_called_once_with("job-1")
            self.assertFalse((jobs_dir / "job-1").exists())

    def test_delete_keeps_files_used_by_a_same_named_upload(self):
        job = _job()
        sheet = {"music_sheet_id": "sheet-1", "user_id": USER_ID, "sheet_name": "Song.pdf"}
        other_sheet = {"music_sheet_id": "sheet-2", "user_id": USER_ID, "sheet_name": "Song.png"}
        with (
            patch.object(server.db, "get_annotation_job", return_value=job),
            patch.object(server.db, "list_annotation_jobs", return_value=[job]),
            patch.object(server.db, "get_music_sheet", return_value=sheet),
            patch.object(server.db, "list_music_sheets", return_value=[sheet, other_sheet]),
            patch.object(server.storage, "delete_sheet_files") as delete_files,
            patch.object(server.db, "delete_music_sheet") as delete_sheet,
            patch.object(server.db, "delete_annotation_job") as delete_job,
        ):
            server.delete_job("job-1", USER_ID)

        delete_files.assert_not_called()
        delete_sheet.assert_called_once_with("sheet-1")
        delete_job.assert_called_once_with("job-1")

    def test_delete_keeps_sheet_and_files_used_by_another_job(self):
        job = _job()
        other_job = _job(job_id="job-2")
        with (
            patch.object(server.db, "get_annotation_job", return_value=job),
            patch.object(server.db, "list_annotation_jobs", return_value=[job, other_job]),
            patch.object(server.db, "get_music_sheet") as get_sheet,
            patch.object(server.storage, "delete_sheet_files") as delete_files,
            patch.object(server.db, "delete_music_sheet") as delete_sheet,
            patch.object(server.db, "delete_annotation_job") as delete_job,
        ):
            server.delete_job("job-1", USER_ID)

        get_sheet.assert_called_once_with("sheet-1")
        delete_files.assert_not_called()
        delete_sheet.assert_not_called()
        delete_job.assert_called_once_with("job-1")


class DeleteStorageVersion2Tests(unittest.TestCase):
    """Real jobs are all storage_version 2 now (see job_state.create) - the
    class above only ever exercises the legacy branch, since _job() builds a
    plain dict with no storage_version field."""

    def setUp(self):
        self.addCleanup(db.delete_annotation_job, "v2-job")
        self.addCleanup(db.delete_music_sheet, "v2-job")

    def _seed(self, job_id="v2-job", user_id=USER_ID):
        job = job_state.create(job_id, user_id, "Song.pdf", OPTIONS, 4)
        storage._local_path(job["input_key"]).write_bytes(b"source")
        job_state.ready(job["job_id"], "local")
        self.assertTrue(worker.process_job(job["job_id"], runner=fake_runner))
        return db.get_annotation_job(job_id)

    def test_delete_removes_every_storage_key_for_the_job(self):
        job = self._seed()
        with patch.object(server.storage, "delete_job_files") as delete_files:
            response = server.delete_job("v2-job", USER_ID)
        self.assertEqual(response.status_code, 204)
        delete_files.assert_called_once_with(job)
        self.assertEqual(db.get_annotation_job("v2-job")["status"], "deleted")

    def test_delete_actually_removes_the_files_on_disk(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, "_LOCAL_DIR", Path(directory)):
            job = self._seed()
            input_path = storage._local_path(job["input_key"])
            output_path = storage._local_path(job["output_key"])
            timeline_path = storage._local_path(job["timeline_key"])
            self.assertTrue(input_path.exists() and output_path.exists() and timeline_path.exists())

            server.delete_job("v2-job", USER_ID)

            self.assertFalse(input_path.exists())
            self.assertFalse(output_path.exists())
            self.assertFalse(timeline_path.exists())

    def test_delete_never_touches_a_different_jobs_files(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, "_LOCAL_DIR", Path(directory)):
            job = self._seed()
            self.addCleanup(db.delete_annotation_job, "v2-other-job")
            self.addCleanup(db.delete_music_sheet, "v2-other-job")
            other = self._seed(job_id="v2-other-job")
            other_output = storage._local_path(other["output_key"])

            server.delete_job("v2-job", USER_ID)

            self.assertTrue(other_output.exists())
            self.assertEqual(db.get_annotation_job("v2-other-job")["status"], "done")
        db.delete_annotation_job("v2-other-job")
        db.delete_music_sheet("v2-other-job")

    def test_the_demo_job_is_refused_and_its_files_are_never_touched(self):
        job = job_state.create(config.DEMO_JOB_ID, config.DEMO_OWNER_ID, config.DEMO_SHEET_NAME, OPTIONS, 4)
        storage._local_path(job["input_key"]).write_bytes(b"source")
        job_state.ready(job["job_id"], "local")
        self.assertTrue(worker.process_job(job["job_id"], runner=fake_runner))
        self.addCleanup(db.delete_annotation_job, config.DEMO_JOB_ID)
        self.addCleanup(db.delete_music_sheet, config.DEMO_JOB_ID)

        with (
            patch.object(server.storage, "delete_job_files") as delete_files,
            patch.object(server.storage, "delete_sheet_files") as delete_sheet_files,
        ):
            with self.assertRaises(HTTPException) as error:
                server.delete_job(config.DEMO_JOB_ID, config.DEMO_OWNER_ID)
            # Spoofing the demo's own owner id doesn't help either.
            with self.assertRaises(HTTPException) as error_spoofed:
                server.delete_job(config.DEMO_JOB_ID, "anyone-at-all")

        self.assertEqual(error.exception.status_code, 403)
        self.assertEqual(error_spoofed.exception.status_code, 403)
        delete_files.assert_not_called()
        delete_sheet_files.assert_not_called()
        self.assertEqual(db.get_annotation_job(config.DEMO_JOB_ID)["status"], "done")


if __name__ == "__main__":
    unittest.main()
