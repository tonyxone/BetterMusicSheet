"""Atomic reservations and fenced worker leases for new jobs.

Legacy rows are deliberately untouched. All leased updates compare the attempt
token: a late worker cannot publish over a replacement worker's result.
"""
import os
import time
from decimal import Decimal

import db
from config import IS_PRODUCTION, LEASE_SECONDS, MAX_ATTEMPTS, UPLOAD_SECONDS


class Busy(Exception):
    pass


class LeaseLost(Exception):
    pass


def _table():
    return db._dynamodb.Table(os.environ["JOB_CONTROL_TABLE"])


def _serialized(item):
    from boto3.dynamodb.types import TypeSerializer
    serializer = TypeSerializer()
    return {k: serializer.serialize(v) for k, v in item.items()}


def create(job_id, user_id, name, options, size):
    now = int(time.time())
    sheet = {"music_sheet_id": job_id, "user_id": user_id, "sheet_name": name,
             "created_at": now, "storage_version": 2}
    job = {"job_id": job_id, "music_sheet_id": job_id, "user_id": user_id,
           "sheet_name": name, "storage_version": 2, "status": "uploading",
           "input_key": f"jobs/{user_id}/{job_id}/input", "size": size,
           "created_at": now, "updated_at": now, "next_check_at": now + 60,
           "upload_expires_at": now + UPLOAD_SECONDS, "attempt_count": 0,
           "error": None, "stage": "Uploading sheet", "labeled_groups": None,
           **options}
    if IS_PRODUCTION:
        stored = {**job, "font_size": Decimal(str(job["font_size"]))}
        # The lock has no short TTL: the reconciler explicitly releases abandoned
        # uploads and terminal jobs, so an active processing job never loses it.
        lock = {"user_id": user_id, "job_id": job_id}
        try:
            import boto3
            boto3.client("dynamodb").transact_write_items(TransactItems=[
                {"Put": {"TableName": _table().name, "Item": _serialized(lock),
                         "ConditionExpression": "attribute_not_exists(user_id)"}},
                {"Put": {"TableName": db._music_sheet_table.name, "Item": _serialized(sheet),
                         "ConditionExpression": "attribute_not_exists(music_sheet_id)"}},
                {"Put": {"TableName": db._annotation_job_table.name, "Item": _serialized(stored),
                         "ConditionExpression": "attribute_not_exists(job_id)"}},
            ])
        except db._annotation_job_table.meta.client.exceptions.TransactionCanceledException as exc:
            if any(r.get("Code") == "ConditionalCheckFailed" for r in exc.response.get("CancellationReasons", [])):
                raise Busy("You already have a sheet uploading or processing.") from exc
            raise
    else:
        with db._lock:
            if any(j["user_id"] == user_id and j["status"] in ACTIVE for j in db._annotation_jobs.values()):
                raise Busy("You already have a sheet uploading or processing.")
            db._music_sheets[job_id] = sheet
            db._annotation_jobs[job_id] = job
    return job


ACTIVE = ("uploading", "queued", "processing")


def change(job_id, expected, **fields):
    """Compare-and-set a row; returns false if another request won the race."""
    fields["updated_at"] = int(time.time())
    if IS_PRODUCTION:
        names = {f"#f{i}": k for i, k in enumerate(fields)}
        values = {f":f{i}": v for i, v in enumerate(fields.values())}
        clauses = []
        for i, (key, value) in enumerate(expected.items()):
            names[f"#e{i}"] = key
            if value is None:
                clauses.append(f"attribute_not_exists(#e{i})")
            else:
                clauses.append(f"#e{i} = :e{i}")
                values[f":e{i}"] = value
        try:
            db._annotation_job_table.update_item(
                Key={"job_id": job_id},
                UpdateExpression="SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(fields))),
                ConditionExpression="attribute_exists(job_id) AND " + " AND ".join(clauses),
                ExpressionAttributeNames=names, ExpressionAttributeValues=values,
            )
            return True
        except db._annotation_job_table.meta.client.exceptions.ConditionalCheckFailedException:
            return False
    with db._lock:
        job = db._annotation_jobs.get(job_id)
        if job is None or any(job.get(k) != v for k, v in expected.items()):
            return False
        job.update(fields)
        return True


def release(job):
    if not IS_PRODUCTION:
        return
    try:
        _table().delete_item(Key={"user_id": job["user_id"]},
                            ConditionExpression="job_id = :j",
                            ExpressionAttributeValues={":j": job["job_id"]})
    except _table().meta.client.exceptions.ConditionalCheckFailedException:
        pass


def ready(job_id, version):
    job = db.get_annotation_job(job_id)
    if job and job["status"] == "uploading":
        change(job_id, {"status": "uploading"}, status="queued", input_version=version,
               stage="Waiting for a recognition worker", next_check_at=int(time.time()) + 300)
    return db.get_annotation_job(job_id)


def claim(job_id, token, now=None):
    now = int(time.time()) if now is None else now
    job = db.get_annotation_job(job_id)
    if not job or job["status"] not in ("queued", "processing"):
        return None
    if job["status"] == "processing" and job.get("lease_until", 0) > now:
        return None
    expected = {"status": job["status"], "attempt_count": job["attempt_count"]}
    if job["status"] == "processing":
        expected["lease_owner"] = job["lease_owner"]
        expected["lease_until"] = job["lease_until"]
    if job["attempt_count"] >= MAX_ATTEMPTS:
        if change(job_id, expected, status="failed", error="Processing failed after three attempts."):
            release(job)
        return None
    if change(job_id, expected, status="processing", lease_owner=token,
              lease_until=now + LEASE_SECONDS, heartbeat_at=now,
              next_check_at=now + LEASE_SECONDS, attempt_count=job["attempt_count"] + 1,
              stage="Reading sheet music", error=None):
        return db.get_annotation_job(job_id)
    return None


def owned(job, **fields):
    if not change(job["job_id"], {"status": "processing", "lease_owner": job["lease_owner"]}, **fields):
        raise LeaseLost(job["job_id"])


def heartbeat(job, **fields):
    """Renew the lease, and carry any progress the caller wants published."""
    now = int(time.time())
    owned(job, lease_until=now + LEASE_SECONDS, heartbeat_at=now,
          next_check_at=now + LEASE_SECONDS, **fields)


def finish(job, **fields):
    owned(job, **fields)
    release(job)


def forget_check(job):
    """Remove terminal jobs from the sparse reconciliation index."""
    if IS_PRODUCTION:
        try:
            db._annotation_job_table.update_item(Key={"job_id": job["job_id"]},
                UpdateExpression="REMOVE next_check_at",
                ConditionExpression="#s = :s",
                ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":s": job["status"]})
        except db._annotation_job_table.meta.client.exceptions.ConditionalCheckFailedException:
            pass
    else:
        with db._lock:
            row = db._annotation_jobs.get(job["job_id"])
            if row and row["status"] == job["status"]:
                row.pop("next_check_at", None)


def due(status, now):
    if not IS_PRODUCTION:
        with db._lock:
            return [dict(j) for j in db._annotation_jobs.values()
                    if j.get("storage_version") == 2 and j["status"] == status
                    and j.get("next_check_at", now + 1) <= now]
    from boto3.dynamodb.conditions import Key
    # Bounded pages per invocation; oldest entries are updated as processed.
    return db._clean(db._annotation_job_table.query(
        IndexName="work-index", Limit=100,
        KeyConditionExpression=Key("status").eq(status) & Key("next_check_at").lte(now),
    )["Items"])
