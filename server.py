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

Auth: Cognito handles sign-up/sign-in only. A client exchanges a Cognito ID
token once via POST /api/auth/token (which also bootstraps this user's
`users`/`user_sub` DynamoDB rows on first login) for a short-lived token
minted by THIS backend - that token, not Cognito's, is what every other
endpoint checks. This means verifying a request never needs a network call to
Cognito, and this backend's token format is free to evolve independently of
whatever Cognito puts in its own tokens. See auth.py.

Endpoints:
    GET    /                               web UI (static/index.html) - local dev convenience only
    GET    /api/health                     liveness check (no auth - the ALB health check can't send a token)
    POST   /api/auth/token                 exchange a Cognito ID token for this backend's own token
    POST   /api/sheets                     upload a PDF or image, kick off annotation (Free tier: max 3 active jobs)
    GET    /api/sheets                     this user's job history, newest first
    GET    /api/sheets/{job_id}            poll one job's status
    GET    /api/sheets/{job_id}/download   redirect to a presigned S3 URL for the annotated PDF
                                            (?inline=1 for in-browser preview instead of a forced download)
    GET    /api/music-sheets               this user's uploaded sheets, one row per sheet regardless of reprocess count

The UI (static/index.html + static/config.js) is deployment-independent from
this API: locally it's served from "/" above for convenience, but it's a
plain static file with no build step that can just as well be copied to
S3/CloudFront and pointed at this API's real URL by editing config.js's
API_BASE - no HTML/JS edits needed. Because that makes the UI a different
origin from the API in that deployment, CORS is enabled below; set
ALLOWED_ORIGINS to the UI's real origin(s) in production instead of "*".

Jobs run one at a time on a single background worker thread, deliberately -
Audiveris is CPU/memory-heavy per job. Job state lives in DynamoDB and
uploaded/output files in S3 (see db.py/storage.py), not in-process, so
multiple backend tasks can share the same job/user data; the Audiveris
working directory itself is still local/ephemeral per job (server_jobs/,
not cleaned up automatically - fine for now, see infra/README.md).
"""
import os
import queue
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import pymupdf
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import storage
from auth import get_current_user_id, mint_backend_token, verify_cognito_id_token
from run import annotate_pdf, count_pages

JOBS_DIR = Path(__file__).parent / "server_jobs"
JOBS_DIR.mkdir(exist_ok=True)
STATIC_DIR = Path(__file__).parent / "static"

ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png"}
FREE_TIER_JOB_LIMIT = 3

app = FastAPI(title="Music-Sheet Annotator API")

# comma-separated list of allowed UI origins, e.g. "https://bettermusicsheet.com";
# defaults to "*" (any origin) which is fine for local dev, not for production
_allowed = os.environ.get("ALLOWED_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _allowed == "*" else [o.strip() for o in _allowed.split(",")],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


job_queue = queue.Queue()


def _process(job_id):
    job = db.get_annotation_job(job_id)
    job_dir = JOBS_DIR / job_id
    db.update_annotation_job(job_id, status="processing")

    def log(msg, _jid=job_id):
        print(f"[{_jid[:8]}] {msg}")
        db.update_annotation_job(_jid, stage=msg)

    try:
        n = annotate_pdf(
            job_dir / "input.pdf", job_dir / "annotated.pdf", job_dir / "work",
            style=job["style"], octave=job["octave"], font_size=job["font_size"],
            dpi=job["dpi"], auto_retry=job["auto_retry"], log=log,
        )
        storage.upload_output_pdf(job["music_sheet_id"], job_dir / "annotated.pdf")
        db.update_annotation_job(job_id, status="done", labeled_groups=n)
    except Exception as e:
        log(f"FAILED: {e}")
        db.update_annotation_job(job_id, status="failed", error=str(e))


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


class TokenRequest(BaseModel):
    id_token: str


@app.post("/api/auth/token")
def exchange_token(body: TokenRequest):
    user_id, email = verify_cognito_id_token(body.id_token)
    db.create_user_if_missing(user_id, email)
    db.create_free_sub_if_missing(user_id)
    return {
        "access_token": mint_backend_token(user_id),
        "token_type": "Bearer",
        "expires_in": 3600,
    }


@app.post("/api/sheets", status_code=202)
async def submit_sheet(
    file: UploadFile = File(..., description="Piano sheet-music PDF, or a photo/scan (JPG/PNG)"),
    style: str = Form("unicode", description="'unicode' (B♭) or 'ascii' (Bb)"),
    octave: bool = Form(False, description="Append octave number, e.g. B♭4"),
    font_size: float = Form(6.5),
    dpi: Optional[int] = Form(None, description="Force Audiveris's rasterization DPI"),
    auto_retry: bool = Form(True, description="Auto re-scan under-recognized pages at higher DPI"),
    user_id: str = Depends(get_current_user_id),
):
    if style not in ("unicode", "ascii"):
        raise HTTPException(400, "style must be 'unicode' or 'ascii'")
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "only PDF or image (JPG/PNG) uploads are supported")

    sub = db.get_user_sub(user_id) or {"sub_type": "Free"}
    if sub["sub_type"] == "Free" and db.count_active_jobs(user_id) >= FREE_TIER_JOB_LIMIT:
        raise HTTPException(403, f"Free plan is limited to {FREE_TIER_JOB_LIMIT} active uploads")

    music_sheet_id = uuid.uuid4().hex
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

    storage.upload_input_pdf(music_sheet_id, input_path)
    db.create_music_sheet(music_sheet_id, user_id, file.filename)
    db.create_annotation_job(job_id, user_id, music_sheet_id, style, octave, font_size, dpi, auto_retry)
    job_queue.put(job_id)
    return {"job_id": job_id, "music_sheet_id": music_sheet_id, "status": "queued"}


def _owned_job_or_404(job_id, user_id):
    job = db.get_annotation_job(job_id)
    if job is None or job["user_id"] != user_id:
        raise HTTPException(404, "no such job")
    return job


@app.get("/api/sheets")
def job_history(user_id: str = Depends(get_current_user_id)):
    return db.list_annotation_jobs(user_id)


@app.get("/api/sheets/{job_id}")
def job_status(job_id: str, user_id: str = Depends(get_current_user_id)):
    job = _owned_job_or_404(job_id, user_id)
    sheet = db.get_music_sheet(job["music_sheet_id"])
    return {**job, "sheet_name": sheet["sheet_name"] if sheet else None}


@app.get("/api/sheets/{job_id}/download")
def job_download(job_id: str, inline: bool = False, user_id: str = Depends(get_current_user_id)):
    job = _owned_job_or_404(job_id, user_id)
    if job["status"] != "done":
        raise HTTPException(409, f"job is '{job['status']}', not done yet")
    sheet = db.get_music_sheet(job["music_sheet_id"])
    stem = Path(sheet["sheet_name"]).stem if sheet else job["music_sheet_id"]
    url = storage.presigned_download_url(job["music_sheet_id"], f"{stem} (annotated).pdf", inline=inline)
    return RedirectResponse(url, status_code=307)


@app.get("/api/music-sheets")
def music_sheet_library(user_id: str = Depends(get_current_user_id)):
    return db.list_music_sheets(user_id)


# Local-dev convenience only: serves static/index.html at "/" and static/config.js
# alongside it. Registered last so it doesn't shadow the /api/* routes above -
# a real deployment skips this entirely and serves static/ from S3/CloudFront
# instead (see the module docstring).
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
