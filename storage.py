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
from pathlib import Path

from config import IS_PRODUCTION


def _safe_stem(sheet_name):
    """The original filename's stem, sanitized for use as an S3/local path
    segment - notably, without any "/" that would otherwise turn it into an
    unintended sub-path."""
    stem = Path(sheet_name or "").stem.strip()
    stem = re.sub(r"[\\/]+", "-", stem)
    return stem or "sheet"


def _input_key(user_id, sheet_name):
    return f"{user_id}/input/{_safe_stem(sheet_name)}.pdf"


def _output_key(user_id, sheet_name):
    return f"{user_id}/output/{_safe_stem(sheet_name)} (annotated).pdf"


def _timeline_key(user_id, sheet_name):
    """Playback timeline JSON (see ../timeline.py) - a sidecar to the
    annotated PDF, stored the same way rather than in the database, since it
    is per-sheet file content and not job state."""
    return f"{user_id}/output/{_safe_stem(sheet_name)} (timeline).json"


if IS_PRODUCTION:
    import os

    import boto3

    _s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-west-1"))
    _BUCKET = os.environ["JOB_FILES_BUCKET"]

    def upload_input_pdf(user_id, local_path, sheet_name):
        _s3.upload_file(str(local_path), _BUCKET, _input_key(user_id, sheet_name))

    def upload_output_pdf(user_id, local_path, sheet_name):
        _s3.upload_file(str(local_path), _BUCKET, _output_key(user_id, sheet_name))

    def upload_output_timeline(user_id, local_path, sheet_name):
        _s3.upload_file(str(local_path), _BUCKET, _timeline_key(user_id, sheet_name))

    def download_output_timeline(user_id, sheet_name):
        """(body, content_length) for the timeline JSON, streamed back through
        this backend for the same reason the PDF is - see download_output_pdf."""
        obj = _s3.get_object(Bucket=_BUCKET, Key=_timeline_key(user_id, sheet_name))
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

    def local_output_timeline_path(user_id, sheet_name):
        return _local_path(_timeline_key(user_id, sheet_name))

    def local_output_path(user_id, sheet_name):
        """Local-only: server.py serves this file itself instead of
        redirecting to a presigned URL (there's no S3 to presign against)."""
        return _local_path(_output_key(user_id, sheet_name))
