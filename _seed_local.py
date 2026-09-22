"""Dev-only: start the local server with its job list rebuilt from disk.

Local dev keeps jobs in memory (see db.py), so every restart loses the
history even though the annotated PDFs and timelines are still sitting in
server_jobs/storage/. This walks that directory and re-registers a "done" job
for each artifact, so Play/History work again without re-running Audiveris.
It also (re-)processes the bundled demo sheet (see demo-sheet/) under a
fixed job id, so the "Try a sample" card on the home page always has
something to point at - see seed_demo() below.

    .venv\\Scripts\\python.exe _seed_local.py
"""
import shutil
import uuid
from pathlib import Path

import config
import db
import job_state
import server
import storage
import uvicorn
import worker

STORAGE = Path(__file__).parent / "server_jobs" / "storage"
SUFFIX = " (annotated).pdf"

DEMO_SHEET = Path(__file__).parent / "demo-sheet" / "ode-to-joy.pdf"
DEMO_OPTIONS = {"style": "unicode", "octave": False, "font_size": 6.5,
                "dpi": None, "auto_retry": True, "color": "#000000"}


def seed():
    count = 0
    for output_dir in sorted(STORAGE.glob("*/output")):
        user_id = output_dir.parent.name
        for pdf in sorted(output_dir.glob("*" + SUFFIX)):
            # The stored name is the sanitized stem; the original extension is
            # gone, but nothing downstream needs it - storage keys are rebuilt
            # from the stem alone.
            sheet_name = pdf.name[: -len(SUFFIX)] + ".pdf"
            sheet_id = uuid.uuid4().hex
            job_id = uuid.uuid4().hex
            db.create_music_sheet(sheet_id, user_id, sheet_name)
            db.create_annotation_job(job_id, user_id, sheet_id, "unicode", False, 6.5, None, True)
            db.update_annotation_job(job_id, status="done", labeled_groups=0)
            count += 1
            print(f"  {user_id[:8]}… {sheet_name}")
    print(f"seeded {count} done job(s) from {STORAGE}")


def seed_demo():
    """Process the bundled demo sheet through the real pipeline - the same
    job_state.create -> worker.process_job path a real upload takes (see
    server.py's submit_sheet) - under the fixed config.DEMO_JOB_ID, so every
    visitor's "Try a sample" link opens the same job. See server.py's
    _readable_job_or_404 for the read carve-out that makes it playable with
    no sign-in and no guest id.

    Unlike seed() above, this always re-runs Audiveris: db.py has nothing on
    disk to point a fresh row at instead (see storage_version 2's per-attempt
    keys), so every restart repeats it. It's one short, bundled sheet, so
    that costs about as long as annotating any other one-page upload does.
    """
    if not DEMO_SHEET.exists():
        print(f"demo sheet missing at {DEMO_SHEET}, skipping")
        return
    job = job_state.create(config.DEMO_JOB_ID, config.DEMO_OWNER_ID, config.DEMO_SHEET_NAME,
                           DEMO_OPTIONS, DEMO_SHEET.stat().st_size)
    shutil.copyfile(DEMO_SHEET, storage._local_path(job["input_key"]))
    job_state.ready(job["job_id"], "local")
    if not worker.process_job(job["job_id"]):
        raise RuntimeError("Could not process the demo sheet - see the log above.")
    print(f"seeded demo job {config.DEMO_JOB_ID!r} from {DEMO_SHEET.name}")


if __name__ == "__main__":
    seed()
    seed_demo()
    uvicorn.run(server.app, host="0.0.0.0", port=8000)
