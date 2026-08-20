"""REST API for the sheet-music annotator.

Wraps the same pipeline as run.py (audiveris_heads.py / annotate.py) behind a
small job-queue API: upload a PDF (or a JPG/PNG photo/scan - Audiveris reads
raster images directly, so a non-PDF upload is just converted to a one-page
PDF up front and the rest of the pipeline never knows the difference), poll
for completion, download the result. The output is always a PDF, regardless
of what was uploaded. OMR takes anywhere from seconds to minutes per file, so
submission is async - there is no synchronous "upload and get the PDF back"
endpoint.

Run with:
    .venv\\Scripts\\python.exe server.py
    (or: .venv\\Scripts\\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000)

Endpoints:
    GET    /api/health                     liveness check
    POST   /api/sheets                     upload a PDF or image, kick off annotation
    GET    /api/sheets/{job_id}            poll job status
    GET    /api/sheets/{job_id}/download   fetch the annotated PDF once done

Jobs run one at a time on a single background worker thread, deliberately -
Audiveris is CPU/memory-heavy per job, and this mirrors the "SQS + worker"
shape a real deployment (see the earlier Fargate discussion) would use, just
in-process. Job state and uploaded/output files live under ./server_jobs and
are NOT cleaned up automatically, and job state is in-memory only (lost on
restart) - both fine for local/dev use, not for production as-is.
"""
import queue
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import pymupdf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from run import annotate_pdf, count_pages

JOBS_DIR = Path(__file__).parent / "server_jobs"
JOBS_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png"}

app = FastAPI(title="Music-Sheet Annotator API")

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
    file: UploadFile = File(..., description="Piano sheet-music PDF, or a photo/scan (JPG/PNG)"),
    style: str = Form("unicode", description="'unicode' (B♭) or 'ascii' (Bb)"),
    octave: bool = Form(False, description="Append octave number, e.g. B♭4"),
    font_size: float = Form(6.5),
    dpi: Optional[int] = Form(None, description="Force Audiveris's rasterization DPI"),
    auto_retry: bool = Form(True, description="Auto re-scan under-recognized pages at higher DPI"),
):
    if style not in ("unicode", "ascii"):
        raise HTTPException(400, "style must be 'unicode' or 'ascii'")
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "only PDF or image (JPG/PNG) uploads are supported")

    job_id = uuid.uuid4().hex
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True)
    raw_path = job_dir / f"upload{ext}"
    with raw_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    # Normalize to a PDF regardless of what was uploaded, so the rest of the
    # pipeline (and the download, which is always a PDF) never has to care
    # whether the original was a document or a photo. This also validates the
    # file's actual content instead of trusting the extension - a renamed
    # non-PDF/non-image (or a corrupt upload) fails cleanly here rather than
    # confusingly partway through the Audiveris subprocess.
    input_path = job_dir / "input.pdf"
    try:
        with pymupdf.open(raw_path) as doc:
            is_pdf = doc.is_pdf
            if not is_pdf:
                pdf_bytes = doc.convert_to_pdf()
        if is_pdf:
            raw_path.rename(input_path)
        else:
            with pymupdf.open("pdf", pdf_bytes) as pdf_doc:
                pdf_doc.save(input_path)
            raw_path.unlink(missing_ok=True)
        num_pages = count_pages(input_path)
        if num_pages < 1:
            raise ValueError("no pages")
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(400, "the uploaded file isn't a valid PDF or image")

    with jobs_lock:
        jobs[job_id] = {
            "id": job_id, "status": "queued", "created_at": time.time(),
            "input_filename": file.filename,
            "input_path": input_path, "output_path": job_dir / "annotated.pdf",
            "work_dir": job_dir / "work",
            "style": style, "octave": octave, "font_size": font_size,
            "dpi": dpi, "auto_retry": auto_retry,
            "error": None, "labeled_groups": None,
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
    }


@app.get("/api/sheets/{job_id}/download")
def job_download(job_id: str):
    job = _job_or_404(job_id)
    if job["status"] != "done":
        raise HTTPException(409, f"job is '{job['status']}', not done yet")
    stem = Path(job["input_filename"]).stem
    return FileResponse(job["output_path"], media_type="application/pdf",
                         filename=f"{stem} (annotated).pdf")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
