"""What readers do with their sheets, for the admin dashboard's Engagement tab
(admin.py): how long a sheet stays open, how much of that is practice, and
which controls get used.

A session is one sheet open on one page - "sheet", the sheet's own page with
its preview, or "practice", the keyboard page - from opening it until leaving.
The browser (better_music_sheet_web/lib/usage.ts) counts the seconds the page
was in use and each use of a control, and every minute or so reports what is
new since its last report; each report adds to the session's row. One row per
session, keyed by user id - an account's, or a guest's own id - and then the
session id the browser made up, so one person's sessions are a single Query.

Rows expire KEEP_DAYS after their session started (the table's TTL), and an
account's go with it (forget). Rows of an admin's sessions are marked, so the
admin's own trying things out stays out of the numbers.

Production keeps the rows in USAGE_TABLE. Without it reports are dropped, so a
deploy that ships this ahead of the table still runs. Local dev and tests keep
them in memory.
"""
import os
import threading
import time

import config
import db

SURFACES = ("sheet", "practice")
PLATFORMS = ("web", "ios")
# The controls whose use is counted, by the name a report gives them.
EVENTS = (
    "play",        # Play pressed to start
    "measure",     # a bar clicked, to play from it
    "step",        # a step to the next or previous note
    "scrub",       # the position slider dragged
    "speed",       # the speed slider
    "tempo",       # a tempo typed in
    "balance",     # the left/right hand balance
    "instrument",  # another instrument chosen
    "sound",       # sound turned off or on
    "paywall",     # the free part of a sheet ran out: the Premium prompt
    "notation",    # names as letters, numbers or solfege
    "view",        # the annotated copy or the original
    "download",    # a file downloaded
    "edit",        # a note's name or mark changed
)
KEEP_DAYS = 400
DAY = 86400
# The most one report may add. The browser reports every minute and holds a
# report that failed over to the next, so this leaves room for a few.
MAX_REPORT_SECONDS = 600

_lock = threading.Lock()
_rows = {}  # local dev: (user_id, session_id) -> row
_tables = {}


def _table_name():
    return os.environ.get("USAGE_TABLE") if config.IS_PRODUCTION else None


def _table():
    name = _table_name()
    if name not in _tables:
        import boto3
        _tables[name] = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-west-1")).Table(name)
    return _tables[name]


def _view(row):
    return {
        "user_id": row["user_id"],
        "session_id": row["session_id"],
        "job_id": row.get("job_id"),
        "surface": row.get("surface"),
        "platform": row.get("platform"),
        "started_at": row.get("started_at") or 0,
        "last_at": row.get("last_at") or 0,
        "seconds": row.get("seconds") or 0,
        "playing_seconds": row.get("playing_seconds") or 0,
        "admin": bool(row.get("admin")),
        "events": {name: row[f"e_{name}"] for name in EVENTS if row.get(f"e_{name}")},
    }


def record(user_id, session_id, job_id, surface, seconds=0, playing_seconds=0, events=None,
           platform="web", admin=False, now=None):
    """Add one report to its session: the seconds and control uses are added
    to what the session had, and the rest is kept from its first report."""
    now = int(time.time()) if now is None else now
    events = {name: count for name, count in (events or {}).items() if count}
    if _table_name():
        names = {"#job": "job_id", "#surface": "surface", "#platform": "platform", "#started": "started_at",
                 "#expires": "expires_at", "#last": "last_at", "#seconds": "seconds",
                 "#playing": "playing_seconds", "#reports": "reports"}
        values = {":job": job_id, ":surface": surface, ":platform": platform, ":now": now,
                  ":expires": now + KEEP_DAYS * DAY, ":seconds": seconds, ":playing": playing_seconds, ":one": 1}
        sets = ["#job = if_not_exists(#job, :job)", "#surface = if_not_exists(#surface, :surface)",
                "#platform = if_not_exists(#platform, :platform)", "#started = if_not_exists(#started, :now)",
                "#expires = if_not_exists(#expires, :expires)", "#last = :now"]
        adds = ["#seconds :seconds", "#playing :playing", "#reports :one"]
        # Top-level attributes rather than one map: ADD can't create a key
        # inside a map that doesn't exist yet.
        for i, (name, count) in enumerate(sorted(events.items())):
            names[f"#e{i}"], values[f":e{i}"] = f"e_{name}", count
            adds.append(f"#e{i} :e{i}")
        if admin:
            names["#admin"], values[":admin"] = "admin", True
            sets.append("#admin = :admin")
        _table().update_item(
            Key={"user_id": user_id, "session_id": session_id},
            UpdateExpression=f"SET {', '.join(sets)} ADD {', '.join(adds)}",
            ExpressionAttributeNames=names, ExpressionAttributeValues=values,
        )
    elif not config.IS_PRODUCTION:
        with _lock:
            row = _rows.setdefault((user_id, session_id), {
                "user_id": user_id, "session_id": session_id, "job_id": job_id, "surface": surface,
                "platform": platform, "started_at": now, "expires_at": now + KEEP_DAYS * DAY,
                "seconds": 0, "playing_seconds": 0, "reports": 0,
            })
            row["last_at"] = now
            row["seconds"] += seconds
            row["playing_seconds"] += playing_seconds
            row["reports"] += 1
            for name, count in events.items():
                row[f"e_{name}"] = row.get(f"e_{name}", 0) + count
            if admin:
                row["admin"] = True


def all_sessions(since=0):
    """Every session that started at `since` or later - for the admin
    dashboard only, like db's all_* functions."""
    if _table_name():
        rows = db._scan(_table())
    elif config.IS_PRODUCTION:
        rows = []
    else:
        with _lock:
            rows = [dict(row) for row in _rows.values()]
    return [_view(row) for row in rows if (row.get("started_at") or 0) >= since]


def _user_rows(user_id):
    if _table_name():
        from boto3.dynamodb.conditions import Key
        rows, kwargs = [], {"KeyConditionExpression": Key("user_id").eq(user_id)}
        while True:
            response = _table().query(**kwargs)
            rows += response["Items"]
            if "LastEvaluatedKey" not in response:
                return db._clean(rows)
            kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
    if config.IS_PRODUCTION:
        return []
    with _lock:
        return [dict(row) for (owner, _), row in _rows.items() if owner == user_id]


def user_sessions(user_id):
    """One person's sessions, newest first."""
    return sorted(map(_view, _user_rows(user_id)), key=lambda s: s["started_at"], reverse=True)


def forget(user_id):
    """Remove every session of a deleted account."""
    rows = _user_rows(user_id)
    if _table_name():
        with _table().batch_writer() as batch:
            for row in rows:
                batch.delete_item(Key={"user_id": user_id, "session_id": row["session_id"]})
    elif not config.IS_PRODUCTION:
        with _lock:
            for row in rows:
                _rows.pop((user_id, row["session_id"]), None)
