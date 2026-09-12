"""HTTP API shared by local uvicorn and the Lambda adapter.

New uploads use immutable artifacts and a standalone worker. Legacy routes
remain available during the staged deployment and for existing history.
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

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import db
import storage
from auth import (
    BACKEND_JWT_LIFETIME_SECONDS,
    get_current_user_id,
    get_signed_in_user_id,
    mint_backend_token,
    verify_cognito_id_token,
)
from config import IS_PRODUCTION, SERVERLESS, MAX_UPLOAD_BYTES
import job_state

JOBS_DIR = Path(__file__).parent / "server_jobs"
if not SERVERLESS:
    JOBS_DIR.mkdir(exist_ok=True)
STATIC_DIR = Path(__file__).parent / "static"

ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png"}

# Bounds on the optional "force DPI" upload option. Rasterization cost grows
# with the square of the DPI, so leaving this open-ended lets one upload eat
# an unbounded slice of a shared worker. 300 is Audiveris's own default;
# pages that genuinely need more get it from the automatic sparse-page retry
# (run.py's RETRY_DPI), which is bounded to the pages that need it.
MIN_DPI = 150
MAX_DPI = 300

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
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


job_queue = queue.Queue()


def _process(job_id):
    from worker import process_job
    return process_job(job_id)


def _worker():
    while True:
        job_id = job_queue.get()
        try:
            _process(job_id)
        except Exception:
            traceback.print_exc()
        finally:
            job_queue.task_done()


# Start lazily for local/legacy multipart submissions. Importing the Lambda
# application never starts a thread or loads the Java/PDF runtime.
_worker_started = False
_worker_lock = threading.Lock()


def enqueue_local(job_id):
    global _worker_started
    with _worker_lock:
        if not _worker_started:
            threading.Thread(target=_worker, daemon=True).start()
            _worker_started = True
    job_queue.put(job_id)


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


class UploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0, le=MAX_UPLOAD_BYTES)
    content_type: str = "application/octet-stream"
    style: str = "unicode"
    octave: bool = False
    font_size: float = Field(default=6.5, ge=3, le=20, allow_inf_nan=False)
    dpi: Optional[int] = Field(default=None, ge=MIN_DPI, le=MAX_DPI)
    auto_retry: bool = True


def reserve_upload(body, user_id):
    if Path(body.filename).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "Only PDF, JPG and PNG files are supported.")
    if body.style not in ("unicode", "ascii"):
        raise HTTPException(400, "style must be unicode or ascii")
    # Covers pre-migration active jobs; the atomic reservation below handles
    # concurrent new uploads without relying on an eventually consistent GSI.
    if db.get_in_progress_job(user_id):
        raise HTTPException(409, "You already have a sheet processing. Wait for it to finish.")
    try:
        return job_state.create(uuid.uuid4().hex, user_id, body.filename,
                                body.model_dump(include={"style", "octave", "font_size", "dpi", "auto_retry"}),
                                body.size)
    except job_state.Busy as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/uploads", status_code=201)
def create_upload(body: UploadRequest, user_id: str = Depends(get_current_user_id)):
    if not SERVERLESS:
        raise HTTPException(404, "Direct uploads are not enabled on this server.")
    job = reserve_upload(body, user_id)
    try:
        upload = storage.create_upload(job, {
            ".pdf": "application/pdf", ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg", ".png": "image/png",
        }[Path(body.filename).suffix.lower()])
    except Exception:
        # A reservation that cannot return a URL must not block future uploads.
        job_state.change(job["job_id"], {"status": "uploading"}, status="failed", error="Could not prepare upload.")
        job_state.release(job)
        raise
    return {"job_id": job["job_id"], "upload": upload}


@app.post("/api/uploads/{job_id}/complete", status_code=202)
def complete_upload(job_id: str, user_id: str = Depends(get_current_user_id)):
    from worker import accept_input
    job = _owned_job_or_404(job_id, user_id)
    if job.get("storage_version") != 2:
        raise HTTPException(409, "This upload uses the legacy submission flow.")
    job = accept_input(job_id)
    if job["status"] == "uploading":
        raise HTTPException(409, "Upload is not complete yet. Please retry.")
    # S3 notifications own enqueueing. The scheduled reconciler repairs a
    # missing notification. Browser retries cannot launch duplicate tasks.
    return {"job_id": job_id, "status": job["status"]}


@app.post("/api/sheets", status_code=202)
async def submit_sheet(
    file: UploadFile = File(...), style: str = Form("unicode"),
    octave: bool = Form(False), font_size: float = Form(6.5),
    dpi: Optional[int] = Form(None), auto_retry: bool = Form(True),
    user_id: str = Depends(get_current_user_id),
):
    if SERVERLESS:
        raise HTTPException(409, "Please refresh the page to use the updated upload form.")
    # Compatibility endpoint for local development and the transitional ECS API.
    size = 0
    with __import__("tempfile").TemporaryDirectory(prefix="sheet-upload-") as temporary:
        raw = Path(temporary) / "source"
        with raw.open("wb") as target:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"File must be at most {MAX_UPLOAD_BYTES // 1024 // 1024} MB.")
                target.write(chunk)
        try:
            body = UploadRequest(filename=file.filename or "", size=size, style=style,
                                 octave=octave, font_size=font_size, dpi=dpi, auto_retry=auto_retry)
        except ValueError:
            raise HTTPException(400, "Invalid file or annotation options.")
        job = reserve_upload(body, user_id)
        try:
            if IS_PRODUCTION:
                storage._s3.upload_file(str(raw), storage.job_bucket(job), job["input_key"])
                version = storage.input_info(job)["VersionId"]
            else:
                shutil.copyfile(raw, storage._local_path(job["input_key"]))
                version = "local"
            job_state.ready(job["job_id"], version)
            enqueue_local(job["job_id"])
        except Exception:
            job_state.change(job["job_id"], {"status": "uploading"}, status="failed", error="Upload failed.")
            job_state.release(job)
            raise
    return {"job_id": job["job_id"], "music_sheet_id": job["music_sheet_id"], "status": "queued"}


def _owned_job_or_404(job_id, user_id):
    job = db.get_annotation_job(job_id)
    if job is None or job["user_id"] != user_id or job["status"] == "deleted":
        raise HTTPException(404, "no such job")
    return job


@app.get("/api/sheets")
def job_history(user_id: str = Depends(get_current_user_id)):
    jobs = [j for j in db.list_annotation_jobs(user_id) if j["status"] not in ("deleting", "deleted")]
    sheets = {s["music_sheet_id"]: s["sheet_name"] for s in db.list_music_sheets(user_id)}
    return [{**job, "sheet_name": sheets.get(job["music_sheet_id"])} for job in jobs]


@app.get("/api/sheets/{job_id}")
def job_status(job_id: str, user_id: str = Depends(get_current_user_id)):
    job = _owned_job_or_404(job_id, user_id)
    sheet = db.get_music_sheet(job["music_sheet_id"])
    return {**job, "sheet_name": sheet["sheet_name"] if sheet else None}


@app.delete("/api/sheets/{job_id}", status_code=204)
def delete_job(job_id: str, user_id: str = Depends(get_current_user_id)):
    """Delete one history item and, when no other row shares them, its files.

    Queued/processing jobs cannot be deleted because the in-process worker
    may still be reading or recreating their artifacts.  Same-named uploads
    share storage keys by design, so those files are retained while another
    history item still needs them.
    """
    job = _owned_job_or_404(job_id, user_id)
    if job["status"] in ("uploading", "queued", "processing"):
        raise HTTPException(409, "Wait for this sheet to finish processing before deleting it.")

    if job.get("storage_version") == 2:
        # Tombstones survive until outstanding upload URLs expire. The reconciler
        # removes late uploads too, so a reused presigned URL cannot resurrect files.
        if not job_state.change(job_id, {"status": job["status"]}, status="deleting", next_check_at=int(time.time())):
            raise HTTPException(409, "This sheet changed; refresh and try again.")
        storage.delete_job_files(job)
        db.delete_music_sheet(job["music_sheet_id"])
        job_state.release(job)
        job_state.change(job_id, {"status": "deleting"}, status="deleted",
                         next_check_at=max(int(time.time()) + 60, job["upload_expires_at"] + 60))
        return Response(status_code=204)

    jobs = db.list_annotation_jobs(user_id)
    other_jobs = [candidate for candidate in jobs if candidate["job_id"] != job_id]
    sheet_id = job["music_sheet_id"]
    sheet = db.get_music_sheet(sheet_id)

    # A future reprocess flow may create more than one job for one sheet row.
    # In that case only this history entry belongs to this delete operation.
    sheet_is_still_used = any(candidate["music_sheet_id"] == sheet_id for candidate in other_jobs)
    if not sheet_is_still_used and sheet is not None:
        sheet_name = sheet["sheet_name"]
        selected_identity = storage.storage_identity(sheet_name)
        other_sheets = [
            candidate for candidate in db.list_music_sheets(user_id)
            if candidate["music_sheet_id"] != sheet_id
        ]
        files_are_shared = any(
            storage.storage_identity(candidate["sheet_name"]) == selected_identity
            for candidate in other_sheets
        )
        if not files_are_shared:
            # Delete storage first.  If S3 is unavailable the database rows
            # stay visible, allowing the user to retry rather than leaving
            # inaccessible orphaned objects behind.
            storage.delete_sheet_files(user_id, sheet_name)
        db.delete_music_sheet(sheet_id)

    db.delete_annotation_job(job_id)
    shutil.rmtree(JOBS_DIR / job_id, ignore_errors=True)
    return Response(status_code=204)


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


def with_sheet_name(job):
    sheet = db.get_music_sheet(job["music_sheet_id"])
    return {**job, "sheet_name": sheet["sheet_name"] if sheet else job.get("sheet_name", job["music_sheet_id"])}


@app.get("/api/sheets/{job_id}/assets")
def job_assets(job_id: str, user_id: str = Depends(get_current_user_id)):
    job = with_sheet_name(_owned_job_or_404(job_id, user_id))
    if job["status"] != "done":
        raise HTTPException(409, "The sheet is not ready yet.")
    if not IS_PRODUCTION:
        return {"direct": False, "pdf": f"/api/sheets/{job_id}/download",
                "timeline": f"/api/sheets/{job_id}/timeline"}
    stem = Path(job["sheet_name"]).stem
    disposition = _content_disposition("attachment", f"{stem} (annotated).pdf", f"{_ascii_stem(stem)} (annotated).pdf")
    return JSONResponse({"direct": True,
                         "pdf": storage.presign_artifact(job, "output", disposition),
                         "timeline": storage.presign_artifact(job, "timeline")},
                        headers={"Cache-Control": "no-store"})


def new_artifact_response(job, kind, disposition=None):
    try:
        result = storage.read_artifact(job, kind)
    except FileNotFoundError:
        raise HTTPException(404, "No playback timeline for this sheet.")
    if IS_PRODUCTION:
        return StreamingResponse(result["Body"].iter_chunks(chunk_size=65536),
            media_type="application/pdf" if kind == "output" else "application/json",
            headers={"Content-Length": str(result["ContentLength"]),
                     **({"Content-Disposition": disposition} if disposition else {})})
    if not result.exists():
        raise HTTPException(404, "No artifact for this sheet.")
    return FileResponse(result, media_type="application/pdf" if kind == "output" else "application/json",
                        headers={"Content-Disposition": disposition} if disposition else None)


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
    if SERVERLESS:
        raise HTTPException(409, "Please refresh the page to use direct downloads.")
    if job.get("storage_version") == 2:
        return new_artifact_response(job, "output", _content_disposition(disposition, filename, ascii_filename))
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
    if SERVERLESS:
        raise HTTPException(409, "Please refresh the page to load playback data.")
    if job.get("storage_version") == 2:
        return new_artifact_response(job, "timeline")
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
if not SERVERLESS:
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
