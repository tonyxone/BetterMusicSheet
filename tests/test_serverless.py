"""AWS contract tests use Moto; they never access the real account."""
import importlib
import json
import os
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

import config
import db
import job_state
import processor
import server
import storage
import worker
import controller

USER = "11111111-1111-4111-8111-111111111111"
OPTIONS = {"style": "unicode", "octave": False, "font_size": 6.5, "dpi": None, "auto_retry": True}


def fake_runner(job, directory, tick):
    tick()
    (directory / "annotated.pdf").write_bytes(b"%PDF-test")
    (directory / "timeline.json").write_text('{"version": 1, "notes": []}')
    return 7


class ServerlessTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "APP_ENV": "production", "JOB_BACKEND": "sqs", "AWS_DEFAULT_REGION": "us-west-1",
            "AWS_REGION": "us-west-1", "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
            "USERS_TABLE": "test-users", "MUSIC_SHEET_TABLE": "test-sheets",
            "ANNOTATION_JOB_TABLE": "test-jobs", "JOB_CONTROL_TABLE": "test-control",
            "JOB_FILES_BUCKET": "legacy-files", "NEW_JOB_FILES_BUCKET": "new-files",
            "BACKEND_JWT_SECRET": "test-only", "COGNITO_USER_POOL_ID": "us-west-1_test",
            "COGNITO_APP_CLIENT_ID": "test-client",
        })
        self.env.start()
        self.aws = mock_aws()
        self.aws.start()
        self.ddb = boto3.client("dynamodb")
        for name, key in [("test-users", "user_id"), ("test-sheets", "music_sheet_id"),
                          ("test-jobs", "job_id"), ("test-control", "user_id")]:
            attrs = [{"AttributeName": key, "AttributeType": "S"}]
            indexes = []
            if name in ("test-sheets", "test-jobs"):
                attrs += [{"AttributeName": "user_id", "AttributeType": "S"},
                          {"AttributeName": "created_at", "AttributeType": "N"}]
                indexes.append({"IndexName": "user_id-index", "KeySchema": [
                    {"AttributeName": "user_id", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"}], "Projection": {"ProjectionType": "ALL"}})
            if name == "test-jobs":
                attrs += [{"AttributeName": "status", "AttributeType": "S"},
                          {"AttributeName": "next_check_at", "AttributeType": "N"}]
                indexes.append({"IndexName": "work-index", "KeySchema": [
                    {"AttributeName": "status", "KeyType": "HASH"},
                    {"AttributeName": "next_check_at", "KeyType": "RANGE"}], "Projection": {"ProjectionType": "ALL"}})
            self.ddb.create_table(TableName=name, BillingMode="PAY_PER_REQUEST", AttributeDefinitions=attrs,
                KeySchema=[{"AttributeName": key, "KeyType": "HASH"}], **({"GlobalSecondaryIndexes": indexes} if indexes else {}))
        self.s3 = boto3.client("s3")
        for bucket in ("legacy-files", "new-files"):
            self.s3.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": "us-west-1"})
        self.s3.put_bucket_versioning(Bucket="new-files", VersioningConfiguration={"Status": "Enabled"})
        self.sqs = boto3.client("sqs")
        self.queue = self.sqs.create_queue(QueueName="test-jobs")["QueueUrl"]
        self.dlq = self.sqs.create_queue(QueueName="test-failed")["QueueUrl"]
        for module in (config, db, storage, job_state, worker, server, controller):
            importlib.reload(module)
        self.client = TestClient(server.app)
        self.headers = {"X-Guest-Id": USER}

    def tearDown(self):
        self.client.close()
        self.aws.stop()
        self.env.stop()
        for module in (config, db, storage, job_state, worker, server, controller):
            importlib.reload(module)

    def upload(self, job_id="a", user=USER, data=b"source"):
        job = job_state.create(job_id, user, "Summer.pdf", OPTIONS, len(data))
        version = self.s3.put_object(Bucket="new-files", Key=job["input_key"], Body=data)["VersionId"]
        worker.accept_input(job_id, version)
        return db.get_annotation_job(job_id)

    def test_reservation_is_atomic_and_released_after_completion(self):
        self.upload()
        with self.assertRaises(job_state.Busy):
            job_state.create("b", USER, "Second.pdf", OPTIONS, 1)
        self.assertIsNone(db.get_annotation_job("b"))
        self.assertIsNone(db.get_music_sheet("b"))
        self.assertTrue(worker.process_job("a", runner=fake_runner))
        self.assertEqual(job_state.create("b", USER, "Second.pdf", OPTIONS, 1)["status"], "uploading")

    def test_replaced_worker_cannot_publish_or_renew_lease(self):
        self.upload()
        now = int(time.time())
        old = job_state.claim("a", "old", now=now)
        self.assertIsNone(job_state.claim("a", "early", now=now + 1))
        replacement = job_state.claim("a", "new", now=now + 181)
        self.assertEqual(replacement["attempt_count"], 2)
        with self.assertRaises(job_state.LeaseLost):
            job_state.finish(old, status="done", output_key="bad")
        with self.assertRaises(job_state.LeaseLost):
            job_state.heartbeat(old)

    def test_duplicate_delivery_does_not_repeat_completed_work(self):
        self.upload()
        runner = Mock(side_effect=fake_runner)
        self.assertTrue(worker.process_job("a", runner=runner))
        self.assertTrue(worker.process_job("a", runner=runner))
        self.assertEqual(runner.call_count, 1)
        job = db.get_annotation_job("a")
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["labeled_groups"], 7)
        self.assertIn("attempts/", job["output_key"])

    def test_failed_publish_retries_and_does_not_mark_done(self):
        self.upload()
        with patch.object(storage, "publish", side_effect=OSError("S3 unavailable")):
            self.assertFalse(worker.process_job("a", runner=fake_runner))
        self.assertEqual(db.get_annotation_job("a")["status"], "queued")
        self.assertTrue(worker.process_job("a", runner=fake_runner))
        self.assertEqual(db.get_annotation_job("a")["attempt_count"], 2)

    def test_three_processing_failures_release_user_lock(self):
        self.upload()
        runner = Mock(side_effect=RuntimeError("bad recognition"))
        self.assertFalse(worker.process_job("a", runner=runner))
        self.assertFalse(worker.process_job("a", runner=runner))
        self.assertTrue(worker.process_job("a", runner=runner))
        self.assertEqual(db.get_annotation_job("a")["status"], "failed")
        job_state.create("b", USER, "Next.pdf", OPTIONS, 1)

    def test_optional_timeline_failure_keeps_pdf_downloadable(self):
        self.upload()
        def pdf_only(job, directory, tick):
            (directory / "annotated.pdf").write_bytes(b"pdf")
            return 2
        self.assertTrue(worker.process_job("a", runner=pdf_only))
        assets = self.client.get("/api/sheets/a/assets", headers=self.headers).json()
        self.assertIsNotNone(assets["pdf"])
        self.assertIsNone(assets["timeline"])

    def test_source_version_pinned_even_if_upload_url_is_reused(self):
        job = self.upload(data=b"first")
        self.s3.put_object(Bucket="new-files", Key=job["input_key"], Body=b"changed")
        worker.accept_input("a")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "raw"
            storage.download_input(db.get_annotation_job("a"), path)
            self.assertEqual(path.read_bytes(), b"first")

    def test_missed_notification_recovered_and_expired_upload_released(self):
        job = job_state.create("a", USER, "Test.pdf", OPTIONS, 3)
        self.s3.put_object(Bucket="new-files", Key=job["input_key"], Body=b"pdf")
        controller.reconcile(self.sqs, self.queue, int(time.time()) + 61)
        self.assertEqual(db.get_annotation_job("a")["status"], "queued")
        self.assertTrue(self.sqs.receive_message(QueueUrl=self.queue).get("Messages"))
        abandoned = job_state.create("b", "22222222", "Lost.pdf", OPTIONS, 3)
        controller.reconcile(self.sqs, self.queue, abandoned["upload_expires_at"] + 1)
        self.assertEqual(db.get_annotation_job("b")["status"], "failed")
        job_state.create("c", "22222222", "Next.pdf", OPTIONS, 3)

    def test_size_mismatch_is_terminal(self):
        job = job_state.create("a", USER, "Test.pdf", OPTIONS, 1)
        self.s3.put_object(Bucket="new-files", Key=job["input_key"], Body=b"too big")
        self.assertEqual(worker.accept_input("a")["status"], "failed")

    def test_legacy_assets_and_unicode_disposition(self):
        db.create_music_sheet("old-sheet", USER, "夏日漱石.pdf")
        db.create_annotation_job("old-job", USER, "old-sheet", **OPTIONS)
        db.update_annotation_job("old-job", status="done")
        key = storage._output_key(USER, "夏日漱石.pdf")
        self.s3.put_object(Bucket="legacy-files", Key=key, Body=b"pdf")
        response = self.client.get("/api/sheets/old-job/assets", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertIn("legacy-files", response.json()["pdf"])
        self.assertIn("response-content-disposition", response.json()["pdf"])
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_delete_all_versions_late_upload_and_ownership(self):
        job = self.upload()
        worker.process_job("a", runner=fake_runner)
        self.s3.put_object(Bucket="new-files", Key=job["input_key"], Body=b"second version")
        self.assertEqual(self.client.delete("/api/sheets/a", headers={"X-Guest-Id": "22222222"}).status_code, 404)
        self.assertEqual(self.client.delete("/api/sheets/a", headers=self.headers).status_code, 204)
        self.assertFalse(self.s3.list_object_versions(Bucket="new-files").get("Versions"))
        self.assertEqual(self.client.get("/api/sheets", headers=self.headers).json(), [])
        self.s3.put_object(Bucket="new-files", Key=job["input_key"], Body=b"late upload")
        controller.reconcile(self.sqs, self.queue, job["upload_expires_at"] + 61)
        self.assertFalse(self.s3.list_object_versions(Bucket="new-files").get("Versions"))
        self.assertEqual(self.client.get("/api/sheets/a/assets", headers=self.headers).status_code, 404)

    def test_direct_upload_policy_and_input_validation(self):
        body = {"filename": "Summer.pdf", "size": 10, **OPTIONS}
        self.assertEqual(self.client.post("/api/uploads", json={**body, "dpi": 600}, headers=self.headers).status_code, 422)
        self.assertEqual(self.client.post("/api/uploads", json={**body, "size": 30 * 1024 * 1024}, headers=self.headers).status_code, 422)
        response = self.client.post("/api/uploads", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 201, response.text)
        import base64
        policy = json.loads(base64.b64decode(response.json()["upload"]["fields"]["policy"]))
        self.assertIn(["content-length-range", 10, 10], policy["conditions"])
        job_id = response.json()["job_id"]
        self.assertEqual(self.client.post(f"/api/uploads/{job_id}/complete", headers=self.headers).status_code, 409)

    def test_presigned_urls_use_the_regional_endpoint(self):
        # A global-endpoint presign answers 307 and the client repeats the
        # request. For an upload that means sending the whole file twice, so
        # this costs a user's bandwidth rather than just a round trip.
        job = self.upload()
        self.assertIn("s3.us-west-1.amazonaws.com", storage.create_upload(job, "application/pdf")["url"])
        self.assertTrue(worker.process_job(job["job_id"], runner=fake_runner))
        done = db.get_annotation_job(job["job_id"])
        for kind in ("output", "timeline"):
            self.assertIn("s3.us-west-1.amazonaws.com", storage.presign_artifact(done, kind))

    def test_lambda_gateway_adapter_and_cors(self):
        from mangum import Mangum
        handler = Mangum(server.app, lifespan="off")
        event = {"version": "2.0", "routeKey": "ANY /api/{proxy+}", "rawPath": "/api/health", "rawQueryString": "",
                 "headers": {"host": "api.test", "origin": "http://localhost:3000"},
                 "requestContext": {"http": {"method": "GET", "path": "/api/health", "sourceIp": "127.0.0.1"}},
                 "isBase64Encoded": False}
        response = handler(event, {})
        self.assertEqual(response["statusCode"], 200)
        self.assertIn("access-control-allow-origin", response["headers"])

    def test_recognition_stage_reports_page_progress(self):
        self.upload()
        job = job_state.claim("a", "token")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "work").mkdir()
            (directory / "work" / "input-1.log").write_text(
                "INFO [input#1] | LOAD\nINFO [input#3] | HEADS\n")
            # Nothing published yet: the claimed stage must be left alone.
            self.assertIsNone(worker.current_stage(directory))

            processor.publish(directory, stage=processor.RECOGNITION, pages=5)
            job_state.heartbeat(job, stage=worker.current_stage(directory))
            self.assertEqual(db.get_annotation_job("a")["stage"], "Reading sheet music (page 3 of 5)")

            # Later stages are shown as-is, and a one-page sheet gets no counter.
            processor.publish(directory, stage="Drawing the annotated sheet", pages=5)
            self.assertEqual(worker.current_stage(directory), "Drawing the annotated sheet")
            processor.publish(directory, stage=processor.RECOGNITION, pages=1)
            self.assertEqual(worker.current_stage(directory), "Reading sheet music")

            # A half-written progress file costs an update, never the job.
            (directory / "progress.json").write_text("{ truncated")
            self.assertIsNone(worker.current_stage(directory))
        self.assertEqual(db.get_annotation_job("a")["status"], "processing")

    def test_progress_stage_cannot_outlive_the_lease(self):
        self.upload()
        now = int(time.time())
        stale = job_state.claim("a", "old", now=now)
        job_state.claim("a", "new", now=now + 181)
        with self.assertRaises(job_state.LeaseLost):
            job_state.heartbeat(stale, stage="Reading sheet music (page 2 of 5)")


class ScalingTests(unittest.TestCase):
    def test_zero_wakeup_cap_and_idle_cooldown(self):
        self.assertEqual(controller.desired_workers(1, 0, 0, 0, 100, 4), (1, 0))
        self.assertEqual(controller.desired_workers(100, 2, 2, 0, 100, 4), (4, 0))
        self.assertEqual(controller.desired_workers(0, 2, 2, 0, 100, 4), (2, 0))
        self.assertEqual(controller.desired_workers(0, 0, 1, 50, 100, 4), (1, 50))
        self.assertEqual(controller.desired_workers(0, 0, 1, 50, 200, 4), (0, 50))


if __name__ == "__main__":
    unittest.main()
