"""Seed the bundled demo sheet (see demo-sheet/) into production.

The "Try a sample" card links every visitor to config.DEMO_JOB_ID, but only
_seed_local.py ever created that job - so in production the link 404s. This
is the production counterpart of _seed_local.py's seed_demo(): it reserves
the job under the fixed demo id/owner and uploads the input to S3, exactly as
a browser upload does. From there the normal pipeline takes over (S3 event ->
SQS -> worker), so the demo is annotated by the same code as any real sheet.

Reads the table/bucket names from the deployed API Lambda, so it can't drift
from what production actually uses. Needs AWS credentials for the account.

    .venv\\Scripts\\python.exe tools\\seed_demo_prod.py
    .venv\\Scripts\\python.exe tools\\seed_demo_prod.py --status

Refuses to touch an existing demo job; delete its rows (and the demo-owner
lock row) by hand first if it ever needs re-seeding.
"""
import os
import sys
from pathlib import Path

import boto3

ROOT = Path(__file__).resolve().parent.parent
REGION = "us-west-1"
API_FUNCTION = "better-music-sheet-v2-api"

# Real environment variables win over .env (see config._load_dotenv), so this
# must run before config/db/storage are imported.
env = boto3.client("lambda", region_name=REGION).get_function_configuration(
    FunctionName=API_FUNCTION)["Environment"]["Variables"]
os.environ.update(env)
os.environ.setdefault("AWS_REGION", REGION)
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
import db  # noqa: E402
import job_state  # noqa: E402
import storage  # noqa: E402

DEMO_SHEET = ROOT / "demo-sheet" / "ode-to-joy.pdf"
# Same options as _seed_local.py's DEMO_OPTIONS.
DEMO_OPTIONS = {"style": "unicode", "octave": False, "font_size": 6.5,
                "dpi": None, "auto_retry": True, "color": "#000000"}


def status():
    job = db.get_annotation_job(config.DEMO_JOB_ID)
    if job is None:
        print(f"no {config.DEMO_JOB_ID!r} job in production")
    else:
        print(f"{config.DEMO_JOB_ID!r}: status={job['status']} stage={job.get('stage')!r} error={job.get('error')!r}")
    return job


def seed():
    assert config.IS_PRODUCTION and config.SERVERLESS, "expected the production serverless config"
    if status() is not None:
        sys.exit("demo job already exists - not touching it")
    job = job_state.create(config.DEMO_JOB_ID, config.DEMO_OWNER_ID, config.DEMO_SHEET_NAME,
                           DEMO_OPTIONS, DEMO_SHEET.stat().st_size)
    storage._s3.upload_file(str(DEMO_SHEET), storage.job_bucket(job), job["input_key"],
                            ExtraArgs={"ContentType": "application/pdf"})
    print(f"uploaded {DEMO_SHEET.name} to s3://{storage.job_bucket(job)}/{job['input_key']}")
    print("the worker picks it up from here; re-run with --status to follow it")


if __name__ == "__main__":
    status() if "--status" in sys.argv else seed()
