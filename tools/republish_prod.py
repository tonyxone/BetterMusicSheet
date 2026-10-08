"""Read production sheets again with this checkout's pipeline, and publish
the results over their current ones (see republish.py).

Reads the table and bucket names from the deployed API Lambda, like
seed_demo_prod.py, so it can't drift from what production actually uses.
Needs AWS credentials for the account and a local Audiveris (tools/Audiveris).

    .venv\\Scripts\\python.exe tools\\republish_prod.py JOB_ID [JOB_ID ...] --reason "what was fixed"
    .venv\\Scripts\\python.exe tools\\republish_prod.py JOB_ID --dry-run

--dry-run reads the sheet and reports how it went without publishing.
Refuses a sheet a reader has edited unless --allow-edits is given.
"""
import argparse
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
import republish  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("job_ids", nargs="+")
    parser.add_argument("--reason", help="what changed, kept in the job_republished log event")
    parser.add_argument("--allow-edits", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    assert config.IS_PRODUCTION and config.SERVERLESS, "expected the production serverless config"
    if not args.dry_run and not args.reason:
        parser.error("--reason is required to publish: it is what the next investigation reads")
    failed = 0
    for job_id in args.job_ids:
        try:
            republish.republish(job_id, allow_edits=args.allow_edits, dry_run=args.dry_run, reason=args.reason)
        except republish.Refused as exc:
            print(f"refused: {exc}", file=sys.stderr)
            failed += 1
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
