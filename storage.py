"""File storage for uploaded/annotated PDFs - S3 in production, a local
folder in local dev (see config.py).

Key layout is /{user_id}/input/{name}.pdf and /{user_id}/output/{name}
(annotated).pdf, where {name} is the original uploaded filename's stem - so
a key is recognizable on its own (e.g. in the S3 console), not just via
db.py's job records. Deliberately NOT keyed by music_sheet_id/job_id:
uploading (or reprocessing) a same-named sheet again overwrites its previous
input/output, by design, not a bug.

{user_id} is the signed-in user's Cognito id when there is one, and their
anonymous per-browser guest id otherwise - auth.py decides which, and
validates either as UUID-shaped before it ever reaches here, since it
becomes a storage key prefix and so is never trusted verbatim. A visitor who
signs in mid-session therefore starts writing under a different prefix;
sheets they uploaded as a guest stay where they are.
"""
import re
import shutil
import os
from pathlib import Path

from config import IS_PRODUCTION


def job_bucket(job):
    return os.environ["NEW_JOB_FILES_BUCKET"] if job.get("storage_version") == 2 else os.environ["JOB_FILES_BUCKET"]


def artifact_key(job, kind):
    if job.get("storage_version") == 2:
        return job.get(f"{kind}_key")
    legacy = {"output": _output_key, "timeline": _timeline_key, "input": _input_key}.get(kind)
    if legacy is None:
        return None  # e.g. "labels": sheets from before per-job storage never had one
    name = job.get("sheet_name") or job["music_sheet_id"]
    return legacy(job["user_id"], name)


def create_upload(job, content_type):
    from config import UPLOAD_SECONDS
    return _s3.generate_presigned_post(
        Bucket=job_bucket(job), Key=job["input_key"],
        Fields={"Content-Type": content_type},
        Conditions=[{"Content-Type": content_type}, ["content-length-range", job["size"], job["size"]]],
        ExpiresIn=UPLOAD_SECONDS,
    )


def input_info(job, version=None):
    if IS_PRODUCTION:
        try:
            return _s3.head_object(Bucket=job_bucket(job), Key=job["input_key"],
                                   **({"VersionId": version} if version else {}))
        except _s3.exceptions.ClientError as exc:
            if exc.response["Error"]["Code"] in ("404", "NoSuchKey", "NoSuchVersion"):
                return None
            raise
    path = _local_path(job["input_key"])
    return {"ContentLength": path.stat().st_size, "VersionId": "local"} if path.exists() else None


def download_input(job, destination):
    key = artifact_key(job, "input")
    if IS_PRODUCTION:
        extra = {"VersionId": job["input_version"]} if job.get("input_version") else {}
        _s3.download_file(job_bucket(job), key, str(destination), ExtraArgs=extra)
    else:
        shutil.copyfile(_local_path(key), destination)


def publish(job, kind, path):
    # An attempt never overwrites another attempt's objects. Only the winner's
    # keys become visible through the conditional job completion update.
    key = f"jobs/{job['user_id']}/{job['job_id']}/attempts/{job['lease_owner']}/{kind}"
    if IS_PRODUCTION:
        _s3.upload_file(str(path), job_bucket(job), key,
                        ExtraArgs={"ContentType": "application/pdf" if kind == "output" else "application/json"})
    else:
        shutil.copyfile(path, _local_path(key))
    return key


def read_artifact(job, kind):
    key = artifact_key(job, kind)
    if not key:
        raise FileNotFoundError(kind)
    if IS_PRODUCTION:
        return _s3.get_object(Bucket=job_bucket(job), Key=key)
    return _local_path(key)


def presign_artifact(job, kind, disposition=None):
    key = artifact_key(job, kind)
    if not key:
        return None
    params = {"Bucket": job_bucket(job), "Key": key}
    try:
        _s3.head_object(**params)
    except _s3.exceptions.ClientError as exc:
        if exc.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return None
        raise
    # Sheets annotated before the migration were stored as binary/octet-stream.
    # That never showed while the API streamed them, because it set the media
    # type on the response itself. A presigned URL hands the browser whatever
    # S3 holds, and a PDF labelled octet-stream cannot be rendered in a frame -
    # it downloads instead, named after the blob. Override the type here so old
    # and new objects behave the same.
    params["ResponseContentType"] = (
        upload_media_type(job.get("sheet_name")) if kind == "input"
        else "application/pdf" if kind == "output" else "application/json")
    if disposition:
        params["ResponseContentDisposition"] = disposition
    return _s3.generate_presigned_url("get_object", Params=params, ExpiresIn=300)


# ---- per-reader edits: moved/retyped labels, drawings, notes, corrections ----
#
# One JSON document per (sheet, reader), keyed by the READER rather than the
# sheet's owner, so anyone can mark up the shared demo sheet without touching
# what other visitors see. Always stored in the per-job bucket under the job's
# own prefix - the API may write there for every sheet, legacy ones included,
# and deleting the job's prefix takes the edits with it.

EDITS_MAX_BYTES = 2_000_000


def _edits_prefix(job):
    return f"jobs/{job['user_id']}/{job['job_id']}/edits/"


def _edits_key(job, reader_id):
    return f"{_edits_prefix(job)}{reader_id}.json"


def read_edits(job, reader_id):
    """The stored document as bytes, or None if this reader has none yet."""
    key = _edits_key(job, reader_id)
    if IS_PRODUCTION:
        try:
            return _s3.get_object(Bucket=os.environ["NEW_JOB_FILES_BUCKET"], Key=key)["Body"].read()
        except _s3.exceptions.ClientError as exc:
            if exc.response["Error"]["Code"] in ("404", "NoSuchKey"):
                return None
            raise
    path = _LOCAL_DIR / key
    return path.read_bytes() if path.exists() else None


def write_edits(job, reader_id, data):
    key = _edits_key(job, reader_id)
    if IS_PRODUCTION:
        _s3.put_object(Bucket=os.environ["NEW_JOB_FILES_BUCKET"], Key=key, Body=data,
                       ContentType="application/json")
    else:
        path = _local_path(key)
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(data)
        os.replace(temporary, path)


def delete_edits(job):
    """Every reader's edits for one sheet. delete_job_files() already covers
    per-job sheets; legacy sheets keep their files elsewhere and need this."""
    if IS_PRODUCTION:
        _delete_prefix(os.environ["NEW_JOB_FILES_BUCKET"], _edits_prefix(job))
    else:
        root = _LOCAL_DIR.resolve()
        target = (root / _edits_prefix(job)).resolve()
        if not target.is_relative_to(root) or target == root:
            raise ValueError("Invalid job directory")
        shutil.rmtree(target, ignore_errors=True)


def _delete_prefix(bucket, prefix):
    for page in _s3.get_paginator("list_object_versions").paginate(Bucket=bucket, Prefix=prefix):
        objects = [{"Key": v["Key"], "VersionId": v["VersionId"]}
                   for v in page.get("Versions", []) + page.get("DeleteMarkers", [])]
        for offset in range(0, len(objects), 1000):
            result = _s3.delete_objects(Bucket=bucket, Delete={"Objects": objects[offset:offset + 1000]})
            if result.get("Errors"):
                raise RuntimeError("Some sheet files could not be deleted. Please retry.")


def delete_job_files(job):
    """Delete all attempts AND all upload versions, including failed attempts."""
    prefix = f"jobs/{job['user_id']}/{job['job_id']}/"
    if IS_PRODUCTION:
        _delete_prefix(job_bucket(job), prefix)
    else:
        root = _LOCAL_DIR.resolve()
        target = (root / prefix).resolve()
        if not target.is_relative_to(root) or target == root:
            raise ValueError("Invalid job directory")
        shutil.rmtree(target, ignore_errors=True)


def _safe_stem(sheet_name):
    """The original filename's stem, sanitized for use as an S3/local path
    segment - notably, without any "/" that would otherwise turn it into an
    unintended sub-path."""
    stem = Path(sheet_name or "").stem.strip()
    stem = re.sub(r"[\\/]+", "-", stem)
    return stem or "sheet"


_UPLOAD_MEDIA_TYPES = {".pdf": "application/pdf", ".jpg": "image/jpeg",
                       ".jpeg": "image/jpeg", ".png": "image/png"}


def upload_media_type(sheet_name):
    """The media type of the file the visitor actually uploaded.

    The stored input is whatever was sent: a photo is converted to PDF in the
    worker's scratch directory (see processor.py) and that copy is never
    stored. Neither key layout records the type - v1 names every input
    ".pdf" whatever it holds, and v2 ends the key at "input" - but the sheet
    name is the uploaded filename, so its extension is the one record of it.
    Unknown extensions fall back to PDF, which is what all but a handful of
    uploads are.
    """
    return _UPLOAD_MEDIA_TYPES.get(Path(sheet_name or "").suffix.lower(), "application/pdf")


def _input_key(user_id, sheet_name):
    return f"{user_id}/input/{_safe_stem(sheet_name)}.pdf"


def _output_key(user_id, sheet_name):
    return f"{user_id}/output/{_safe_stem(sheet_name)} (annotated).pdf"


def _timeline_key(user_id, sheet_name):
    """Playback timeline JSON (see ../timeline.py) - a sidecar to the
    annotated PDF, stored the same way rather than in the database, since it
    is per-sheet file content and not job state."""
    return f"{user_id}/output/{_safe_stem(sheet_name)} (timeline).json"


def storage_identity(sheet_name):
    """Return the part of a filename that identifies its shared artifacts.

    Same-named uploads intentionally overwrite the same S3 keys.  Callers
    use this when deleting history so removing one row cannot break another
    row that still points at those shared files.
    """
    return _safe_stem(sheet_name)


if IS_PRODUCTION:
    import os

    import boto3
    from botocore.config import Config

    # region_name alone still signs against the global s3.amazonaws.com host, so
    # every presigned upload and download answers 307 and the browser repeats the
    # request - a redirected POST re-sends the whole file, doubling the bytes a
    # user uploads. Pin the regional virtual-hosted endpoint instead.
    _s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-west-1"),
                       config=Config(s3={"addressing_style": "virtual"}, signature_version="s3v4"))
    _BUCKET = os.environ["JOB_FILES_BUCKET"]

    def upload_input_pdf(user_id, local_path, sheet_name):
        _s3.upload_file(str(local_path), _BUCKET, _input_key(user_id, sheet_name))

    def upload_output_pdf(user_id, local_path, sheet_name):
        _s3.upload_file(str(local_path), _BUCKET, _output_key(user_id, sheet_name))

    def upload_output_timeline(user_id, local_path, sheet_name):
        _s3.upload_file(str(local_path), _BUCKET, _timeline_key(user_id, sheet_name))

    def delete_sheet_files(user_id, sheet_name):
        """Delete every stored artifact for a sheet.

        S3 deletion is idempotent, so an older sheet without a timeline (or
        an already-partially-deleted sheet) can still be removed cleanly.
        """
        for key in (
            _input_key(user_id, sheet_name),
            _output_key(user_id, sheet_name),
            _timeline_key(user_id, sheet_name),
        ):
            _s3.delete_object(Bucket=_BUCKET, Key=key)

    def download_output_timeline(user_id, sheet_name):
        """(body, content_length) for the timeline JSON, streamed back through
        this backend for the same reason the PDF is - see download_output_pdf."""
        obj = _s3.get_object(Bucket=_BUCKET, Key=_timeline_key(user_id, sheet_name))
        return obj["Body"], obj["ContentLength"]

    def download_input_pdf(user_id, sheet_name):
        """(body, content_length) for the file as it was uploaded, streamed
        back through this backend for the same reason the annotated copy is -
        see download_output_pdf."""
        obj = _s3.get_object(Bucket=_BUCKET, Key=_input_key(user_id, sheet_name))
        return obj["Body"], obj["ContentLength"]

    def download_output_pdf(user_id, sheet_name):
        """Returns (body, content_length) for the annotated PDF, to be
        streamed back through this backend rather than redirecting the
        browser straight to S3. A presigned-URL redirect was tried first,
        but browsers don't reliably forward the X-Guest-Id header (needed to
        identify the owner before this call) across a cross-origin redirect
        in a way that survives CORS - it fails with a generic "Failed to
        fetch" despite every individual CORS check passing when tested in
        isolation. Streaming through the same origin as the rest of the API
        sidesteps that entirely."""
        obj = _s3.get_object(Bucket=_BUCKET, Key=_output_key(user_id, sheet_name))
        return obj["Body"], obj["ContentLength"]

else:
    # Same directory tree as server.py's JOBS_DIR (server_jobs/), already
    # gitignored - these are other people's copyrighted sheet music.
    _LOCAL_DIR = Path(__file__).parent / "server_jobs" / "storage"

    def _local_path(key):
        path = _LOCAL_DIR / key
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def upload_input_pdf(user_id, local_path, sheet_name):
        shutil.copyfile(local_path, _local_path(_input_key(user_id, sheet_name)))

    def upload_output_pdf(user_id, local_path, sheet_name):
        shutil.copyfile(local_path, _local_path(_output_key(user_id, sheet_name)))

    def upload_output_timeline(user_id, local_path, sheet_name):
        shutil.copyfile(local_path, _local_path(_timeline_key(user_id, sheet_name)))

    def delete_sheet_files(user_id, sheet_name):
        """Local equivalent of the production S3 artifact deletion."""
        for key in (
            _input_key(user_id, sheet_name),
            _output_key(user_id, sheet_name),
            _timeline_key(user_id, sheet_name),
        ):
            (_LOCAL_DIR / key).unlink(missing_ok=True)

    def local_output_timeline_path(user_id, sheet_name):
        return _local_path(_timeline_key(user_id, sheet_name))

    def local_input_path(user_id, sheet_name):
        """Local-only counterpart of local_output_path, for the uploaded file."""
        return _local_path(_input_key(user_id, sheet_name))

    def local_output_path(user_id, sheet_name):
        """Local-only: server.py serves this file itself instead of
        redirecting to a presigned URL (there's no S3 to presign against)."""
        return _local_path(_output_key(user_id, sheet_name))
