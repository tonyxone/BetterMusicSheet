"""Publish a finished or failed sheet again, read by today's pipeline.

After a pipeline fix, a sheet that failed or read badly can be read again from
the upload it kept, without its reader uploading it again. This runs the same
processor.generate() a worker runs, on this machine, and publishes the way a
worker does: under a fresh attempt id, then a compare-and-set of the job row,
so a sheet deleted or changed meanwhile is left alone. The old attempt's files
stay, so rolling back is pointing the row's keys back at them.

Unlike a hand-run publish, it leaves a trace. The row gets republished_at and
republished_from (the output it replaced), and a "job_republished" event goes
to the worker log group next to the workers' own job_done/job_failed. So "why
did this sheet change hours after it finished" is one query, not a
reconstruction from S3 timestamps. finished_at is deliberately left alone: it
stays the time the pipeline gave the reader their answer.

Production runs go through tools/republish_prod.py, which loads production's
configuration before this module is imported.
"""
import json
import tempfile
import time
import traceback
import uuid
from pathlib import Path

import alerts
import db
import job_state
import processed_sheets
import storage
from config import IS_PRODUCTION

# Where the workers' job_done/job_failed lines already go (compute.tf).
LOG_GROUP = "/better-music-sheet-v2/worker"
REPUBLISHABLE = ("done", "failed")


class Refused(Exception):
    """The job can't be republished as it stands; nothing was changed."""


def has_edits(job):
    """Whether any reader has edited this sheet. Edits are tied to the labels
    they were made on, so a new reading can silently misplace them."""
    prefix = storage._edits_prefix(job)
    if IS_PRODUCTION:
        listed = storage._s3_for(job).list_objects_v2(Bucket=storage._edits_bucket(job), Prefix=prefix, MaxKeys=1)
        return listed.get("KeyCount", 0) > 0
    directory = storage._LOCAL_DIR / prefix
    return directory.exists() and any(directory.iterdir())


def log_event(event):
    """Print the event, and in production also put it in the worker log
    group: a laptop's stdout is not where anyone will look for it. Best
    effort - the sheet is already republished by the time this runs."""
    line = json.dumps(event, default=str)
    print(line, flush=True)
    if not IS_PRODUCTION:
        return
    try:
        import boto3
        logs = boto3.client("logs")
        stream = f"republish/{time.strftime('%Y/%m/%d')}/{uuid.uuid4().hex}"
        logs.create_log_stream(logGroupName=LOG_GROUP, logStreamName=stream)
        logs.put_log_events(logGroupName=LOG_GROUP, logStreamName=stream,
                            logEvents=[{"timestamp": int(time.time() * 1000), "message": line}])
    except Exception:
        traceback.print_exc()


def generate(job, directory):
    """processor.generate() on the job's kept upload, read from scratch.
    Imported here so the tests can stand in for it without Audiveris."""
    import processor
    storage.download_input(job, directory / "source")
    return processor.generate(directory / "source", directory, job)


def republish(job_id, allow_edits=False, dry_run=False, runner=generate, reason=None):
    """Read one sheet again and publish the result over its current one.
    Returns the job as it now stands (unchanged for a dry run)."""
    job = db.get_annotation_job(job_id)
    if job is None:
        raise Refused(f"{job_id}: no such job")
    if job.get("storage_version") != 2:
        raise Refused(f"{job_id}: a legacy sheet, from before per-job storage")
    if job["status"] not in REPUBLISHABLE:
        raise Refused(f"{job_id}: status is {job['status']!r}, not one of {REPUBLISHABLE}")
    if has_edits(job) and not allow_edits:
        raise Refused(f"{job_id}: a reader has edited this sheet; their edits are tied to the "
                      f"current labels (pass --allow-edits to republish anyway)")

    with tempfile.TemporaryDirectory(prefix="republish-") as temporary:
        directory = Path(temporary)
        result = runner(job, directory)
        quality = alerts.assess(directory / "timeline.json")
        if dry_run:
            print(json.dumps({"job_id": job_id, "dry_run": True, "count": result["count"],
                              "reasons": (quality or {}).get("reasons")}, default=str), flush=True)
            return job
        # storage.publish names an attempt by its lease; this run's own id
        # keeps it apart from every worker attempt, as a lease would.
        attempt = {**job, "lease_owner": uuid.uuid4().hex}
        keys = {"output_key": storage.publish(attempt, "output", directory / "annotated.pdf")}
        for kind in ("timeline", "labels", "notes"):
            path = directory / f"{kind}.json"
            keys[f"{kind}_key"] = storage.publish(attempt, kind, path) if path.exists() else None

    now = int(time.time())
    reasons = [str(r) for r in (quality or {}).get("reasons") or []]
    # Only over the version just read: a delete, a retry or another republish
    # in between wins, and this run's files are left unreferenced.
    expected = {"status": job["status"], "output_key": job.get("output_key")}
    if not job_state.change(job_id, expected, status="done", stage="Complete", error=None,
                            labeled_groups=result["count"], notes_named=result.get("notes_named"),
                            notes_printed=result.get("notes_printed"), review_reasons=reasons,
                            republished_at=now, republished_from=job.get("output_key"), **keys):
        raise Refused(f"{job_id}: changed while it was being read again; nothing was published over it")
    try:
        processed_sheets.add(db.get_annotation_job(job_id))
    except Exception:
        traceback.print_exc()
    log_event({"event": "job_republished", "job_id": job_id, "user_id": job.get("user_id"),
               "music_sheet_id": job.get("music_sheet_id"), "sheet_name": job.get("sheet_name"),
               "previous_status": job["status"], "previous_output_key": job.get("output_key"),
               "output_key": keys["output_key"], "queued_at": job.get("queued_at"),
               "finished_at": job.get("finished_at"), "republished_at": now,
               "reason": reason, "review_reasons": reasons})
    return db.get_annotation_job(job_id)
