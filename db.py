"""Job state, in memory - no database. Every function takes/returns plain
Python dicts. Not persisted across restarts: fine for this app, since there
are no real user accounts (see auth.py) and jobs are short-lived.

Guarded by a lock since the background job worker thread and request-
handling threads both touch job state.
"""
import threading
import time

_lock = threading.Lock()
_music_sheets = {}
_annotation_jobs = {}


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


def count_active_jobs(user_id):
    """Jobs that count toward the per-user quota: everything except failed."""
    with _lock:
        return sum(
            1 for j in _annotation_jobs.values()
            if j["user_id"] == user_id and j["status"] != "failed"
        )


def list_annotation_jobs(user_id):
    with _lock:
        jobs = [dict(j) for j in _annotation_jobs.values() if j["user_id"] == user_id]
    return sorted(jobs, key=lambda j: j["created_at"], reverse=True)
