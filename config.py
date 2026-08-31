"""Local dev vs. AWS switch, used by auth.py/db.py/storage.py.

Local dev needs zero AWS setup by default: no S3 bucket, no DynamoDB tables,
no Cognito app - db.py keeps job/user state in memory and storage.py writes
files under server_jobs/ instead. Production sets APP_ENV=production (see
taskdef-new.json) to opt into the real AWS-backed implementations, which
still hard-require their usual env vars (JOB_FILES_BUCKET, USERS_TABLE, ...).
"""
import os

APP_ENV = os.environ.get("APP_ENV", "local")
IS_PRODUCTION = APP_ENV == "production"
