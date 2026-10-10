"""SQS consumer with renewable visibility, bounded runtime and fenced results."""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path
from urllib.parse import unquote_plus

import alerts
import db
import job_state
import processed_sheets
import storage
from config import IS_PRODUCTION, LEASE_SECONDS, MAX_ATTEMPTS, MAX_JOB_SECONDS, MAX_UPLOAD_BYTES

STOP = threading.Event()

# Audiveris tags every log line with the sheet it is working on ("[input#3]").
PAGE = re.compile(rb"\[[^\[\]#]+#(\d+)\]")


def audiveris_page(work_dir):
    """The page recognition has reached, from Audiveris's own log file.

    That log is the only progress signal available: run.py starts Audiveris
    with inherited stdout, and capturing it instead would change how the
    recognition subprocess runs for the sake of a status string. Only the tail
    is read - the log grows to megabytes on a long score.
    """
    try:
        logs = sorted(work_dir.glob("*.log"))
        with logs[-1].open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - 65536))
            tail = handle.read()
    except (OSError, IndexError):
        return None
    pages = [int(page) for page in PAGE.findall(tail)]
    return max(pages) if pages else None


def current_stage(directory):
    """What to show a waiting user, or None to leave the stage alone.

    Best effort by design: this only decorates a status string, so a missing
    or half written progress file must never disturb the job.
    """
    from processor import RECOGNITION
    try:
        progress = json.loads((directory / "progress.json").read_text(encoding="utf-8"))
    except Exception:
        return None
    stage, pages = progress.get("stage"), progress.get("pages")
    detail = progress.get("detail")
    if stage == RECOGNITION and pages and pages > 1:
        page = audiveris_page(directory / "work")
        if page:
            # A retry run re-reads selected sheets and keeps their original
            # numbers, so the reported page can exceed the count on its own.
            stage = f"{stage} (page {min(page, pages)} of {pages})"
    # The stage name stays exactly what processor.py published, so the test
    # above keeps matching; anything extra is appended rather than folded in.
    return f"{stage} · {detail}" if stage and detail else stage


def event_jobs(body):
    data = json.loads(body)
    if "job_id" in data:
        return [(data["job_id"], None)]
    records = []
    for record in data.get("Records", []):
        obj = record.get("s3", {}).get("object", {})
        parts = unquote_plus(obj.get("key", "")).split("/")
        if len(parts) == 4 and parts[0] == "jobs" and parts[3] == "input":
            # Only the configured bucket may create work; output events cannot
            # feed back into the queue. Ownership/key are rechecked below.
            if record["s3"]["bucket"]["name"] == os.environ.get("NEW_JOB_FILES_BUCKET"):
                records.append((parts[2], obj.get("versionId")))
    return records


def accept_input(job_id, version=None):
    job = db.get_annotation_job(job_id)
    if not job or job.get("storage_version") != 2 or job["status"] != "uploading":
        return job
    info = storage.input_info(job, version)
    if info is None:
        return job
    if info["ContentLength"] != job["size"] or info["ContentLength"] > MAX_UPLOAD_BYTES:
        job_state.fail(job, {"status": "uploading"}, "Uploaded file size does not match the selected file.")
        return db.get_annotation_job(job_id)
    version = info.get("VersionId", "local")
    # Reusing an earlier sheet is only ever a shortcut. Whatever goes wrong
    # in it, the upload is queued and read exactly as it was before reuse
    # existed.
    try:
        found = reuse_earlier(job, version)
    except Exception:
        traceback.print_exc()
        found = {}
    if found is None:
        return db.get_annotation_job(job_id)
    if found:
        try:
            return job_state.ready(job_id, version, **found)
        except Exception:
            traceback.print_exc()
    return job_state.ready(job_id, version)


def reuse_earlier(job, version):
    """Look for an earlier sheet made from the same file (processed_sheets.
    py). None when ``job`` was finished with a copy of it; otherwise what to
    queue the upload with - its hash and, when only the names need drawing
    again, the sheet to draw them from. May raise: accept_input then reads
    the upload as usual."""
    digest = storage.content_sha256(job, version)
    match = processed_sheets.find(digest, job)
    if match and match[1] and reuse(job, version, digest, match[0]):
        return None
    if match and not match[1]:
        # Just the job id: rows reach the browser, and that sheet's keys
        # carry its owner's id. The worker looks its files up itself.
        return {"content_sha256": digest, "redraw_from": match[0]["job_id"]}
    return {"content_sha256": digest}


def reuse(job, version, digest, source):
    """Finish ``job`` with a copy of an earlier sheet's results, made from the
    same file with the same settings. False if that couldn't be done - the
    earlier sheet was deleted meanwhile, say - and the upload is then read
    as usual."""
    try:
        keys = storage.copy_reused(job, source)
        fields = {key: source[key] for key in ("labeled_groups", "notes_named", "notes_printed", "review_reasons")
                  if source.get(key) is not None}
        if not job_state.reused(job, version, content_sha256=digest, reused_from=source["job_id"], **keys, **fields):
            return False
    except Exception:
        traceback.print_exc()
        return False
    # Done. What follows only logs it and offers it to later uploads.
    try:
        finished = db.get_annotation_job(job["job_id"])
        alerts.job_reused(finished, source["job_id"], "copied")
        processed_sheets.add(finished)
    except Exception:
        traceback.print_exc()
    return True


def fetch_redraw_sources(job, directory):
    """Put the notes (and timeline) of the earlier sheet ``job`` is drawn
    from in ``directory``, where processor.py looks for them. Anything
    missing or failing leaves the directory out, and the sheet is read from
    scratch."""
    if not job.get("redraw_from"):
        return
    try:
        source = db.get_annotation_job(job["redraw_from"])
        if not source or source["status"] != "done" or not source.get("notes_key"):
            return
        directory.mkdir()
        storage.download_reused(source, "notes", directory / "notes.json")
        if source.get("timeline_key"):
            storage.download_reused(source, "timeline", directory / "timeline.json")
    except Exception:
        traceback.print_exc()
        shutil.rmtree(directory, ignore_errors=True)


def publish_notes(job, path):
    """Keep the notes read, for drawing this file again with other settings
    (processed_sheets.py). Optional: a sheet whose notes can't be kept is
    finished all the same, and is only copied, never redrawn, later."""
    if not path.exists():
        return None
    try:
        return storage.publish(job, "notes", path)
    except Exception:
        traceback.print_exc()
        return None


def set_aside_recognition(result, directory):
    """Copies of the reading's MusicXML and .omr (processor.py's
    "recognition"), moved out of the job's temporary directory before it is
    deleted, for store_recognition. None when there are none, or on any
    failure - a sheet never waits on or fails for these."""
    kept = None
    try:
        paths = result.get("recognition") if isinstance(result, dict) else None
        found = {kind: directory / path for kind, path in (paths or {}).items()
                 if kind in storage.OMR_FILES and (directory / path).resolve().is_relative_to(directory.resolve())
                 and (directory / path).is_file()}
        if not found:
            return None
        kept = Path(tempfile.mkdtemp(prefix="recognition-"))
        for kind, path in found.items():
            shutil.copyfile(path, kept / kind)
        return kept
    except Exception:
        traceback.print_exc()
        if kept is not None:
            shutil.rmtree(kept, ignore_errors=True)
        return None


def store_recognition(job, output_key, kept=None, source_id=None):
    """Keep the reading beside a finished sheet: the copies set aside, or for
    a sheet drawn from an earlier one's notes, that sheet's own. Runs on a
    thread of its own after the sheet is done, so storing them can neither
    hold up nor fail it. Not a daemon: a worker told to stop still finishes
    these few uploads before it exits."""
    if kept is None and source_id is None:
        return None
    thread = threading.Thread(target=_store_recognition, args=(job, output_key, kept, source_id),
                              name=f"recognition-{job['job_id']}")
    thread.start()
    return thread


def _store_recognition(job, output_key, kept, source_id):
    try:
        keys = {}
        if kept is not None:
            for kind in storage.OMR_FILES:
                if (kept / kind).exists():
                    try:
                        keys[f"{kind}_key"] = storage.publish(job, kind, kept / kind)
                    except Exception:
                        traceback.print_exc()
        else:
            source = db.get_annotation_job(source_id)
            if source:
                keys = storage.copy_recognition(job, source, job["lease_owner"])
        # Only onto the finished attempt that read it: a sheet deleted,
        # retried or republished meanwhile keeps what it has.
        if keys:
            job_state.change(job["job_id"], {"status": "done", "output_key": output_key}, **keys)
    except Exception:
        traceback.print_exc()
    finally:
        if kept is not None:
            shutil.rmtree(kept, ignore_errors=True)


def offer_for_reuse(job_id):
    """Let later uploads of the same file reuse this finished sheet. After
    the sheet is done, so a failure here never touches it."""
    try:
        processed_sheets.add(db.get_annotation_job(job_id))
    except Exception:
        traceback.print_exc()


def stop_process(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
    else:
        os.killpg(process.pid, signal.SIGKILL)
    process.wait()


def run_processor(job, directory, tick):
    (directory / "options.json").write_text(json.dumps(job), encoding="utf-8")
    kwargs = {"start_new_session": True} if os.name != "nt" else {}
    process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("processor.py")), str(directory)], **kwargs)
    deadline = time.monotonic() + MAX_JOB_SECONDS
    try:
        while process.poll() is None:
            if STOP.wait(1):
                raise RuntimeError("Worker stopping; this sheet will be retried.")
            if time.monotonic() >= deadline:
                raise TimeoutError(job_state.TOO_LONG)
            tick()
        result = directory / "result.json"
        data = json.loads(result.read_text()) if result.exists() else {}
        if data.get("permanent"):
            from processor import InvalidSheet
            raise InvalidSheet(data["error"])
        if process.returncode or not data or "crash" in data:
            # Shown to the reader only once every attempt has failed.
            error = RuntimeError(job_state.UNREADABLE)
            error.crash = data.get("crash")
            raise error
        return data
    finally:
        stop_process(process)


def record_review(job, quality):
    """Keep why a finished sheet was emailed as needing review on its job, so
    the admin dashboard can list them.

    Written after the job is already done, and only while it still is (a
    compare-and-set, so a sheet deleted meanwhile is never recreated). Best
    effort: it only feeds the dashboard, so it must never fail a sheet."""
    reasons = (quality or {}).get("reasons")
    if not reasons:
        return
    try:
        job_state.change(job["job_id"], {"status": "done"}, review_reasons=[str(r) for r in reasons])
    except Exception:
        traceback.print_exc()


def process_job(job_id, extend=lambda: None, runner=run_processor):
    from processor import InvalidSheet
    token = uuid.uuid4().hex
    job = job_state.claim(job_id, token)
    if job is None:
        latest = db.get_annotation_job(job_id)
        if latest and latest["status"] not in job_state.ACTIVE:
            job_state.release(latest)
        return not latest or latest["status"] not in job_state.ACTIVE
    heartbeat_at = 0
    # Filled in once the temporary directory exists. Both heartbeats read
    # progress from it, so a multi-minute recognition run stops looking hung.
    workdir = []

    def progress():
        stage = current_stage(workdir[0]) if workdir else None
        return {"stage": stage} if stage else {}

    def tick():
        nonlocal heartbeat_at
        if time.monotonic() - heartbeat_at >= 30:
            # Refresh queue visibility before the DB lease. If either fails,
            # stop the process; it must not continue after losing ownership.
            extend()
            job_state.heartbeat(job, **progress())
            heartbeat_at = time.monotonic()

    # Keep visibility alive during downloads/publication too, not just Java.
    finished = threading.Event()
    heartbeat_error = []

    def keep_alive():
        while not finished.wait(30):
            try:
                extend()
                job_state.heartbeat(job, **progress())
            except Exception as exc:
                heartbeat_error.append(exc)
                return

    def check():
        if heartbeat_error:
            raise job_state.LeaseLost(job_id)
        if STOP.is_set():
            raise RuntimeError("Worker stopping")

    heartbeat_thread = threading.Thread(target=keep_alive, daemon=True)
    # Copies of the reading, until store_recognition takes them over.
    recognition = None
    try:
        tick()
        heartbeat_thread.start()
        with tempfile.TemporaryDirectory(prefix="sheet-") as temporary:
            directory = Path(temporary)
            workdir.append(directory)
            storage.download_input(job, directory / "source")
            if job["attempt_count"] <= 1:
                # Only the first attempt: should drawing from the earlier
                # sheet's notes ever take the processor down with it, the
                # retry reads the sheet from scratch instead.
                fetch_redraw_sources(job, directory / "reuse")
            check()
            result = runner(job, directory, check)
            # A plain count, or processor.py's result with the note counts
            # the library shows ("606/634").
            if isinstance(result, dict):
                count = result["count"]
                notes = {key: result.get(key) for key in ("notes_named", "notes_printed")}
            else:
                count, notes = result, {}
            # Drawn from an earlier sheet's notes (processed_sheets.py), not read.
            redrawn = bool(isinstance(result, dict) and result.get("redrawn") and job.get("redraw_from"))
            source = {"reused_from": job["redraw_from"]} if redrawn else {}
            recognition = set_aside_recognition(result, directory)
            check()
            output_key = storage.publish(job, "output", directory / "annotated.pdf")
            timeline = directory / "timeline.json"
            timeline_key = storage.publish(job, "timeline", timeline) if timeline.exists() else None
            labels = directory / "labels.json"
            labels_key = storage.publish(job, "labels", labels) if labels.exists() else None
            notes_key = publish_notes(job, directory / "notes.json")
            check()
            quality = alerts.assess(timeline)
            job_state.finish(job, status="done", labeled_groups=count, output_key=output_key, **notes,
                             timeline_key=timeline_key, labels_key=labels_key, notes_key=notes_key,
                             **source, stage="Complete", error=None)
        store_recognition(job, output_key, recognition, job["redraw_from"] if redrawn else None)
        recognition = None
        record_review(job, quality)
        if redrawn:
            # The earlier sheet already reported how its reading went.
            alerts.job_reused(job, job["redraw_from"], "redrawn")
        else:
            alerts.job_done(job, quality, output_key)
        offer_for_reuse(job_id)
        return True
    except job_state.LeaseLost:
        return False
    except Exception as exc:
        traceback.print_exc()
        permanent = isinstance(exc, (InvalidSheet, TimeoutError)) or job["attempt_count"] >= MAX_ATTEMPTS
        crash = getattr(exc, "crash", None)
        alerts.attempt_failed(job, str(exc), crash, retrying=not permanent)
        try:
            if permanent:
                job_state.finish(job, status="failed", error=str(exc), stage="Processing failed")
                alerts.job_failed(job, str(exc), crash)
            else:
                now = int(time.time())
                job_state.owned(job, status="queued", error=None, stage="Retrying interrupted processing",
                                queued_at=now, next_check_at=now + 300)
        except job_state.LeaseLost:
            return False
        return permanent
    finally:
        finished.set()
        if heartbeat_thread.is_alive():
            heartbeat_thread.join(timeout=15)
        if recognition is not None:
            shutil.rmtree(recognition, ignore_errors=True)


def task_protection(enabled):
    import urllib.request
    endpoint = os.environ.get("ECS_AGENT_URI")
    if endpoint:
        request = urllib.request.Request(endpoint + "/task-protection/v1/state",
            data=json.dumps({"ProtectionEnabled": enabled, "ExpiresInMinutes": 35}).encode(),
            headers={"Content-Type": "application/json"}, method="PUT")
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.load(response)
            if data.get("error"):
                raise RuntimeError("ECS task protection failed")


def main():
    import boto3
    sqs = boto3.client("sqs")
    url = os.environ["JOB_QUEUE_URL"]
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: STOP.set())
    while not STOP.is_set():
        try:
            # Protect before receiving, closing the receive/protect scale-in race.
            task_protection(True)
            response = sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=1,
                                           WaitTimeSeconds=20, VisibilityTimeout=LEASE_SECONDS)
            for message in response.get("Messages", []):
                def extend():
                    sqs.change_message_visibility(QueueUrl=url, ReceiptHandle=message["ReceiptHandle"],
                                                  VisibilityTimeout=LEASE_SECONDS)
                ack = True
                for job_id, version in event_jobs(message["Body"]):
                    accept_input(job_id, version)
                    ack = process_job(job_id, extend) and ack
                if ack:
                    sqs.delete_message(QueueUrl=url, ReceiptHandle=message["ReceiptHandle"])
        except Exception:
            traceback.print_exc()
            STOP.wait(5)
        finally:
            try:
                task_protection(False)
            except Exception:
                traceback.print_exc()


if __name__ == "__main__":
    main()
