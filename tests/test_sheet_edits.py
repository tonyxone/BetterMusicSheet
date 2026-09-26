"""A reader's own edits to a sheet (moved/retyped labels, drawings, notes,
note corrections) and the label data the editor starts from. Runs in local
(non-serverless) mode, like test_demo_sheet.py.
"""
import json
import unittest

from fastapi.testclient import TestClient

import config
import db
import job_state
import server
import storage
import worker
from label_export import labels_document

OWNER = "33333333-3333-4333-8333-333333333333"
OUTSIDER = "44444444-4444-4444-8444-444444444444"
OPTIONS = {"style": "unicode", "octave": False, "font_size": 6.5, "dpi": None, "auto_retry": True, "color": "#000000"}
LABELS = {"version": 1, "font_size": 6.5, "color": "#000000", "items": []}


def fake_runner(job, directory, tick):
    tick()
    (directory / "annotated.pdf").write_bytes(b"%PDF-annotated")
    (directory / "timeline.json").write_text('{"version": 1, "notes": []}')
    (directory / "labels.json").write_text(json.dumps(LABELS))
    return 3


class SheetEditsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.job_id = "edits-job"
        job = job_state.create(self.job_id, OWNER, "Edited.pdf", OPTIONS, 4)
        storage._local_path(job["input_key"]).write_bytes(b"%PDF-source")
        job_state.ready(self.job_id, "local")
        self.assertTrue(worker.process_job(self.job_id, runner=fake_runner))

    def tearDown(self):
        self.client.close()
        job = db.get_annotation_job(self.job_id)
        if job:
            storage.delete_job_files(job)
            db.delete_annotation_job(self.job_id)
        db.delete_music_sheet(self.job_id)

    def owner(self):
        return {"X-Guest-Id": OWNER}

    def test_labels_are_published_and_served(self):
        assets = self.client.get(f"/api/sheets/{self.job_id}/assets", headers=self.owner()).json()
        self.assertEqual(assets["labels"], f"/api/sheets/{self.job_id}/labels")
        response = self.client.get(assets["labels"], headers=self.owner())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), LABELS)

    def test_new_sheet_has_no_edits_yet(self):
        response = self.client.get(f"/api/sheets/{self.job_id}/edits", headers=self.owner())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["revision"], 0)
        self.assertIsNone(response.json()["doc"])

    def test_saved_edits_come_back_on_the_next_read(self):
        doc = {"version": 1, "labels": {"1-0-0": {"dx": 3, "dy": -2, "text": "D♭"}}, "strokes": []}
        saved = self.client.put(f"/api/sheets/{self.job_id}/edits", headers=self.owner(),
                                json={"revision": 0, "doc": doc})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["revision"], 1)
        read = self.client.get(f"/api/sheets/{self.job_id}/edits", headers=self.owner()).json()
        self.assertEqual(read["revision"], 1)
        self.assertEqual(read["doc"], doc)

    def test_a_stale_revision_is_refused_with_the_current_copy(self):
        url = f"/api/sheets/{self.job_id}/edits"
        self.client.put(url, headers=self.owner(), json={"revision": 0, "doc": {"version": 1, "n": 1}})
        stale = self.client.put(url, headers=self.owner(), json={"revision": 0, "doc": {"version": 1, "n": 2}})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["revision"], 1)
        self.assertEqual(stale.json()["doc"], {"version": 1, "n": 1})

    def test_strangers_cannot_read_or_write_someone_elses_sheet(self):
        url = f"/api/sheets/{self.job_id}/edits"
        self.assertEqual(self.client.get(url, headers={"X-Guest-Id": OUTSIDER}).status_code, 404)
        self.assertEqual(self.client.put(url, headers={"X-Guest-Id": OUTSIDER},
                                         json={"revision": 0, "doc": {"version": 1}}).status_code, 404)

    def test_the_shared_fallback_identity_cannot_save(self):
        response = self.client.put(f"/api/sheets/{self.job_id}/edits", json={"revision": 0, "doc": {"version": 1}})
        self.assertIn(response.status_code, (403, 404))

    def test_deleting_the_sheet_deletes_its_edits(self):
        url = f"/api/sheets/{self.job_id}/edits"
        self.client.put(url, headers=self.owner(), json={"revision": 0, "doc": {"version": 1}})
        path = storage._LOCAL_DIR / storage._edits_key(db.get_annotation_job(self.job_id), OWNER)
        self.assertTrue(path.exists())
        self.assertEqual(self.client.delete(f"/api/sheets/{self.job_id}", headers=self.owner()).status_code, 204)
        self.assertFalse(path.exists())


class DemoEditsTests(unittest.TestCase):
    """On the shared demo sheet every reader keeps their own edits."""

    def setUp(self):
        self.client = TestClient(server.app)
        job = job_state.create(config.DEMO_JOB_ID, config.DEMO_OWNER_ID, config.DEMO_SHEET_NAME, OPTIONS, 4)
        storage._local_path(job["input_key"]).write_bytes(b"%PDF-source")
        job_state.ready(job["job_id"], "local")
        self.assertTrue(worker.process_job(job["job_id"], runner=fake_runner))

    def tearDown(self):
        self.client.close()
        storage.delete_job_files(db.get_annotation_job(config.DEMO_JOB_ID))
        db.delete_annotation_job(config.DEMO_JOB_ID)
        db.delete_music_sheet(config.DEMO_JOB_ID)

    def test_readers_do_not_see_each_others_demo_edits(self):
        url = f"/api/sheets/{config.DEMO_JOB_ID}/edits"
        mine = self.client.put(url, headers={"X-Guest-Id": OUTSIDER}, json={"revision": 0, "doc": {"version": 1, "mine": True}})
        self.assertEqual(mine.status_code, 200, mine.text)
        theirs = self.client.get(url, headers={"X-Guest-Id": OWNER}).json()
        self.assertIsNone(theirs["doc"])


class LabelExportTests(unittest.TestCase):
    def test_each_line_is_tied_to_the_timeline_note_under_its_notehead(self):
        block = {"x": 100.0, "labels": ["C", "E"], "ys": [50.0, 56.0], "label_x_offsets": [0.0, 0.0],
                 "fs": 6.5, "widths": [4, 4],
                 "note_boxes": [[98, 70, 102, 74], [98, 64, 102, 68]]}
        timeline = {"measures": [{"page": 1}], "notes": [
            {"measure_index": 0, "bbox_pt": [98, 70, 102, 74], "printed_id": "c-note"},
            {"measure_index": 0, "bbox_pt": [98.2, 64, 102.2, 68], "printed_id": "e-note"},
            {"measure_index": 0, "bbox_pt": [98, 70, 102, 74], "printed_id": "c-note"},  # a repeat
            {"measure_index": 0, "bbox_pt": [150, 70, 154, 74], "printed_id": "elsewhere"},
        ]}
        doc = labels_document([(1, block)], timeline)
        self.assertEqual([item["text"] for item in doc["items"]], ["C", "E"])
        self.assertEqual(doc["items"][0]["notes"], ["c-note"])
        self.assertEqual(doc["items"][1]["notes"], ["e-note"])
        self.assertEqual(doc["items"][0]["group"], doc["items"][1]["group"])
        self.assertNotEqual(doc["items"][0]["id"], doc["items"][1]["id"])

    def test_labels_without_a_timeline_still_export(self):
        block = {"x": 10.0, "labels": ["G"], "ys": [5.0], "label_x_offsets": [0.0], "fs": 6.5, "widths": [4]}
        doc = labels_document([(2, block)], None)
        self.assertEqual(doc["items"][0]["page"], 2)
        self.assertEqual(doc["items"][0]["notes"], [])


if __name__ == "__main__":
    unittest.main()
