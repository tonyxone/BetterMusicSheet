"""An admin reads a sheet again from the dashboard (reprocess.py), and every
other sheet made from the same file gets the new reading - while every
reader's own edits stay exactly as they were. Local (in-memory) mode, like
test_republish.py.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import auth
import db
import job_state
import processed_sheets
import reprocess
import server
import storage
import worker
from processor import InvalidSheet

ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ALICE = "84848484-8484-4848-8484-848484848484"
BOB = "85858585-8585-4858-8585-858585858585"
CAROL = "86868686-8686-4868-8686-868686868686"
DAVE = "87878787-8787-4878-8787-878787878787"
OPTIONS = {"style": "unicode", "octave": False, "notation": "letters", "font_size": 6.5, "dpi": None,
           "auto_retry": True, "color": "#000000"}
SCORE = b"%PDF-1.4 the same score"
EDITS = json.dumps({"revision": 3, "doc": {"version": 1, "labels": {"g1-0": {"dx": 4}},
                                           "texts": [{"id": "t", "page": 1, "x": 9, "y": 9, "text": "slow",
                                                      "size": 10, "color": "#ff0000"}],
                                           "strokes": [], "corrections": {}}}).encode()


def first_reading(job, directory, tick=None):
    (directory / "annotated.pdf").write_bytes(b"%PDF old reading")
    (directory / "timeline.json").write_text('{"version": 1, "measures": []}')
    (directory / "labels.json").write_text('{"items": []}')
    (directory / "notes.json").write_text('{"old": true}')
    return {"count": 3, "notes_named": 10, "notes_printed": 30}


def unreadable(job, directory, tick=None):
    raise InvalidSheet("No music notation was detected.")


class Reader:
    """reprocess._reader's stand-in: records what each sheet was given."""
    def __init__(self):
        self.calls = []

    def __call__(self, tick, redraw_from=None):
        def read(job, directory):
            self.calls.append((job["job_id"], redraw_from))
            text = f"%PDF new {'drawn from ' + redraw_from if redraw_from else 'reading'} for {job['job_id']}"
            (directory / "annotated.pdf").write_bytes(text.encode())
            (directory / "timeline.json").write_text('{"version": 1, "measures": [1]}')
            (directory / "labels.json").write_text('{"items": [1]}')
            (directory / "notes.json").write_text('{"new": true}')
            return {"count": 9, "notes_named": 29, "notes_printed": 30}
        return read


class ReprocessTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for patcher in (patch.object(storage, "_LOCAL_DIR", Path(directory.name)),
                        patch.dict(db._annotation_jobs, clear=True), patch.dict(db._music_sheets, clear=True),
                        patch.dict(processed_sheets._rows, clear=True), patch("builtins.print")):
            patcher.start()
            self.addCleanup(patcher.stop)

    def sheet(self, job_id, user_id, runner=first_reading, content=SCORE, **options):
        job = job_state.create(job_id, user_id, f"{job_id}.pdf", {**OPTIONS, **options}, len(content))
        storage._local_path(job["input_key"]).write_bytes(content)
        if worker.accept_input(job_id)["status"] == "queued":
            worker.process_job(job_id, runner=runner)
        job = db.get_annotation_job(job_id)
        storage.write_edits(job, user_id, EDITS)
        return job

    def output(self, job_id):
        return storage._local_path(db.get_annotation_job(job_id)["output_key"]).read_bytes()

    def test_the_new_reading_reaches_every_sheet_of_the_same_file_and_edits_stay(self):
        self.sheet("alice", ALICE)
        bob = self.sheet("bob", BOB)                           # same settings: copied when uploaded
        self.assertEqual(bob["reused_from"], "alice")
        self.sheet("carol", CAROL, color="#ff0000")            # names drawn another way
        self.sheet("dave", DAVE, dpi=400)                      # read another way
        other = self.sheet("other", BOB, content=b"%PDF-1.4 another score")
        before = {job_id: db.get_annotation_job(job_id) for job_id in ("alice", "bob", "carol", "dave", "other")}

        reprocess.request("alice", ADMIN, "beam fix")
        reader = Reader()
        self.assertTrue(reprocess.run("alice", reader=reader))

        self.assertEqual(self.output("alice"), b"%PDF new reading for alice")
        self.assertEqual(self.output("bob"), b"%PDF new reading for alice")
        self.assertEqual(self.output("carol"), b"%PDF new drawn from alice for carol")
        self.assertEqual(self.output("dave"), b"%PDF new reading for dave")
        self.assertEqual(db.get_annotation_job("other"), before["other"])
        self.assertEqual(sorted(reader.calls), [("alice", None), ("carol", "alice"), ("dave", None)])
        for job_id, user_id in (("alice", ALICE), ("bob", BOB), ("carol", CAROL), ("dave", DAVE), ("other", BOB)):
            job = db.get_annotation_job(job_id)
            self.assertEqual(storage.read_edits(job, user_id), EDITS, job_id)
            if job_id != "other":
                self.assertEqual((job["status"], job["labeled_groups"]), ("done", 9))
                self.assertEqual(job["republished_from"], before[job_id]["output_key"])
                # The old files stay, for rolling back.
                self.assertTrue(storage._local_path(before[job_id]["output_key"]).exists())
        # Each sheet keeps files of its own: a copy, not a pointer.
        self.assertNotEqual(db.get_annotation_job("bob")["output_key"], db.get_annotation_job("alice")["output_key"])

        alice = db.get_annotation_job("alice")
        self.assertEqual((alice["reprocess_state"], alice["reprocess_error"]), ("done", None))
        hows = {entry["job_id"]: entry["how"] for entry in alice["reprocess_result"]["updated"]}
        self.assertEqual(hows, {"bob": "copied", "carol": "redrawn", "dave": "read"})
        self.assertEqual(alice["reprocess_result"]["failed"], [])

    def test_a_failed_sheet_of_the_same_file_is_fixed_too_and_a_deleted_one_left_alone(self):
        self.sheet("alice", ALICE, runner=unreadable)
        self.sheet("bob", BOB, runner=unreadable)
        self.sheet("carol", CAROL, runner=unreadable)
        job_state.change("carol", {"status": "failed"}, status="deleting")
        reprocess.request("bob", ADMIN)
        self.assertTrue(reprocess.run("bob", reader=Reader()))
        self.assertEqual(self.output("alice"), b"%PDF new reading for bob")
        self.assertEqual((db.get_annotation_job("alice")["status"], db.get_annotation_job("alice")["error"]),
                         ("done", None))
        self.assertEqual(db.get_annotation_job("carol")["status"], "deleting")
        self.assertNotIn("republished_at", db.get_annotation_job("carol"))

    def test_a_sheet_from_before_uploads_were_hashed_is_found_by_hashing_it(self):
        self.sheet("alice", ALICE)
        self.sheet("bob", BOB, color="#00ff00")
        db._annotation_jobs["bob"].pop("content_sha256")
        db._annotation_jobs["alice"].pop("content_sha256")
        reprocess.request("alice", ADMIN)
        self.assertTrue(reprocess.run("alice", reader=Reader()))
        self.assertEqual(self.output("bob"), b"%PDF new drawn from alice for bob")
        self.assertEqual(db.get_annotation_job("bob")["content_sha256"],
                         db.get_annotation_job("alice")["content_sha256"])

    def test_one_sheet_that_cannot_be_updated_does_not_stop_the_others(self):
        self.sheet("alice", ALICE)
        self.sheet("bob", BOB)
        self.sheet("carol", CAROL)
        with patch.object(reprocess.republish, "copy_from", side_effect=[RuntimeError("S3 down"), None]):
            reprocess.request("alice", ADMIN)
            self.assertTrue(reprocess.run("alice", reader=Reader()))
        result = db.get_annotation_job("alice")["reprocess_result"]
        self.assertEqual([(f["job_id"], f["error"]) for f in result["failed"]], [("bob", "S3 down")])
        self.assertEqual([u["job_id"] for u in result["updated"]], ["carol"])

    def test_a_reading_that_fails_leaves_every_sheet_as_it_was(self):
        self.sheet("alice", ALICE)
        bob = self.sheet("bob", BOB)
        reprocess.request("alice", ADMIN)
        self.assertTrue(reprocess.run("alice", reader=lambda tick, redraw_from=None: unreadable))
        alice = db.get_annotation_job("alice")
        self.assertEqual(alice["reprocess_state"], "failed")
        self.assertIn("No music notation", alice["reprocess_error"])
        self.assertEqual(alice["status"], "done")
        self.assertEqual(self.output("alice"), b"%PDF old reading")
        self.assertEqual(db.get_annotation_job("bob"), bob)

    def test_a_request_is_carried_out_once(self):
        self.sheet("alice", ALICE)
        reprocess.request("alice", ADMIN)
        with self.assertRaises(reprocess.republish.Refused):
            reprocess.request("alice", ADMIN)
        reader = Reader()
        self.assertTrue(reprocess.run("alice", reader=reader))
        self.assertTrue(reprocess.run("alice", reader=reader))  # the same message again
        self.assertEqual(len(reader.calls), 1)
        reprocess.request("alice", ADMIN)  # once done, it may be asked for again

    def test_a_sheet_still_being_read_or_never_uploaded_is_refused(self):
        job_state.create("uploading", ALICE, "x.pdf", OPTIONS, 9)
        for job_id in ("uploading", "missing"):
            with self.assertRaises(reprocess.republish.Refused):
                reprocess.request(job_id, ADMIN)

    def test_the_worker_tells_a_reprocess_message_from_an_upload(self):
        self.assertEqual(worker.reprocess_request(json.dumps(reprocess.message("alice"))), "alice")
        self.assertIsNone(worker.reprocess_request(json.dumps({"job_id": "alice"})))
        self.assertEqual(worker.event_jobs(json.dumps(reprocess.message("alice"))), [])


class ReprocessRouteTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for patcher in (patch.object(storage, "_LOCAL_DIR", Path(directory.name)),
                        patch.dict(db._annotation_jobs, clear=True), patch.dict(db._music_sheets, clear=True),
                        patch.dict(processed_sheets._rows, clear=True), patch("builtins.print")):
            patcher.start()
            self.addCleanup(patcher.stop)
        db.add_admin(ADMIN)
        self.addCleanup(db._admins.discard, ADMIN)
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)
        job = job_state.create("alice", ALICE, "alice.pdf", OPTIONS, len(SCORE))
        storage._local_path(job["input_key"]).write_bytes(SCORE)
        worker.accept_input("alice")
        worker.process_job("alice", runner=first_reading)

    def post(self, user_id):
        return self.client.post("/api/admin/uploads/alice/reprocess", json={"reason": "beam fix"},
                                headers={"Authorization": f"Bearer {auth.mint_backend_token(user_id)}"})

    def test_only_an_admin_can_ask_and_it_goes_to_a_worker(self):
        with patch.object(server, "enqueue_local") as enqueue:
            self.assertEqual(self.post(ALICE).status_code, 404)
            self.assertNotIn("reprocess_state", db.get_annotation_job("alice"))
            response = self.post(ADMIN)
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.json()["reprocess"]["state"], "queued")
            enqueue.assert_called_once_with(("reprocess", "alice"))
            self.assertEqual(self.post(ADMIN).status_code, 409)
        self.assertEqual(db.get_annotation_job("alice")["reprocess_reason"], "beam fix")


if __name__ == "__main__":
    unittest.main()
