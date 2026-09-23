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
import sys
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
        return set()
    loaded = set()
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key not in os.environ:
            os.environ[key] = value.strip().strip('"').strip("'")
            loaded.add(key)
    return loaded


_loaded_from_dotenv = _load_dotenv()

# A .env SUBSCRIPTIONS_TABLE points the local backend at the real table (see
# db.py). The test suite reads the same .env and writes subscriptions freely,
# so under a test runner that value is dropped and tests stay in memory. A test
# that sets the variable itself (test_serverless.py) is unaffected.
if "SUBSCRIPTIONS_TABLE" in _loaded_from_dotenv and ("unittest" in sys.modules or "pytest" in sys.modules):
    del os.environ["SUBSCRIPTIONS_TABLE"]

APP_ENV = os.environ.get("APP_ENV", "local")
IS_PRODUCTION = APP_ENV == "production"

# Explicit opt-in: the existing production service can still run during rollout.
SERVERLESS = os.environ.get("JOB_BACKEND", "local") == "sqs"
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
MAX_PAGES = int(os.environ.get("MAX_PAGES", "50"))
MAX_JOB_SECONDS = int(os.environ.get("MAX_JOB_SECONDS", "1800"))
MAX_ATTEMPTS = 3
LEASE_SECONDS = 180
UPLOAD_SECONDS = 900

# Subscription records are optional in local development, where db.py uses an
# in-memory store. Production must name the DynamoDB table explicitly.
if IS_PRODUCTION:
    SUBSCRIPTIONS_TABLE = os.environ["SUBSCRIPTIONS_TABLE"]
else:
    SUBSCRIPTIONS_TABLE = os.environ.get("SUBSCRIPTIONS_TABLE")

# Stripe is optional until somebody starts a checkout, cancels a subscription,
# or Stripe calls the webhook. Keeping these nullable lets the rest of the API
# start in local development without billing credentials.
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET")
STRIPE_PRICE_MONTHLY = os.environ.get("STRIPE_PRICE_MONTHLY")
STRIPE_PRICE_YEARLY = os.environ.get("STRIPE_PRICE_YEARLY")

# Apple billing is optional until an App Store transaction or notification is
# received. These remain nullable so the rest of the API starts without Apple
# credentials in local development.
APPLE_KEY_ID = os.environ.get("APPLE_KEY_ID")
APPLE_ISSUER_ID = os.environ.get("APPLE_ISSUER_ID")
APPLE_APP_ID = os.environ.get("APPLE_APP_ID")
APPLE_BUNDLE_ID = os.environ.get("APPLE_BUNDLE_ID")
APPLE_PRIVATE_KEY = os.environ.get("APPLE_PRIVATE_KEY")
APPLE_ENV = os.environ.get("APPLE_ENV")
APPLE_PRODUCT_MONTHLY = os.environ.get("APPLE_PRODUCT_MONTHLY")
APPLE_PRODUCT_YEARLY = os.environ.get("APPLE_PRODUCT_YEARLY")

# The bundled sample (see demo-sheet/) every visitor can play without an
# account or a subscription - see server.py's read carve-out, _seed_local.py's
# seed_demo, and better_music_sheet_web/lib/api.ts's copy of DEMO_JOB_ID,
# which must name the same job. DEMO_OWNER_ID is deliberately not
# hex-and-dashes-only, so it can never be supplied as an X-Guest-Id (see
# auth.py's _UUID_RE) and "become" the demo's owner that way.
DEMO_JOB_ID = "demo-ode-to-joy"
DEMO_OWNER_ID = "demo-owner"
DEMO_SHEET_NAME = "Ode to Joy - Beethoven.pdf"
