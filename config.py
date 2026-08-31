"""Local dev vs. AWS switch, used by storage.py.

Local dev needs zero AWS setup by default: storage.py writes files under
server_jobs/ instead of S3. Production sets APP_ENV=production (see
taskdef-new.json) to opt into the real S3-backed implementation, which still
hard-requires its usual env vars (JOB_FILES_BUCKET, AWS_REGION).

auth.py and db.py don't need this switch - there's no AWS dependency in
either environment (see their own docstrings).
"""
import os

APP_ENV = os.environ.get("APP_ENV", "local")
IS_PRODUCTION = APP_ENV == "production"
