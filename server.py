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

Auth: optional. Signing in is never required - a signed-out visitor is
identified by their X-Guest-Id header (an anonymous per-browser id the
frontend generates and persists in its own cookie - see
better_music_sheet_web/lib/guest-id.ts), or failing that, a single shared
GUEST_USER_ID. Signing in with Cognito (POST /api/auth/token exchanges a
Cognito ID token for a short-lived token minted by THIS backend,
bootstrapping the user's `users` row on first login) swaps that guest id for
the user's Cognito id, which is what their files are then stored under (see
storage.py). Sheets uploaded as a guest stay under the guest id and are not
migrated. See auth.py.

Endpoints:
    GET    /                               web UI (static/index.html) - local dev convenience only
    GET    /api/health                     liveness check (no auth - the ALB health check can't send a token)
    POST   /api/auth/token                 exchange a Cognito ID token for this backend's own token
    GET    /api/me                         the signed-in user's profile, or 401 for a guest
    POST   /api/sheets                     upload a PDF or image, kick off annotation (max 3 active jobs per user)
    GET    /api/sheets                     this user's job history, newest first
    GET    /api/sheets/{job_id}            poll one job's status
    GET    /api/sheets/{job_id}/download   the annotated PDF, streamed through this backend either way
                                            (from S3 in production, from disk in local dev)
                                            (?inline=1 for in-browser preview instead of a forced download)
    GET    /api/sheets/{job_id}/timeline   playback timeline JSON for the Play page (404 if none)
    GET    /api/music-sheets               this user's uploaded sheets, one row per sheet regardless of reprocess count

The UI (static/index.html + static/config.js) is deployment-independent from
this API: locally it's served from "/" above for convenience, but it's a
plain static file with no build step that can just as well be copied to
S3/CloudFront and pointed at this API's real URL by editing config.js's
API_BASE - no HTML/JS edits needed. Because that makes the UI a different
origin from the API in that deployment, CORS is enabled below; set
ALLOWED_ORIGINS to the UI's real origin(s) in production instead of "*".

Jobs run one at a time on a single background worker thread, deliberately -
Audiveris is CPU/memory-heavy per job. Job/user state and uploaded/output
files live in DynamoDB/S3 in production, or in-memory/server_jobs/ in local
dev (see config.py, db.py, storage.py) - not in-process either way in
production, so multiple backend tasks can share the same job/user data; the
Audiveris working directory itself is still local/ephemeral per job
(server_jobs/, not cleaned up automatically - fine for now, see
infra/README.md).
"""
import os
import queue
import shutil
import threading
import time
import traceback
import unicodedata
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import quote

import pymupdf
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import storage
from auth import (
    BACKEND_JWT_LIFETIME_SECONDS,
    get_current_user_id,
    get_signed_in_user_id,
    mint_backend_token,
    verify_cognito_id_token,
)
from config import IS_PRODUCTION
from run import annotate_pdf, count_pages

JOBS_DIR = Path(__file__).parent / "server_jobs"
JOBS_DIR.mkdir(exist_ok=True)
STATIC_DIR = Path(__file__).parent / "static"

ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png"}
MAX_ACTIVE_JOBS_PER_USER = 3

app = FastAPI(title="Music-Sheet Annotator API")

@app.middleware("http")
async def json_errors(request, call_next):
    """Turn an unhandled exception into a JSON 500 the browser can actually read.

    Starlette's own handler for an uncaught error returns a plain-text 500 from
    *outside* the CORS middleware, so it carries no Access-Control-Allow-Origin
    header. The browser then refuses to expose the response and reports a bare
    "Failed to fetch" - which says nothing about what broke and looks like the
    server is unreachable when it isn't. Registered before CORS below so it
    sits inside it, and its response picks the headers up on the way out.
    """
    try:
        return await call_next(request)
    except Exception:
        traceback.print_exc()
        return JSONResponse(
            {"detail": "Internal server error - see the server log for the traceback."},
            status_code=500,
        )


# comma-separated list of allowed UI origins, e.g. "https://bettermusicsheet.com";
# defaults to "*" (any origin) which is fine for local dev, not for production.
# Added last, so it is the outermost middleware and can attach headers to
# whatever the handler above produces.
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
        timeline_file = job_dir / "timeline.json"
        n = annotate_pdf(
            job_dir / "input.pdf", job_dir / "annotated.pdf", job_dir / "work",
            style=job["style"], octave=job["octave"], font_size=job["font_size"],
            dpi=job["dpi"], auto_retry=job["auto_retry"], log=log,
            timeline_path=timeline_file,
        )
        sheet = db.get_music_sheet(job["music_sheet_id"])
        sheet_name = sheet["sheet_name"] if sheet else job["music_sheet_id"]
        storage.upload_output_pdf(job["user_id"], job_dir / "annotated.pdf", sheet_name)
        # Best-effort, like its build: no timeline just means no Play mode for
        # this sheet (GET /timeline 404s), never a failed job.
        if timeline_file.exists():
            storage.upload_output_timeline(job["user_id"], timeline_file, sheet_name)
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
    """Sign-in, step 2: trade a verified Cognito ID token for one of ours.

    This is also the only place a `users` row is ever created - guests never
    get one (see db.py)."""
    user_id, email, display_name = verify_cognito_id_token(body.id_token)
    db.create_user_if_missing(user_id, email, display_name)
    user = db.get_user(user_id)
    return {
        "access_token": mint_backend_token(user_id),
        "token_type": "Bearer",
        "expires_in": BACKEND_JWT_LIFETIME_SECONDS,
        "user": user,
    }


@app.get("/api/me")
def me(user_id: str = Depends(get_signed_in_user_id)):
    """The signed-in user's profile, for the header to render their name.
    401 rather than a guest fallback - the frontend uses this to decide
    whether its stored token is still good."""
    if user_id is None:
        raise HTTPException(401, "not signed in")
    user = db.get_user(user_id)
    if user is None:
        # Valid token, but the row is gone (e.g. table wiped between
        # deploys) - recreate lazily rather than 500ing on a live session.
        # No name is passed: the token carries only the subject, and putting
        # the id there would show the user a UUID where their name goes.
        db.create_user_if_missing(user_id, None, None)
        user = db.get_user(user_id)
    return user


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

    if db.get_in_progress_job(user_id):
        raise HTTPException(409, "You already have a music sheet processing. Please wait for it to finish before uploading another.")

    if db.count_active_jobs(user_id) >= MAX_ACTIVE_JOBS_PER_USER:
        raise HTTPException(403, f"limited to {MAX_ACTIVE_JOBS_PER_USER} active uploads at a time")

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

    storage.upload_input_pdf(user_id, input_path, file.filename)
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
    jobs = db.list_annotation_jobs(user_id)
    sheets = {s["music_sheet_id"]: s["sheet_name"] for s in db.list_music_sheets(user_id)}
    return [{**job, "sheet_name": sheets.get(job["music_sheet_id"])} for job in jobs]


@app.get("/api/sheets/{job_id}")
def job_status(job_id: str, user_id: str = Depends(get_current_user_id)):
    job = _owned_job_or_404(job_id, user_id)
    sheet = db.get_music_sheet(job["music_sheet_id"])
    return {**job, "sheet_name": sheet["sheet_name"] if sheet else None}


def _ascii_stem(stem):
    """An ASCII-only version of a sheet name, for the Content-Disposition
    fallback below. Accents are flattened (Café -> Cafe); anything with no
    ASCII equivalent at all is dropped, which for a wholly CJK title leaves
    nothing - hence the generic default."""
    ascii_stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii")
    # Quotes and backslashes would break out of the quoted-string parameter.
    return ascii_stem.replace('"', "").replace("\\", "").strip() or "sheet"


def _content_disposition(disposition, filename, ascii_filename):
    """Content-Disposition that survives a non-ASCII sheet name.

    HTTP header values are latin-1 at best - Starlette encodes them as
    latin-1 and raises on anything outside it - so a sheet called
    "夏日漱石.pdf" cannot appear in the bare filename= parameter at all, and
    putting it there returned a 500 for both download and preview. Per RFC
    6266 that parameter is only an ASCII fallback anyway; the real name
    travels percent-encoded in filename*=, which every current browser
    prefers when both are present.
    """
    return f"{disposition}; filename=\"{ascii_filename}\"; filename*=utf-8''{quote(filename)}"


@app.get("/api/sheets/{job_id}/download")
def job_download(job_id: str, inline: bool = False, user_id: str = Depends(get_current_user_id)):
    job = _owned_job_or_404(job_id, user_id)
    if job["status"] != "done":
        raise HTTPException(409, f"job is '{job['status']}', not done yet")
    sheet = db.get_music_sheet(job["music_sheet_id"])
    sheet_name = sheet["sheet_name"] if sheet else job["music_sheet_id"]
    disposition = "inline" if inline else "attachment"
    stem = Path(sheet_name).stem
    filename = f"{stem} (annotated).pdf"
    ascii_filename = f"{_ascii_stem(stem)} (annotated).pdf"
    if IS_PRODUCTION:
        # Streamed through this backend rather than redirecting to a
        # presigned S3 URL - see storage.download_output_pdf for why.
        body, content_length = storage.download_output_pdf(job["user_id"], sheet_name)
        return StreamingResponse(
            body.iter_chunks(chunk_size=65536),
            media_type="application/pdf",
            headers={
                "Content-Disposition": _content_disposition(disposition, filename, ascii_filename),
                "Content-Length": str(content_length),
            },
        )
    path = storage.local_output_path(job["user_id"], sheet_name)
    return FileResponse(
        path, media_type="application/pdf", filename=filename,
        content_disposition_type=disposition,
    )


@app.get("/api/sheets/{job_id}/timeline")
def job_timeline(job_id: str, user_id: str = Depends(get_current_user_id)):
    """Playback data for the Play page (see ../timeline.py): notes with beat
    positions and MIDI numbers, plus per-measure page regions.

    404 rather than 500 when a finished job has no timeline - building it is
    best-effort (see run.py), so its absence is an expected state meaning
    "Play mode isn't available for this sheet", not a server fault."""
    job = _owned_job_or_404(job_id, user_id)
    if job["status"] != "done":
        raise HTTPException(409, f"job is '{job['status']}', not done yet")
    sheet = db.get_music_sheet(job["music_sheet_id"])
    sheet_name = sheet["sheet_name"] if sheet else job["music_sheet_id"]
    if IS_PRODUCTION:
        try:
            body, content_length = storage.download_output_timeline(job["user_id"], sheet_name)
        except Exception:
            raise HTTPException(404, "no playback timeline for this sheet")
        return StreamingResponse(
            body.iter_chunks(chunk_size=65536),
            media_type="application/json",
            headers={"Content-Length": str(content_length)},
        )
    path = storage.local_output_timeline_path(job["user_id"], sheet_name)
    if not path.exists():
        raise HTTPException(404, "no playback timeline for this sheet")
    return FileResponse(path, media_type="application/json")


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
