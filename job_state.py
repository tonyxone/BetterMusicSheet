"""Atomic reservations and fenced worker leases for new jobs.

Legacy rows are deliberately untouched. All leased updates compare the attempt
token: a late worker cannot publish over a replacement worker's result.
"""
import os
import time
from decimal import Decimal

import alerts
import db
from config import IS_PRODUCTION, LEASE_SECONDS, MAX_ATTEMPTS, UPLOAD_SECONDS


class Busy(Exception):
    pass


class LeaseLost(Exception):
    pass


# What a reader sees when recognition fails for a reason they can't fix
# themselves. Honest about it: every failure emails the operator (alerts.py),
# and a failed sheet keeps its upload, so it can be read again (retry below)
# once the cause is fixed.
UNREADABLE = ("We couldn't read the music on this sheet. We've been notified and will "
              "look into it - you can try again later.")
TOO_LONG = "This sheet took too long to read. Uploading fewer pages at a time usually helps."
NOT_STARTED = "We couldn't start reading this sheet. Please try again in a few minutes."


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
        # Where this region's API sends the upload. The row is replicated to
        # every region; this is how the others find the files (see storage.py).
        import storage
        job.update(files_bucket=os.environ["NEW_JOB_FILES_BUCKET"], files_region=storage.own_region())
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


def fail(job, expected, error, **fields):
    """Fail a job still in `expected`, free its upload slot and alert.

    Every path to "failed" outside a leased worker goes through here, so the
    operator hears about each one exactly once: whoever wins the compare-and-set.
    """
    if not change(job["job_id"], expected, status="failed", error=error, **fields):
        return False
    release(job)
    alerts.job_failed(job, error)
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
        now = int(time.time())
        change(job_id, {"status": "uploading"}, status="queued", input_version=version, queued_at=now,
               stage="Waiting for a recognition worker", next_check_at=now + 300)
    return db.get_annotation_job(job_id)


def can_retry(job):
    """Whether a failed sheet can be read again: its upload finished, so the
    file is still there. One that failed while uploading has nothing to read."""
    return job["status"] == "failed" and job.get("storage_version") == 2 and bool(job.get("input_version"))


def retry(job):
    """Queue a failed sheet to be read again, from the upload it kept.

    Takes the user's upload slot, exactly as a new upload does: Busy if
    another of their sheets is uploading or processing. False if the job
    stopped being failed meanwhile (a second click, or a delete). The
    controller sends it to the workers within a minute (next_check_at), and
    the caller may send it sooner.
    """
    now = int(time.time())
    fields = {"status": "queued", "attempt_count": 0, "error": None, "stage": "Waiting for a recognition worker",
              "queued_at": now, "next_check_at": now, "updated_at": now}
    if not IS_PRODUCTION:
        with db._lock:
            if any(j["user_id"] == job["user_id"] and j["status"] in ACTIVE for j in db._annotation_jobs.values()):
                raise Busy("You already have a sheet uploading or processing.")
            row = db._annotation_jobs.get(job["job_id"])
            if row is None or row["status"] != "failed":
                return False
            row.update(fields)
            return True
    import boto3
    names = {f"#f{i}": key for i, key in enumerate(fields)}
    values = {f":f{i}": value for i, value in enumerate(fields.values())}
    names["#s"], values[":failed"] = "status", "failed"
    try:
        boto3.client("dynamodb").transact_write_items(TransactItems=[
            {"Put": {"TableName": _table().name, "Item": _serialized({"user_id": job["user_id"], "job_id": job["job_id"]}),
                     "ConditionExpression": "attribute_not_exists(user_id)"}},
            {"Update": {"TableName": db._annotation_job_table.name, "Key": _serialized({"job_id": job["job_id"]}),
                        "UpdateExpression": "SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(fields))),
                        "ConditionExpression": "#s = :failed",
                        "ExpressionAttributeNames": names, "ExpressionAttributeValues": _serialized(values)}},
        ])
    except db._annotation_job_table.meta.client.exceptions.TransactionCanceledException as exc:
        reasons = [r.get("Code") for r in exc.response.get("CancellationReasons", [])]
        if reasons and reasons[0] == "ConditionalCheckFailed":
            raise Busy("You already have a sheet uploading or processing.") from exc
        if len(reasons) > 1 and reasons[1] == "ConditionalCheckFailed":
            return False
        raise
    return True


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
        fail(job, expected, UNREADABLE)
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
