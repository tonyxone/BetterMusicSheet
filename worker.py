"""SQS consumer with renewable visibility, bounded runtime and fenced results."""
import json
import os
import re
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

import db
import job_state
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
    if stage == RECOGNITION and pages and pages > 1:
        page = audiveris_page(directory / "work")
        if page:
            # A retry run re-reads selected sheets and keeps their original
            # numbers, so the reported page can exceed the count on its own.
            return f"{stage} (page {min(page, pages)} of {pages})"
    return stage


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
        if job_state.change(job_id, {"status": "uploading"}, status="failed", error="Uploaded file size does not match the selected file."):
            job_state.release(job)
        return db.get_annotation_job(job_id)
    return job_state.ready(job_id, info.get("VersionId", "local"))


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
                raise TimeoutError("This sheet exceeded the processing time limit.")
            tick()
        result = directory / "result.json"
        if result.exists():
            data = json.loads(result.read_text())
            if data.get("permanent"):
                from processor import InvalidSheet
                raise InvalidSheet(data["error"])
        if process.returncode or not result.exists():
            raise RuntimeError("Recognition failed. Retrying the sheet may help.")
        return data["count"]
    finally:
        stop_process(process)


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
    try:
        tick()
        heartbeat_thread.start()
        with tempfile.TemporaryDirectory(prefix="sheet-") as temporary:
            directory = Path(temporary)
            workdir.append(directory)
            storage.download_input(job, directory / "source")
            check()
            count = runner(job, directory, check)
            check()
            output_key = storage.publish(job, "output", directory / "annotated.pdf")
            timeline = directory / "timeline.json"
            timeline_key = storage.publish(job, "timeline", timeline) if timeline.exists() else None
            check()
            job_state.finish(job, status="done", labeled_groups=count, output_key=output_key,
                             timeline_key=timeline_key, stage="Complete", error=None)
        return True
    except job_state.LeaseLost:
        return False
    except Exception as exc:
        traceback.print_exc()
        permanent = isinstance(exc, (InvalidSheet, TimeoutError)) or job["attempt_count"] >= MAX_ATTEMPTS
        try:
            if permanent:
                job_state.finish(job, status="failed", error=str(exc), stage="Processing failed")
            else:
                job_state.owned(job, status="queued", error=None, stage="Retrying interrupted processing",
                                next_check_at=int(time.time()) + 300)
        except job_state.LeaseLost:
            return False
        return permanent
    finally:
        finished.set()
        if heartbeat_thread.is_alive():
            heartbeat_thread.join(timeout=15)


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
