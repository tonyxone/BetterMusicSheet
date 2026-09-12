"""Scheduled recovery and bounded scaling. Never consumes the work queue.

One controller (reserved concurrency 1) owns desiredCount. A minute schedule
can wake an empty ECS service even after SQS CloudWatch metrics go inactive.
"""
import json
import os
import time
import traceback

import db
import job_state
import storage
from worker import accept_input, event_jobs


def reconcile(sqs, queue_url, now):
    for status in (*job_state.ACTIVE, "done", "failed", "deleting", "deleted"):
        for job in job_state.due(status, now):
            try:
                if status in ("done", "failed"):
                    job_state.release(job)
                    job_state.forget_check(job)
                elif status in ("deleted", "deleting"):
                    storage.delete_job_files(job)
                    db.delete_music_sheet(job["music_sheet_id"])
                    job_state.release(job)
                    if status == "deleting":
                        job_state.change(job["job_id"], {"status": status}, status="deleted",
                                         next_check_at=max(now + 60, job["upload_expires_at"] + 60))
                    else:
                        job_state.forget_check(job)
                elif status == "uploading":
                    updated = accept_input(job["job_id"])
                    if updated["status"] == "uploading":
                        if job["upload_expires_at"] < now:
                            if job_state.change(job["job_id"], {"status": status}, status="failed",
                                                 error="Upload expired. Please upload the file again."):
                                job_state.release(job)
                        else:
                            job_state.change(job["job_id"], {"status": status}, next_check_at=now + 60)
                    elif updated["status"] == "queued":
                        sqs.send_message(QueueUrl=queue_url, MessageBody=json.dumps({"job_id": job["job_id"]}))
                elif status == "processing":
                    # Compare the lease expiry as well as owner; a racing heartbeat
                    # must prevent an otherwise valid worker from being requeued.
                    if job.get("lease_until", 0) <= now:
                        job_state.change(job["job_id"], {"status": status, "lease_owner": job["lease_owner"],
                            "lease_until": job["lease_until"]}, status="queued", next_check_at=now,
                            stage="Recovering interrupted processing")
                elif status == "queued":
                    # Repair notification loss and producer crashes. Duplicates
                    # are harmless because the worker uses a conditional claim.
                    sqs.send_message(QueueUrl=queue_url, MessageBody=json.dumps({"job_id": job["job_id"]}))
                    job_state.change(job["job_id"], {"status": status}, next_check_at=now + 300)
            except Exception:
                traceback.print_exc()


def drain_dlq(sqs, url, now):
    for message in sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=10).get("Messages", []):
        handled = True
        for job_id, _ in event_jobs(message["Body"]):
            job = db.get_annotation_job(job_id)
            if job and job["status"] in job_state.ACTIVE:
                if job["status"] == "processing" and job.get("lease_until", 0) > now:
                    handled = False
                    continue
                expected = {"status": job["status"], "attempt_count": job["attempt_count"]}
                if job["status"] == "processing":
                    expected.update(lease_owner=job["lease_owner"], lease_until=job["lease_until"])
                # A duplicate may exhaust its receive count while another copy
                # succeeds. Only actual processing attempts determine failure.
                if job["attempt_count"] >= 3:
                    if job_state.change(job_id, expected, status="failed", error="Processing failed after three attempts."):
                        job_state.release(job)
                    else:
                        handled = False
                else:
                    job_state.change(job_id, expected, next_check_at=now)
        if handled:
            sqs.delete_message(QueueUrl=url, ReceiptHandle=message["ReceiptHandle"])


def desired_workers(visible, inflight, current, empty_since, now, maximum):
    if visible + inflight:
        return min(maximum, visible + inflight), 0
    empty_since = empty_since or now
    return (0 if now - empty_since >= 120 else current), empty_since


def handler(event, context):
    import boto3
    sqs = boto3.client("sqs")
    ecs = boto3.client("ecs")
    now = int(time.time())
    queue_url = os.environ["JOB_QUEUE_URL"]
    drain_dlq(sqs, os.environ["JOB_DLQ_URL"], now)
    reconcile(sqs, queue_url, now)
    stats = sqs.get_queue_attributes(QueueUrl=queue_url,
        AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"])["Attributes"]
    service_args = {"cluster": os.environ["WORKER_CLUSTER"], "service": os.environ["WORKER_SERVICE"]}
    service = ecs.describe_services(cluster=service_args["cluster"], services=[service_args["service"]])["services"][0]
    control = job_state._table()
    state = control.get_item(Key={"user_id": "__scaler__"}, ConsistentRead=True).get("Item", {})
    desired, empty_since = desired_workers(int(stats["ApproximateNumberOfMessages"]),
        int(stats["ApproximateNumberOfMessagesNotVisible"]), service["desiredCount"],
        int(state.get("empty_since", 0)), now, int(os.environ.get("MAX_WORKERS", "4")))
    if desired != service["desiredCount"]:
        ecs.update_service(**service_args, desiredCount=desired)
    control.put_item(Item={"user_id": "__scaler__", "empty_since": empty_since})
    print(json.dumps({"visible": stats["ApproximateNumberOfMessages"], "inflight": stats["ApproximateNumberOfMessagesNotVisible"], "desired": desired}))
    return {"desired": desired}
