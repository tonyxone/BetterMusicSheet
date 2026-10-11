"""API for the private admin dashboard (better_music_sheet_web/app/admin/).

Every route answers exactly as a route that doesn't exist would - 404 with
FastAPI's own "Not Found" body - unless the caller is signed in as an account
listed in the admin table (see db.is_admin). A visitor, a guest, an expired
or forged token and an ordinary account all get the same answer, so nothing
here even confirms the dashboard exists.

Read-only on purpose: nothing here changes a user, a job or a subscription.
People appear by user id only (owner decision): no name or email is shown,
returned or even read for it - see db.all_accounts.
And isolated: an error in any route here is that one request's 500, and
server.py still serves everything else if this module can't even be loaded.
"""
import os
import statistics
import time
import traceback
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse

import config
import db
import storage
from auth import get_signed_in_user_id

DAY = 86400
ACTIVE = ("uploading", "queued", "processing")
REMOVED = ("deleting", "deleted")
PAGE_SIZE = 25
MAX_PAGE_SIZE = 200


def require_admin(authorization: str = Header(None)):
    try:
        user_id = get_signed_in_user_id(authorization)
    except HTTPException:
        # A bad token would otherwise answer 401 - which a route that doesn't
        # exist never does.
        user_id = None
    try:
        admin = user_id is not None and db.is_admin(user_id)
    except Exception:
        # e.g. the admin table missing in this region. Still just a 404.
        traceback.print_exc()
        admin = False
    if not admin:
        raise HTTPException(404, "Not Found")
    return user_id


router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin)])


def _subscription_view(subscription, now):
    if subscription is None:
        return None
    period_end = subscription.get("current_period_end")
    # Mirrors auth._subscription_entitlement, which reads one account at a
    # time: a scheduled cancellation (and every Apple period) stops granting
    # access at its period end, whether or not the provider has said so yet.
    lapsed = ((subscription.get("cancel_at_period_end") or subscription.get("platform") == "apple")
              and period_end is not None and period_end <= now)
    return {
        "status": subscription.get("status"),
        "plan": subscription.get("plan"),
        "platform": subscription.get("platform"),
        "started_at": subscription.get("started_at"),
        "current_period_end": period_end,
        "cancel_at_period_end": bool(subscription.get("cancel_at_period_end")),
        "canceled_at": subscription.get("canceled_at"),
        "ended_at": subscription.get("ended_at"),
        "premium": subscription.get("status") in ("active", "trialing") and not lapsed,
    }


def processing_seconds(job):
    """Queue to finish, so it includes waiting for a worker to start; None
    until the job is done. Ends at finished_at, set once when the job ended -
    updated_at moves again with every later touch (a review note, a hand
    republish, a delete), which once showed day-old sheets as 9-13 hour
    jobs. Rows from before finished_at existed fall back to updated_at."""
    queued = job.get("queued_at")
    ended = job.get("finished_at") or job.get("updated_at")
    if job.get("status") != "done" or not queued or not ended:
        return None
    return max(ended - queued, 0)


def _job_view(job, sheet_names, accounts=None):
    view = {
        "job_id": job["job_id"],
        "user_id": job["user_id"],
        "sheet_name": job.get("sheet_name") or sheet_names.get(job.get("music_sheet_id")),
        "status": job.get("status"),
        "stage": job.get("stage"),
        "error": job.get("error"),
        "review_reasons": job.get("review_reasons"),
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
        "republished_at": job.get("republished_at"),
        "seconds": processing_seconds(job),
        "size": job.get("size"),
        "attempts": job.get("attempt_count"),
        "region": storage.job_region(job) if config.IS_PRODUCTION else None,
    }
    if accounts is not None:
        # Only signed-in accounts have a users row (see db.py).
        view["guest"] = job["user_id"] not in accounts
    return view


def _jobs():
    """Every real upload - the bundled demo sheet is not one."""
    return [job for job in db.all_annotation_jobs() if job["user_id"] != config.DEMO_OWNER_ID]


def _page(rows, page, page_size):
    """One page of a list, newest first already, with what the pager needs."""
    page_size = max(1, min(page_size, MAX_PAGE_SIZE))
    pages = max(1, -(-len(rows) // page_size))
    page = max(1, min(page, pages))
    return {"items": rows[(page - 1) * page_size:page * page_size], "total": len(rows),
            "page": page, "pages": pages, "page_size": page_size}


def _matching(user_id, q):
    return not q or q.strip().lower() in user_id.lower()


def _sheet_names():
    return {sheet["music_sheet_id"]: sheet.get("sheet_name") for sheet in db.all_music_sheets()}


@router.get("/me")
def me(user_id: str = Depends(require_admin)):
    return {"user_id": user_id}


@router.get("/overview")
def overview():
    now = int(time.time())
    users = db.all_accounts()
    subscriptions = [_subscription_view(s, now) for s in db.all_subscriptions()]
    jobs = _jobs()
    recent = [j for j in jobs if (j.get("created_at") or 0) >= now - 30 * DAY]
    done = [j for j in recent if j.get("status") == "done"]
    failed = [j for j in recent if j.get("status") == "failed"]
    seconds = [s for s in (processing_seconds(j) for j in done) if s is not None]
    premium = [s for s in subscriptions if s["premium"]]
    return {
        "users": {
            "total": len(users),
            "new_7d": sum((u.get("created_at") or 0) >= now - 7 * DAY for u in users),
            "new_30d": sum((u.get("created_at") or 0) >= now - 30 * DAY for u in users),
        },
        "subscriptions": {
            "premium": len(premium),
            "trialing": sum(s["status"] == "trialing" for s in premium),
            "canceling": sum(s["cancel_at_period_end"] for s in premium),
            "stripe": sum(s["platform"] == "stripe" for s in premium),
            "apple": sum(s["platform"] == "apple" for s in premium),
            "ended": sum(not s["premium"] for s in subscriptions),
        },
        "uploads": {
            "total": len(jobs),
            "last_7d": sum((j.get("created_at") or 0) >= now - 7 * DAY for j in jobs),
            "last_30d": len(recent),
            "failed_30d": len(failed),
            "review_30d": sum(bool(j.get("review_reasons")) for j in done),
            "failure_rate_30d": len(failed) / (len(done) + len(failed)) if done or failed else None,
            "median_seconds_30d": statistics.median(seconds) if seconds else None,
            "in_progress": sum(j.get("status") in ACTIVE for j in jobs),
        },
    }


SUBSCRIPTION_STATES = ("active", "trial", "canceling", "past_due", "canceled")


def _subscription_state(view):
    """Where a subscription stands, one state each so the counts add up:
    paying, on a free trial, still Premium but not renewing, a failed renewal,
    or no longer Premium at all."""
    if view["premium"]:
        if view["cancel_at_period_end"]:
            return "canceling"
        return "trial" if view["status"] == "trialing" else "active"
    return "past_due" if view["status"] == "past_due" else "canceled"


def _within(when, days, now):
    """Whether `when` falls in the last `days` days; no limit when days is 0."""
    return not days or (when or 0) >= now - days * DAY


@router.get("/users")
def users(q: str = "", joined: int = 0, plan: str = "", subscribed: int = 0, canceled: int = 0,
          uploads: str = "", page: int = 1, page_size: int = PAGE_SIZE):
    """Accounts, newest first, one page at a time. Each filter narrows one
    column: `q` user ids containing it; `joined`, `subscribed` and `canceled`
    to the last that many days; `plan` to "free", "master" or a subscription
    state (see _subscription_state); `uploads` to "none", "some" or
    "failed" (at least one failed)."""
    now = int(time.time())
    subscriptions = {s["user_id"]: s for s in db.all_subscriptions()}
    masters = db.all_master_users()
    jobs_by_user = {}
    for job in _jobs():
        if job.get("status") not in REMOVED:
            jobs_by_user.setdefault(job["user_id"], []).append(job)
    rows = []
    for user in db.all_accounts():
        if not _matching(user["user_id"], q) or not _within(user.get("created_at"), joined, now):
            continue
        mine = jobs_by_user.get(user["user_id"], [])
        subscription = _subscription_view(subscriptions.get(user["user_id"]), now)
        master = user["user_id"] in masters
        row = {
            "user_id": user["user_id"],
            "created_at": user.get("created_at"),
            "master": master,
            "subscription": subscription,
            "uploads": len(mine),
            "failed": sum(j.get("status") == "failed" for j in mine),
            "last_upload_at": max((j.get("created_at") or 0 for j in mine), default=None),
        }
        if plan:
            # Read the way the Plan badge reads: a subscription that grants
            # Premium wins over a master grant, and a master grant over one
            # that ended.
            state = _subscription_state(subscription) if subscription else None
            shown = (state if subscription and subscription["premium"]
                     else "master" if master else state or "free")
            if shown != plan:
                continue
        if subscribed and not (subscription and _within(subscription["started_at"], subscribed, now)):
            continue
        if canceled and not (subscription and subscription["canceled_at"]
                             and _within(subscription["canceled_at"], canceled, now)):
            continue
        if ((uploads == "none" and row["uploads"]) or (uploads == "some" and not row["uploads"])
                or (uploads == "failed" and not row["failed"])):
            continue
        rows.append(row)
    rows.sort(key=lambda row: row["created_at"] or 0, reverse=True)
    return _page(rows, page, page_size)


@router.get("/subscriptions")
def subscriptions(state: str = "", page: int = 1, page_size: int = PAGE_SIZE):
    """Every subscription ever started, newest first, with how many are in
    each state; `state` narrows the list (not the counts) to one of them."""
    now = int(time.time())
    rows = []
    for subscription in db.all_subscriptions():
        view = _subscription_view(subscription, now)
        rows.append({"user_id": subscription["user_id"], "state": _subscription_state(view), **view})
    counts = {name: sum(row["state"] == name for row in rows) for name in SUBSCRIPTION_STATES}
    if state:
        rows = [row for row in rows if row["state"] == state]
    rows.sort(key=lambda row: row["started_at"] or 0, reverse=True)
    return {**_page(rows, page, page_size), "counts": counts}


@router.get("/users/{user_id}/uploads")
def user_uploads(user_id: str):
    """Everything the account uploaded, newest first - deleted ones included,
    marked as such, since "they deleted it" is worth knowing too."""
    names = {s["music_sheet_id"]: s.get("sheet_name") for s in db.list_music_sheets(user_id)}
    return [_job_view(job, names) for job in db.list_annotation_jobs(user_id)]


MB = 1024 * 1024
SIZES = {"small": (0, MB), "medium": (MB, 10 * MB), "large": (10 * MB, float("inf"))}


def _outcome(job):
    """How a finished upload came out - "done", "warning" (done, but emailed
    as needing review) or "failed" - or None while it isn't finished."""
    if job.get("status") == "failed":
        return "failed"
    if job.get("status") == "done":
        return "warning" if job.get("review_reasons") else "done"
    return None


@router.get("/uploads")
def uploads(status: str = None, q: str = "", sheet: str = "", owner: str = "", since: int = 0,
            min_seconds: int = 0, size: str = "", page: int = 1, page_size: int = PAGE_SIZE):
    """Every upload, newest first, one page at a time. Each filter narrows one
    column: `status` a job status, "active" (not finished yet), or an outcome
    (see _outcome; "review" is the older name for "warning"); `q` owners whose user id
    contains it; `owner` "guest" or "account"; `sheet` sheet names or job ids
    containing it; `since` the last that many days; `min_seconds` processing
    times at least that long; `size` "small" (under 1 MB), "medium" or "large"
    (over 10 MB).

    `summary` counts how the uploads matching every filter but `status` came
    out, so the totals stay put while the list is narrowed to one of them."""
    now = int(time.time())
    accounts = {u["user_id"] for u in db.all_accounts()}
    names = _sheet_names()
    jobs = []
    for job in _jobs():
        view = _job_view(job, names, accounts)
        low, high = SIZES.get(size, (0, float("inf")))
        if (not _matching(job["user_id"], q)
                or (owner == "guest" and not view["guest"]) or (owner == "account" and view["guest"])
                or (sheet and sheet.strip().lower() not in f"{view['sheet_name'] or ''} {job['job_id']}".lower())
                or not _within(job.get("created_at"), since, now)
                or (min_seconds and (view["seconds"] or 0) < min_seconds)
                or (size and not low <= (job.get("size") or 0) < high)):
            continue
        jobs.append((job, view))
    outcomes = [_outcome(job) for job, _ in jobs]
    summary = {name: outcomes.count(name) for name in ("done", "warning", "failed")}
    summary["processed"] = sum(summary.values())
    if status == "active":
        jobs = [(j, v) for j, v in jobs if j.get("status") in ACTIVE]
    elif status in ("done", "warning", "review"):
        # "done" is done without a warning, so it matches its summary count.
        wanted = "warning" if status == "review" else status
        jobs = [(j, v) for j, v in jobs if _outcome(j) == wanted]
    elif status:
        jobs = [(j, v) for j, v in jobs if j.get("status") == status]
    jobs.sort(key=lambda pair: pair[0].get("created_at") or 0, reverse=True)
    listed = _page([view for _, view in jobs], page, page_size)
    return {**listed, "summary": summary}


def _job_or_404(job_id):
    job = db.get_annotation_job(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    if not job.get("sheet_name"):
        sheet = db.get_music_sheet(job["music_sheet_id"])
        job = {**job, "sheet_name": sheet["sheet_name"] if sheet else job["music_sheet_id"]}
    return job


@router.get("/uploads/{job_id}/files")
def upload_files(job_id: str):
    """Links to open the file as uploaded and the annotated result, each None
    when it isn't there. In production they are short-lived S3 links: an
    upload can be larger than a Lambda response may be. Locally they are the
    route below, which needs the admin's token, so `direct` is false."""
    job = _job_or_404(job_id)
    done = job.get("status") == "done"
    if config.IS_PRODUCTION:
        return {"direct": True, "original": storage.presign_artifact(job, "input"),
                "annotated": storage.presign_artifact(job, "output") if done else None}
    return {"direct": False,
            "original": f"/api/admin/uploads/{job_id}/file/input" if _local_file(job, "input") else None,
            "annotated": f"/api/admin/uploads/{job_id}/file/output" if done and _local_file(job, "output") else None}


def _local_file(job, kind):
    try:
        path = Path(storage.read_artifact(job, kind))
    except FileNotFoundError:
        return None
    return path if path.exists() else None


@router.get("/uploads/{job_id}/file/{kind}")
def upload_file(job_id: str, kind: str):
    """Local development only - see upload_files."""
    if config.IS_PRODUCTION or kind not in ("input", "output"):
        raise HTTPException(404, "Not Found")
    job = _job_or_404(job_id)
    path = _local_file(job, kind)
    if path is None:
        raise HTTPException(404, "no such file")
    media_type = storage.upload_media_type(job["sheet_name"]) if kind == "input" else "application/pdf"
    return FileResponse(path, media_type=media_type)


def _attempt(read):
    """One panel of the system view; a failure there shouldn't blank the rest."""
    try:
        return read()
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def _queues():
    import boto3
    sqs = boto3.client("sqs")
    names = ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"]
    jobs = sqs.get_queue_attributes(QueueUrl=os.environ["JOB_QUEUE_URL"], AttributeNames=names)["Attributes"]
    failed = sqs.get_queue_attributes(QueueUrl=os.environ["JOB_DLQ_URL"], AttributeNames=names[:1])["Attributes"]
    return {"waiting": int(jobs["ApproximateNumberOfMessages"]),
            "in_flight": int(jobs["ApproximateNumberOfMessagesNotVisible"]),
            "dead_letter": int(failed["ApproximateNumberOfMessages"])}


def _workers():
    import boto3
    service = boto3.client("ecs").describe_services(
        cluster=os.environ["WORKER_CLUSTER"], services=[os.environ["WORKER_SERVICE"]])["services"][0]
    return {"desired": service["desiredCount"], "running": service["runningCount"],
            "pending": service["pendingCount"],
            "task_definition": service["taskDefinition"].rsplit("/", 1)[-1]}


@router.get("/system")
def system():
    """This region's processing pipeline: what is waiting, what is running.
    Each region reports only itself - open the dashboard through the other
    region's API to see that one."""
    now = int(time.time())
    names = _sheet_names()
    active = sorted((j for j in _jobs() if j.get("status") in ACTIVE),
                    key=lambda j: j.get("created_at") or 0)
    return {
        "region": storage.own_region() if config.IS_PRODUCTION else "local",
        "now": now,
        "queue": _attempt(_queues) if config.SERVERLESS else None,
        "workers": _attempt(_workers) if config.SERVERLESS else None,
        "active": [_job_view(job, names) for job in active],
    }
