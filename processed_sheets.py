"""Finished sheets by the hash of the file uploaded, so the same file uploaded
again - by anyone, under any name - reuses what was made from it instead of
reading the music again.

One row per finished job, keyed by the upload's SHA-256 (storage.
content_sha256) and then by the job, so one hash can have many rows: one for
every sheet still made from that file. A row names the job and the settings
that made it; where its results are is read from the job itself when it is
picked, so a sheet republished after a fix is reused as republished. It is
written when the job finishes and removed when the job is deleted, before its
files go - and once every sheet made from a file has been deleted, the file is
forgotten.

Only rows from the current recognition (config.CACHE_EPOCH) and from this
region's bucket are used: the worker and controller only reach their own
region's files (see storage.py).

Best effort throughout, and nothing here raises: a lookup that fails is a
miss, and the sheet is read from scratch as it always was; a row that can't
be written or removed only means one fewer reuse. worker.py wraps every use
of it the same way.
"""
import os
import threading
import traceback

import config

# What draws the names. A match made with other values is drawn again from its
# saved notes (run.redraw_pdf) rather than copied.
DRAWING = ("style", "octave", "notation", "font_size", "color")
# What reads the music. A match made with other values is no match at all:
# the uploader asked for a different reading.
READING = ("dpi", "auto_retry")

# How many of a file's rows a lookup considers, newest first.
LOOKUP_LIMIT = 25

_lock = threading.Lock()
_rows = {}  # local dev: (content_sha256, sort) -> row
_tables = {}


def settings(job):
    """The job's settings as stored in a row, in one spelling: font size as
    text (DynamoDB has no floats), colour in lower case, dpi None for auto."""
    dpi = job.get("dpi")
    return {
        "style": job.get("style") or "unicode",
        "octave": bool(job.get("octave")),
        "notation": job.get("notation") or "letters",
        "font_size": f"{float(job.get('font_size') or 6.5):g}",
        "color": (job.get("color") or "#000000").lower(),
        "dpi": int(dpi) if dpi else None,
        "auto_retry": bool(job.get("auto_retry", True)),
    }


def _sort(job):
    return f"{int(job['created_at']):012d}#{job['job_id']}"


def _enabled():
    return not config.IS_PRODUCTION or bool(os.environ.get("PROCESSED_SHEET_TABLE"))


def _region():
    return os.environ.get("AWS_REGION", "us-west-1")


def _table():
    name = os.environ["PROCESSED_SHEET_TABLE"]
    if name not in _tables:
        import boto3
        _tables[name] = boto3.resource("dynamodb", region_name=_region()).Table(name)
    return _tables[name]


def _row(job):
    row = {
        "content_sha256": job["content_sha256"], "sort": _sort(job), "job_id": job["job_id"],
        "created_at": int(job["created_at"]), "cache_epoch": config.CACHE_EPOCH,
        "settings": settings(job),
    }
    if job.get("files_region"):
        row["files_region"] = job["files_region"]
    return row


def add(job):
    """Record a finished job's results as reusable. Only while the job is
    still done and still made from this file: written in one transaction with
    that check, so a sheet deleted meanwhile is never recorded."""
    try:
        if not job or not job.get("content_sha256") or not job.get("output_key") or not _enabled():
            return False
        row = _row(job)
        if not config.IS_PRODUCTION:
            import db
            with db._lock:
                current = db._annotation_jobs.get(job["job_id"])
                if not current or current["status"] != "done" or current.get("content_sha256") != job["content_sha256"]:
                    return False
                with _lock:
                    _rows[(row["content_sha256"], row["sort"])] = row
            return True
        import boto3
        from boto3.dynamodb.types import TypeSerializer
        serializer = TypeSerializer()
        client = boto3.client("dynamodb", region_name=_region())
        try:
            client.transact_write_items(TransactItems=[
                {"ConditionCheck": {
                    "TableName": os.environ["ANNOTATION_JOB_TABLE"],
                    "Key": {"job_id": {"S": job["job_id"]}},
                    "ConditionExpression": "#s = :done AND content_sha256 = :h",
                    "ExpressionAttributeNames": {"#s": "status"},
                    "ExpressionAttributeValues": {":done": {"S": "done"}, ":h": {"S": job["content_sha256"]}},
                }},
                {"Put": {"TableName": os.environ["PROCESSED_SHEET_TABLE"],
                         "Item": {k: serializer.serialize(v) for k, v in row.items()}}},
            ])
        except client.exceptions.TransactionCanceledException:
            return False
        return True
    except Exception:
        traceback.print_exc()
        return False


def remove(job):
    """Forget a job's results. Called before its files are deleted, and never
    stops that: a row left behind is passed over once its sheet is gone."""
    try:
        if job.get("content_sha256") and job.get("created_at") is not None:
            discard({"content_sha256": job["content_sha256"], "sort": _sort(job)})
    except Exception:
        traceback.print_exc()


def discard(row):
    if not _enabled():
        return
    try:
        if not config.IS_PRODUCTION:
            with _lock:
                _rows.pop((row["content_sha256"], row["sort"]), None)
            return
        _table().delete_item(Key={"content_sha256": row["content_sha256"], "sort": row["sort"]})
    except Exception:
        traceback.print_exc()


def _candidates(content_sha256):
    if not config.IS_PRODUCTION:
        with _lock:
            rows = [dict(r) for (h, _), r in _rows.items() if h == content_sha256]
        return sorted(rows, key=lambda r: r["sort"], reverse=True)[:LOOKUP_LIMIT]
    from boto3.dynamodb.conditions import Key
    import db
    return db._clean(_table().query(KeyConditionExpression=Key("content_sha256").eq(content_sha256),
                                    ScanIndexForward=False, Limit=LOOKUP_LIMIT)["Items"])


def find(content_sha256, job):
    """The earlier sheet to reuse for ``job``, made from the same file, as
    its job: ``(source, True)`` when it was made with the same settings, so
    its files can be copied as they are; ``(source, False)`` when only the
    names need drawing again, from its saved notes; None when nothing usable
    was made yet."""
    if not content_sha256 or not _enabled():
        return None
    try:
        wanted = settings(job)
        redraw = None
        for row in _candidates(content_sha256):
            if row["job_id"] == job["job_id"] or row.get("cache_epoch") != config.CACHE_EPOCH:
                continue
            if config.IS_PRODUCTION and row.get("files_region") != _region():
                continue
            made = row.get("settings") or {}
            if any(made.get(key) != wanted[key] for key in READING):
                continue
            exact = all(made.get(key) == wanted[key] for key in DRAWING)
            if not exact and redraw is not None:
                continue
            source = _source(row)
            if source is None or (not exact and not source.get("notes_key")):
                continue
            if exact:
                return source, True
            redraw = source
        return (redraw, False) if redraw else None
    except Exception:
        traceback.print_exc()
        return None


def _source(row):
    """The row's job, while it is still a finished sheet made from this
    file. A row whose sheet is gone or going is dropped on the way."""
    import db
    source = db.get_annotation_job(row["job_id"])
    if (source and source["status"] == "done" and source.get("output_key")
            and source.get("content_sha256") == row["content_sha256"]):
        return source
    if not source or source["status"] in ("deleting", "deleted"):
        discard(row)
    return None
