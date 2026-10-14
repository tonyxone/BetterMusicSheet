"""Read a sheet again from the admin dashboard, and pass the new reading on to
every other sheet made from the same file.

The same file uploaded by several readers is one reading copied to each of
them (processed_sheets.py), so a reading fixed for one of them is fixed for
all. The admin asks (request, from admin.py); a worker does the reading (run,
from worker.py), since only a worker has Audiveris:

1. The sheet asked for is read from scratch from the upload it kept and
   republished over its current results (republish.py) - a compare-and-set,
   so a sheet deleted meanwhile is left alone.
2. Every other sheet made from the same file - matched by the upload's hash,
   whoever uploaded it and whatever it is called - is republished from that
   reading: a copy when it was made with the same settings, the names drawn
   again from the new notes when only how they are drawn differs, and a read
   of its own when it was read with other settings (dpi).

Every reader's own edits - moved, retyped or hidden names, drawings, text
notes and playback corrections - are kept exactly as they are: they are
stored apart from the sheet's results (storage.py, edits/), and nothing here
reads, moves or deletes them. Drawings and text notes sit on the page, so
they stay where they were drawn; a name's edit is keyed by the label it was
made on, so a name read differently this time may no longer carry it.

The sheets stay "done" and open for their readers the whole time: the new
results replace the old in one write, and the old files stay, for rolling
back (republish.py). How it went is kept on the sheet asked for, as the
reprocess_* fields the dashboard shows.
"""
import time
import traceback
import uuid

import db
import job_state
import processed_sheets
import republish
import storage
from config import LEASE_SECONDS

ACTIVE = ("queued", "processing")
# A request no worker finished in this long - its worker gone, its message
# lost - may be made again.
STALE_SECONDS = 2 * 3600


def _active(job, now):
    return (job.get("reprocess_state") in ACTIVE
            and (job.get("reprocess_heartbeat_at") or job.get("reprocess_requested_at") or 0) > now - STALE_SECONDS)


def request(job_id, admin_id, reason=None):
    """Mark a sheet to be read again; the caller then sends it to a worker
    (message). Raises republish.Refused, changing nothing, for a sheet that
    can't be."""
    job = db.get_annotation_job(job_id)
    now = int(time.time())
    if job is None or job.get("status") in ("deleting", "deleted"):
        raise republish.Refused("This sheet was deleted.")
    if job.get("storage_version") != 2:
        raise republish.Refused("This sheet is from before per-sheet storage and can't be read again.")
    if job["status"] not in republish.REPUBLISHABLE:
        raise republish.Refused("This sheet is still being read. Wait for it to finish.")
    if not job.get("input_version"):
        raise republish.Refused("This upload never finished, so there is nothing to read again.")
    if not storage.is_own_job(job):
        raise republish.Refused(f"This sheet's files are in {storage.job_region(job)}. "
                                f"Open the dashboard there to read it again.")
    if _active(job, now):
        raise republish.Refused("This sheet is already being read again.")
    expected = {"status": job["status"], "reprocess_requested_at": job.get("reprocess_requested_at")}
    if not job_state.change(job_id, expected, reprocess_state="queued", reprocess_requested_at=now,
                            reprocess_by=admin_id, reprocess_reason=reason or None,
                            # Never None: the worker compares it, and DynamoDB keeps a
                            # None as a NULL that attribute_not_exists won't match.
                            reprocess_owner=f"queued-{uuid.uuid4().hex}",
                            reprocess_heartbeat_at=None, reprocess_finished_at=None, reprocess_error=None,
                            reprocess_result=None):
        raise republish.Refused("This sheet changed meanwhile. Refresh and try again.")
    return db.get_annotation_job(job_id)


def message(job_id):
    """The work queue message for a request; worker.main tells it apart from
    an upload's by its key."""
    return {"reprocess": job_id}


def _reader(tick, redraw_from=None):
    """republish.republish's runner, as a worker runs the processor: in a
    process of its own, bounded and stoppable (worker.run_processor). With
    ``redraw_from``, the names are drawn from that sheet's notes instead of
    reading the music (processed_sheets.py)."""
    import worker

    def read(job, directory):
        storage.download_input(job, directory / "source")
        if redraw_from:
            worker.fetch_redraw_sources({**job, "redraw_from": redraw_from}, directory / "reuse")
        tick()
        return worker.run_processor(job, directory, tick)
    return read


def matching(source, tick=lambda: None):
    """Every other sheet made from the same file as ``source``, still there.
    A sheet from before uploads were hashed is hashed now - only one the
    same size could match - and the hash kept on it."""
    digest = source.get("content_sha256")
    found = []
    for job in db.all_annotation_jobs():
        if (job["job_id"] == source["job_id"] or job.get("storage_version") != 2
                or job.get("status") in ("deleting", "deleted")):
            continue
        if not job.get("content_sha256") and job.get("input_version") and job.get("size") == source.get("size"):
            try:
                tick()
                hashed = storage.content_sha256(job, job["input_version"])
                job_state.change(job["job_id"], {"status": job["status"]}, content_sha256=hashed)
                job = {**job, "content_sha256": hashed}
            except Exception:
                traceback.print_exc()
        if job.get("content_sha256") == digest:
            found.append(job)
    return sorted(found, key=lambda job: job.get("created_at") or 0)


def pass_on(job, source, tick, reason, reader=_reader):
    """Republish ``job`` from the reading ``source`` was just republished
    with. Returns how: "copied", "redrawn" or "read". Raises
    republish.Refused for a sheet that can't be, or changed meanwhile."""
    if job["status"] not in republish.REPUBLISHABLE:
        raise republish.Refused(f"status is {job['status']!r}: it is being read right now")
    if not storage.is_own_job(job):
        raise republish.Refused(f"its files are in {storage.job_region(job)}")
    made, wanted = processed_sheets.settings(source), processed_sheets.settings(job)
    if made == wanted and source.get("output_key"):
        republish.copy_from(job["job_id"], source, reason=reason)
        return "copied"
    if all(made[key] == wanted[key] for key in processed_sheets.READING) and source.get("notes_key"):
        done = republish.republish(job["job_id"], allow_edits=True, runner=reader(tick, source["job_id"]),
                                   reason=reason)
        # Drawn, not read: the reading it was drawn from is the source's.
        try:
            keys = storage.copy_recognition(done, source, uuid.uuid4().hex)
            if keys:
                job_state.change(done["job_id"], {"status": "done", "output_key": done["output_key"]}, **keys)
        except Exception:
            traceback.print_exc()
        return "redrawn"
    republish.republish(job["job_id"], allow_edits=True, runner=reader(tick), reason=reason)
    return "read"


class _Lost(Exception):
    """The request was made again, or the sheet deleted, while this ran."""


def run(job_id, extend=lambda: None, reader=_reader):
    """Carry out a request: read the sheet again and pass the reading on.
    Returns whether the queue message is done with - False only when it
    should come back: another worker is on it, or this one is stopping."""
    import worker
    now = int(time.time())
    job = db.get_annotation_job(job_id)
    if not job or job.get("reprocess_state") not in ACTIVE:
        return True  # nothing asked, or a duplicate of one already done
    if (job["reprocess_state"] == "processing"
            and (job.get("reprocess_heartbeat_at") or 0) > now - LEASE_SECONDS):
        return False  # another worker is on it; ask again once it is done
    token = uuid.uuid4().hex
    if not job_state.change(job_id, {"reprocess_state": job["reprocess_state"],
                                     "reprocess_owner": job.get("reprocess_owner")},
                            reprocess_state="processing", reprocess_owner=token, reprocess_heartbeat_at=now):
        return False
    beat = [time.monotonic()]

    def tick():
        if worker.STOP.is_set():
            raise RuntimeError("Worker stopping; the sheet will be read again.")
        if time.monotonic() - beat[0] >= 30:
            extend()
            if not job_state.change(job_id, {"reprocess_owner": token}, reprocess_heartbeat_at=int(time.time())):
                raise _Lost(job_id)
            beat[0] = time.monotonic()

    def end(**fields):
        job_state.change(job_id, {"reprocess_owner": token}, reprocess_finished_at=int(time.time()), **fields)

    reason = job.get("reprocess_reason") or "Read again from the admin dashboard"
    try:
        source = republish.republish(job_id, allow_edits=True, runner=reader(tick), reason=reason)
    except _Lost:
        return True
    except republish.Refused as exc:
        end(reprocess_state="failed", reprocess_error=str(exc))
        return True
    except Exception as exc:
        traceback.print_exc()
        if worker.STOP.is_set():
            return False
        end(reprocess_state="failed", reprocess_error=str(exc))
        return True

    updated, failed = [], []
    try:
        if not source.get("content_sha256") and source.get("input_version"):
            # From before uploads were hashed: hash it, to find the others.
            digest = storage.content_sha256(source, source["input_version"])
            job_state.change(job_id, {"status": "done"}, content_sha256=digest)
            source = {**source, "content_sha256": digest}
        for other in (matching(source, tick) if source.get("content_sha256") else []):
            tick()
            entry = {"job_id": other["job_id"], "user_id": other["user_id"]}
            try:
                updated.append({**entry, "how": pass_on(other, source, tick, reason, reader)})
            except _Lost:
                raise
            except Exception as exc:
                if worker.STOP.is_set():
                    raise
                traceback.print_exc()
                failed.append({**entry, "error": str(exc)[:300]})
    except _Lost:
        return True
    except Exception as exc:
        traceback.print_exc()
        if worker.STOP.is_set():
            # The sheet itself is republished; coming back, it is read again
            # and passed on to all of them - each publish is a compare-and-set.
            return False
        end(reprocess_state="failed", reprocess_error=f"Read again, but passing it on stopped: {exc}"[:300],
            reprocess_result={"updated": updated, "failed": failed})
        return True
    end(reprocess_state="done", reprocess_error=None, reprocess_result={"updated": updated, "failed": failed})
    return True
