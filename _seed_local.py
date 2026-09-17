"""Dev-only: start the local server with its job list rebuilt from disk.

Local dev keeps jobs in memory (see db.py), so every restart loses the
history even though the annotated PDFs and timelines are still sitting in
server_jobs/storage/. This walks that directory and re-registers a "done" job
for each artifact, so Play/History work again without re-running Audiveris.

    .venv\\Scripts\\python.exe _seed_local.py
"""
import uuid
from pathlib import Path

import db
import server
import uvicorn

STORAGE = Path(__file__).parent / "server_jobs" / "storage"
SUFFIX = " (annotated).pdf"


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


if __name__ == "__main__":
    seed()
    uvicorn.run(server.app, host="0.0.0.0", port=8000)
