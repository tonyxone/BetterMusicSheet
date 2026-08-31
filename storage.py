"""File storage for uploaded/annotated PDFs - S3 in production, a local
folder in local dev (see config.py).

Key layout is fixed and deterministic from (user_id, music_sheet_id) alone,
so no path is ever stored in db.py's job records. Reprocessing a sheet
overwrites its existing output (by design, not a bug). user_id is validated
as UUID-shaped before it ever reaches here (see auth.py) - it becomes a
storage key prefix, so it's never trusted verbatim.
"""
import shutil
from pathlib import Path

from config import IS_PRODUCTION

PRESIGNED_URL_EXPIRY_SECONDS = 300


def _input_key(user_id, music_sheet_id):
    return f"{user_id}/{music_sheet_id}/input.pdf"


def _output_key(user_id, music_sheet_id):
    return f"{user_id}/{music_sheet_id}/annotated.pdf"


if IS_PRODUCTION:
    import os

    import boto3

    _s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-west-1"))
    _BUCKET = os.environ["JOB_FILES_BUCKET"]

    def upload_input_pdf(user_id, music_sheet_id, local_path):
        _s3.upload_file(str(local_path), _BUCKET, _input_key(user_id, music_sheet_id))

    def upload_output_pdf(user_id, music_sheet_id, local_path):
        _s3.upload_file(str(local_path), _BUCKET, _output_key(user_id, music_sheet_id))

    def presigned_download_url(user_id, music_sheet_id, download_filename, inline=False):
        disposition = "inline" if inline else "attachment"
        return _s3.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": _BUCKET,
                "Key": _output_key(user_id, music_sheet_id),
                "ResponseContentDisposition": f'{disposition}; filename="{download_filename}"',
                "ResponseContentType": "application/pdf",
            },
            ExpiresIn=PRESIGNED_URL_EXPIRY_SECONDS,
        )

else:
    # Same directory tree as server.py's JOBS_DIR (server_jobs/), already
    # gitignored - these are other people's copyrighted sheet music.
    _LOCAL_DIR = Path(__file__).parent / "server_jobs" / "storage"

    def _local_path(key):
        path = _LOCAL_DIR / key
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def upload_input_pdf(user_id, music_sheet_id, local_path):
        shutil.copyfile(local_path, _local_path(_input_key(user_id, music_sheet_id)))

    def upload_output_pdf(user_id, music_sheet_id, local_path):
        shutil.copyfile(local_path, _local_path(_output_key(user_id, music_sheet_id)))

    def local_output_path(user_id, music_sheet_id):
        """Local-only: server.py serves this file itself instead of
        redirecting to a presigned URL (there's no S3 to presign against)."""
        return _local_path(_output_key(user_id, music_sheet_id))
