"""Job/user state - DynamoDB in production, an in-memory store in local dev
(see config.py). Every function takes/returns plain Python dicts.

The `users` table holds only people who actually signed in (see auth.py) - a
guest id never gets a row there, so every lookup here has to tolerate a
user_id with no matching row. Sheets and jobs, by contrast, exist for guests
and signed-in users alike (a guest's own history still reads and plays back;
uploading a new one is the one thing that now requires signing in - see
server.py), keyed by whichever id identified the request.

Subscriptions are the exception: they use DynamoDB whenever
SUBSCRIPTIONS_TABLE is set, local dev included (see the block at the end).

Wherever DynamoDB is used, its Decimal numbers are converted to int/float so
callers (server.py) never touch boto3 types directly.
"""
import threading
import time
from decimal import Decimal

from config import IS_PRODUCTION, SUBSCRIPTIONS_TABLE


_SUBSCRIPTION_STATUSES = {"trialing", "active", "canceled", "expired", "past_due"}
_SUBSCRIPTION_PLANS = {"monthly", "yearly"}
_SUBSCRIPTION_PLATFORMS = {"stripe", "apple"}


def _validate_subscription(status, plan, platform):
    if status not in _SUBSCRIPTION_STATUSES:
        raise ValueError(f"invalid subscription status: {status}")
    if plan not in _SUBSCRIPTION_PLANS:
        raise ValueError(f"invalid subscription plan: {plan}")
    if platform not in _SUBSCRIPTION_PLATFORMS:
        raise ValueError(f"invalid subscription platform: {platform}")


def _clean(value):
    """Recursively convert DynamoDB's Decimal numbers to int/float for JSON."""
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


if IS_PRODUCTION:
    import os

    import boto3
    from boto3.dynamodb.conditions import Key

    _dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-west-1"))

    _users_table = _dynamodb.Table(os.environ["USERS_TABLE"])
    _music_sheet_table = _dynamodb.Table(os.environ["MUSIC_SHEET_TABLE"])
    _annotation_job_table = _dynamodb.Table(os.environ["ANNOTATION_JOB_TABLE"])

    # ---- users (signed-in accounts only) ----

    def get_user(user_id):
        item = _users_table.get_item(Key={"user_id": user_id}).get("Item")
        return _clean(item) if item else None

    def create_user_if_missing(user_id, email, display_name):
        """Idempotent - a condition expression avoids clobbering an existing row
        if two requests race (e.g. two tabs exchanging tokens at once)."""
        try:
            _users_table.put_item(
                Item={
                    "user_id": user_id, "email": email,
                    "display_name": display_name, "created_at": int(time.time()),
                },
                ConditionExpression="attribute_not_exists(user_id)",
            )
        except _users_table.meta.client.exceptions.ConditionalCheckFailedException:
            pass

    def save_user_identity(user_id, email, display_name):
        """Write the identity claims a just-verified sign-in proved.

        create_user_if_missing deliberately never touches an existing row, so a
        row first created without a name - see server.py's /api/me fallback,
        which has only the token's subject to go on - could never acquire one
        afterwards, and the header showed "Account" for good. Signing in is the
        one moment we hold verified values, so that is where they are written.

        Only non-None values are written: a pool that omits the name claim must
        not erase a name an earlier sign-in already established."""
        names = {"#created": "created_at"}
        values = {":now": int(time.time())}
        expression = "SET #created = if_not_exists(#created, :now)"
        for i, (key, value) in enumerate((("email", email), ("display_name", display_name))):
            if value is None:
                continue
            names[f"#f{i}"] = key
            values[f":f{i}"] = value
            expression += f", #f{i} = :f{i}"
        _users_table.update_item(
            Key={"user_id": user_id}, UpdateExpression=expression,
            ExpressionAttributeNames=names, ExpressionAttributeValues=values,
        )

    def delete_user(user_id):
        _users_table.delete_item(Key={"user_id": user_id})

    # ---- per-user demo visibility ----

    def is_demo_hidden(user_id):
        user = get_user(user_id)
        return bool(user and user.get("hide_demo"))

    def set_demo_hidden(user_id, hidden):
        """Upsert - a signed-in visitor may hide the demo before /api/me has
        ever created their row (see server.py's demo_hidden route, which,
        unlike /api/me, has no reason to create one first just to flip a
        flag on it)."""
        _users_table.update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET hide_demo = :h",
            ExpressionAttributeValues={":h": hidden},
        )

    # ---- music_sheet ----

    def create_music_sheet(music_sheet_id, user_id, sheet_name):
        _music_sheet_table.put_item(Item={
            "music_sheet_id": music_sheet_id, "user_id": user_id,
            "sheet_name": sheet_name, "created_at": int(time.time()),
        })

    def get_music_sheet(music_sheet_id):
        item = _music_sheet_table.get_item(Key={"music_sheet_id": music_sheet_id}, ConsistentRead=True).get("Item")
        return _clean(item) if item else None

    def list_music_sheets(user_id):
        resp = _music_sheet_table.query(
            IndexName="user_id-index",
            KeyConditionExpression=Key("user_id").eq(user_id),
        )
        return _clean(resp["Items"])

    def delete_music_sheet(music_sheet_id):
        _music_sheet_table.delete_item(Key={"music_sheet_id": music_sheet_id})

    # ---- annotation_job ----

    def create_annotation_job(job_id, user_id, music_sheet_id, style, octave, font_size, dpi, auto_retry):
        now = int(time.time())
        _annotation_job_table.put_item(Item={
            "job_id": job_id, "user_id": user_id, "music_sheet_id": music_sheet_id,
            "status": "queued", "error": None, "stage": None, "labeled_groups": None,
            "style": style, "octave": octave, "font_size": Decimal(str(font_size)),
            "dpi": dpi, "auto_retry": auto_retry,
            "created_at": now, "updated_at": now,
        })

    def get_annotation_job(job_id):
        item = _annotation_job_table.get_item(Key={"job_id": job_id}, ConsistentRead=True).get("Item")
        return _clean(item) if item else None

    def update_annotation_job(job_id, **fields):
        """Partial update - only the given fields change. updated_at is always
        bumped, callers don't need to pass it."""
        fields["updated_at"] = int(time.time())
        expr_names = {f"#{k}": k for k in fields}
        expr_values = {f":{k}": v for k, v in fields.items()}
        _annotation_job_table.update_item(
            Key={"job_id": job_id},
            UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in fields),
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
        )

    def get_in_progress_job(user_id):
        """The user's currently queued/processing job, if any - only one upload
        may be in flight per user at a time."""
        resp = _annotation_job_table.query(
            IndexName="user_id-index",
            KeyConditionExpression=Key("user_id").eq(user_id),
            FilterExpression="#s IN (:queued, :processing)",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":queued": "queued", ":processing": "processing"},
        )
        items = _clean(resp["Items"])
        return items[0] if items else None

    def list_annotation_jobs(user_id):
        resp = _annotation_job_table.query(
            IndexName="user_id-index",
            KeyConditionExpression=Key("user_id").eq(user_id),
            ScanIndexForward=False,  # newest first (sorted by the index's created_at range key)
        )
        return _clean(resp["Items"])

    def delete_annotation_job(job_id):
        _annotation_job_table.delete_item(Key={"job_id": job_id})

else:
    # No AWS dependency at all: plain dicts guarded by a lock, since the
    # background job worker thread and request-handling threads both touch
    # job state. Not persisted across restarts - fine for local dev.
    _lock = threading.Lock()
    _users = {}
    _subscriptions = {}
    _music_sheets = {}
    _annotation_jobs = {}

    # ---- users (signed-in accounts only) ----

    def get_user(user_id):
        item = _users.get(user_id)
        return dict(item) if item else None

    def create_user_if_missing(user_id, email, display_name):
        with _lock:
            _users.setdefault(user_id, {
                "user_id": user_id, "email": email,
                "display_name": display_name, "created_at": int(time.time()),
            })

    def save_user_identity(user_id, email, display_name):
        """Write the identity claims a just-verified sign-in proved.

        create_user_if_missing deliberately never touches an existing row, so a
        row first created without a name - see server.py's /api/me fallback,
        which has only the token's subject to go on - could never acquire one
        afterwards, and the header showed "Account" for good. Signing in is the
        one moment we hold verified values, so that is where they are written.

        Only non-None values are written: a pool that omits the name claim must
        not erase a name an earlier sign-in already established."""
        with _lock:
            row = _users.setdefault(user_id, {
                "user_id": user_id, "email": None,
                "display_name": None, "created_at": int(time.time()),
            })
            if email is not None:
                row["email"] = email
            if display_name is not None:
                row["display_name"] = display_name

    def delete_user(user_id):
        with _lock:
            _users.pop(user_id, None)

    # ---- per-user demo visibility ----

    def is_demo_hidden(user_id):
        with _lock:
            user = _users.get(user_id)
            return bool(user and user.get("hide_demo"))

    def set_demo_hidden(user_id, hidden):
        with _lock:
            row = _users.setdefault(user_id, {
                "user_id": user_id, "email": None,
                "display_name": None, "created_at": int(time.time()),
            })
            row["hide_demo"] = hidden

    # ---- subscriptions ----
    #
    # One record per account, whichever store billed it: `platform` is
    # "stripe" or "apple", and `subscription_id` is that provider's own id for
    # it - a Stripe subscription id, or Apple's original transaction id (which
    # stays the same across renewals).

    def get_subscription(user_id):
        with _lock:
            item = _subscriptions.get(user_id)
            return dict(item) if item else None

    def get_subscription_by_platform_id(platform, subscription_id):
        with _lock:
            for item in _subscriptions.values():
                if item.get("platform") == platform and item.get("subscription_id") == subscription_id:
                    return dict(item)
            return None

    def upsert_subscription(user_id, status, plan, platform, current_period_start,
                            current_period_end, cancel_at_period_end,
                            subscription_id=None, started_at=None):
        _validate_subscription(status, plan, platform)
        with _lock:
            row = _subscriptions.setdefault(user_id, {"user_id": user_id})
            row.update({
                "status": status,
                "plan": plan,
                "platform": platform,
                "current_period_start": current_period_start,
                "current_period_end": current_period_end,
                "cancel_at_period_end": cancel_at_period_end,
                "updated_at": int(time.time()),
            })
            if subscription_id is not None:
                row["subscription_id"] = subscription_id
            if started_at is not None:
                row["started_at"] = started_at

    # ---- music_sheet ----

    def create_music_sheet(music_sheet_id, user_id, sheet_name):
        with _lock:
            _music_sheets[music_sheet_id] = {
                "music_sheet_id": music_sheet_id, "user_id": user_id,
                "sheet_name": sheet_name, "created_at": int(time.time()),
            }

    def get_music_sheet(music_sheet_id):
        item = _music_sheets.get(music_sheet_id)
        return dict(item) if item else None

    def list_music_sheets(user_id):
        with _lock:
            return [dict(s) for s in _music_sheets.values() if s["user_id"] == user_id]

    def delete_music_sheet(music_sheet_id):
        with _lock:
            _music_sheets.pop(music_sheet_id, None)

    # ---- annotation_job ----

    def create_annotation_job(job_id, user_id, music_sheet_id, style, octave, font_size, dpi, auto_retry):
        now = int(time.time())
        with _lock:
            _annotation_jobs[job_id] = {
                "job_id": job_id, "user_id": user_id, "music_sheet_id": music_sheet_id,
                "status": "queued", "error": None, "stage": None, "labeled_groups": None,
                "style": style, "octave": octave, "font_size": font_size,
                "dpi": dpi, "auto_retry": auto_retry,
                "created_at": now, "updated_at": now,
            }

    def get_annotation_job(job_id):
        item = _annotation_jobs.get(job_id)
        return dict(item) if item else None

    def update_annotation_job(job_id, **fields):
        """Partial update - only the given fields change. updated_at is always
        bumped, callers don't need to pass it."""
        fields["updated_at"] = int(time.time())
        with _lock:
            _annotation_jobs[job_id].update(fields)

    def get_in_progress_job(user_id):
        """The user's currently queued/processing job, if any - only one upload
        may be in flight per user at a time."""
        with _lock:
            for job in _annotation_jobs.values():
                if job["user_id"] == user_id and job["status"] in ("queued", "processing"):
                    return dict(job)
        return None

    def list_annotation_jobs(user_id):
        with _lock:
            jobs = [dict(j) for j in _annotation_jobs.values() if j["user_id"] == user_id]
        return sorted(jobs, key=lambda j: j["created_at"], reverse=True)

    def delete_annotation_job(job_id):
        with _lock:
            _annotation_jobs.pop(job_id, None)


# ---- subscriptions: DynamoDB whenever a table is named ----
#
# Production always names one (config.py requires it). Local dev may too, by
# setting SUBSCRIPTIONS_TABLE in .env: a subscription is bought on the real
# Stripe checkout and recorded by the deployed webhook, so the in-memory store
# above - empty after every restart - can never see it. These replace the
# in-memory subscription functions; users, sheets and jobs stay local.
# Note that cancelling or switching plans from a local backend then changes
# the real record.
if SUBSCRIPTIONS_TABLE:
    import os

    import boto3

    _subscriptions_table = boto3.resource(
        "dynamodb", region_name=os.environ.get("AWS_REGION", "us-west-1"),
    ).Table(SUBSCRIPTIONS_TABLE)

    def get_subscription(user_id):
        item = _subscriptions_table.get_item(Key={"user_id": user_id}).get("Item")
        return _clean(item) if item else None

    def get_subscription_by_platform_id(platform, subscription_id):
        response = _subscriptions_table.scan(
            FilterExpression="#platform = :platform AND subscription_id = :subscription_id",
            ExpressionAttributeNames={"#platform": "platform"},
            ExpressionAttributeValues={":platform": platform, ":subscription_id": subscription_id},
        )
        items = response.get("Items", [])
        return _clean(items[0]) if items else None

    def upsert_subscription(user_id, status, plan, platform, current_period_start,
                            current_period_end, cancel_at_period_end,
                            subscription_id=None, started_at=None):
        _validate_subscription(status, plan, platform)
        fields = {
            "status": status,
            "plan": plan,
            "platform": platform,
            "current_period_start": current_period_start,
            "current_period_end": current_period_end,
            "cancel_at_period_end": cancel_at_period_end,
            "updated_at": int(time.time()),
        }
        for key, value in (("subscription_id", subscription_id), ("started_at", started_at)):
            if value is not None:
                fields[key] = value
        names = {f"#{key}": key for key in fields}
        values = {f":{key}": value for key, value in fields.items()}
        _subscriptions_table.update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET " + ", ".join(f"#{key} = :{key}" for key in fields),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
