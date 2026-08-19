"""REST API for the sheet-music annotator.

Wraps the same pipeline as run.py (audiveris_heads.py / annotate.py) behind a
small job-queue API: upload a PDF, poll for completion, download the result.
OMR takes anywhere from seconds to minutes per file, so submission is
async - there is no synchronous "upload and get the PDF back" endpoint.

Run with:
    .venv\\Scripts\\python.exe server.py
    (or: .venv\\Scripts\\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000)

Endpoints:
    GET    /                               web UI (static/index.html) - local dev convenience only
    GET    /api/health                     liveness check
    POST   /api/sheets                     upload a PDF, kick off annotation
    GET    /api/sheets/{job_id}            poll job status
    GET    /api/sheets/{job_id}/download   fetch the annotated PDF once done
                                            (?inline=1 for in-browser preview instead of a forced download)

The UI (static/index.html + static/config.js) is deployment-independent from
this API: locally it's served from "/" above for convenience, but it's a
plain static file with no build step that can just as well be copied to
S3/CloudFront and pointed at this API's real URL by editing config.js's
API_BASE - no HTML/JS edits needed. Because that makes the UI a different
origin from the API in that deployment, CORS is enabled below; set
ALLOWED_ORIGINS to the UI's real origin(s) in production instead of "*".

Jobs run one at a time on a single background worker thread, deliberately -
Audiveris is CPU/memory-heavy per job, and this mirrors the "SQS + worker"
shape a real deployment (see the earlier Fargate discussion) would use, just
in-process. Job state and uploaded/output files live under ./server_jobs and
are NOT cleaned up automatically, and job state is in-memory only (lost on
restart) - both fine for local/dev use, not for production as-is.
"""
import os
import queue
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from run import annotate_pdf

JOBS_DIR = Path(__file__).parent / "server_jobs"
JOBS_DIR.mkdir(exist_ok=True)
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Music-Sheet Annotator API")

# comma-separated list of allowed UI origins, e.g. "https://d123.cloudfront.net";
# defaults to "*" (any origin) which is fine for local dev, not for production
_allowed = os.environ.get("ALLOWED_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _allowed == "*" else [o.strip() for o in _allowed.split(",")],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


jobs = {}  # job_id -> dict; in-memory only, see module docstring
jobs_lock = threading.Lock()
job_queue = queue.Queue()


def _process(job_id):
    with jobs_lock:
        job = jobs[job_id]
        job["status"] = "processing"
        job["started_at"] = time.time()

    def log(msg, _jid=job_id):
        print(f"[{_jid[:8]}] {msg}")
        with jobs_lock:
            jobs[_jid]["stage"] = msg

    try:
        n = annotate_pdf(
            job["input_path"], job["output_path"], job["work_dir"],
            style=job["style"], octave=job["octave"], font_size=job["font_size"],
            dpi=job["dpi"], auto_retry=job["auto_retry"], log=log,
        )
        with jobs_lock:
            job["status"] = "done"
            job["labeled_groups"] = n
            job["finished_at"] = time.time()
    except Exception as e:
        log(f"FAILED: {e}")
        with jobs_lock:
            job["status"] = "failed"
            job["error"] = str(e)
            job["finished_at"] = time.time()


def _worker():
    while True:
        job_id = job_queue.get()
        try:
            _process(job_id)
        finally:
            job_queue.task_done()


threading.Thread(target=_worker, daemon=True).start()


@app.get("/api/health")
def health():
    return {"status": "ok", "queued": job_queue.qsize()}


@app.post("/api/sheets", status_code=202)
async def submit_sheet(
    file: UploadFile = File(..., description="Piano sheet-music PDF"),
    style: str = Form("unicode", description="'unicode' (B♭) or 'ascii' (Bb)"),
    octave: bool = Form(False, description="Append octave number, e.g. B♭4"),
    font_size: float = Form(6.5),
    dpi: Optional[int] = Form(None, description="Force Audiveris's rasterization DPI"),
    auto_retry: bool = Form(True, description="Auto re-scan under-recognized pages at higher DPI"),
):
    if style not in ("unicode", "ascii"):
        raise HTTPException(400, "style must be 'unicode' or 'ascii'")
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "only PDF uploads are supported")

    job_id = uuid.uuid4().hex
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True)
    input_path = job_dir / "input.pdf"
    with input_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    with jobs_lock:
        jobs[job_id] = {
            "id": job_id, "status": "queued", "created_at": time.time(),
            "input_filename": file.filename,
            "input_path": input_path, "output_path": job_dir / "annotated.pdf",
            "work_dir": job_dir / "work",
            "style": style, "octave": octave, "font_size": font_size,
            "dpi": dpi, "auto_retry": auto_retry,
            "error": None, "labeled_groups": None, "stage": None,
        }
    job_queue.put(job_id)
    return {"job_id": job_id, "status": "queued"}


def _job_or_404(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return job


@app.get("/api/sheets/{job_id}")
def job_status(job_id: str):
    job = _job_or_404(job_id)
    return {
        "job_id": job["id"],
        "status": job["status"],
        "input_filename": job["input_filename"],
        "labeled_groups": job["labeled_groups"],
        "error": job["error"],
        "stage": job["stage"],
    }


@app.get("/api/sheets/{job_id}/download")
def job_download(job_id: str, inline: bool = False):
    job = _job_or_404(job_id)
    if job["status"] != "done":
        raise HTTPException(409, f"job is '{job['status']}', not done yet")
    stem = Path(job["input_filename"]).stem
    return FileResponse(job["output_path"], media_type="application/pdf",
                         filename=f"{stem} (annotated).pdf",
                         content_disposition_type="inline" if inline else "attachment")


# Local-dev convenience only: serves static/index.html at "/" and static/config.js
# alongside it. Registered last so it doesn't shadow the /api/* routes above -
# a real deployment skips this entirely and serves static/ from S3/CloudFront
# instead (see the module docstring).
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
