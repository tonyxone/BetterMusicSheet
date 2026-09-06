"""Local dev vs. AWS switch, used by auth.py/db.py/storage.py.

Local dev needs zero AWS setup by default: no S3 bucket, no DynamoDB tables,
no Cognito app - db.py keeps job/user state in memory and storage.py writes
files under server_jobs/ instead. Sign-in is the one thing that genuinely
needs a real user pool, and it's optional (see auth.py), so a local backend
without any Cognito env vars still serves every guest flow.

Production sets APP_ENV=production (see taskdef-new.json) to opt into the
real AWS-backed implementations, which still hard-require their usual env
vars (JOB_FILES_BUCKET, USERS_TABLE, COGNITO_USER_POOL_ID, ...).
"""
import os
from pathlib import Path


def _load_dotenv():
    """Read a .env beside this file into the environment, if one exists.

    Local sign-in needs the same Cognito pool the frontend points at, and
    exporting those by hand before every `python server.py` is the kind of
    setup step that silently gets skipped - the server then starts fine and
    only fails at the moment someone tries to log in. Parsed here rather than
    with python-dotenv to avoid a dependency for ~10 lines.

    Real environment variables always win, so this can't override a
    deployment's own configuration.
    """
    env_file = Path(__file__).parent / ".env"
    if not env_file.exists():
        return
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

APP_ENV = os.environ.get("APP_ENV", "local")
IS_PRODUCTION = APP_ENV == "production"
