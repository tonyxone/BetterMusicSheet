"""S3 storage for uploaded/annotated PDFs.

Key layout is fixed and deterministic from (user_id, music_sheet_id) alone,
so no path is ever stored in DynamoDB. Reprocessing a sheet overwrites its
existing output (by design, not a bug). user_id is validated as UUID-shaped
before it ever reaches here (see auth.py) - it becomes an S3 key prefix, so
it's never trusted verbatim.
"""
import os

import boto3

_s3 = boto3.client("s3", region_name=os.environ.get("COGNITO_REGION", "us-west-1"))
_BUCKET = os.environ["JOB_FILES_BUCKET"]

PRESIGNED_URL_EXPIRY_SECONDS = 300


def _input_key(user_id, music_sheet_id):
    return f"{user_id}/{music_sheet_id}/input.pdf"


def _output_key(user_id, music_sheet_id):
    return f"{user_id}/{music_sheet_id}/annotated.pdf"


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
