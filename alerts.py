"""Operator alerts for jobs: a structured log line always, and an email in
production through the stack's SNS topic (ALERTS_TOPIC_ARN, the same topic the
CloudWatch alarms use - see infra/modules/serverless/monitoring.tf).

Best effort by design. Every public function here swallows its own errors: a
missing permission or an SNS outage must never change a job's outcome.
"""
import json
import os
import traceback
from pathlib import Path

import storage

# Measure warnings that describe a choice playback made, not a misreading.
# Everything else counts as a problem, so a newly added warning is noticed
# by default rather than silently ignored.
INFORMATIONAL_WARNINGS = (
    "Fermatas use",
    "Grace timing uses a short lead-in",
    "Arpeggio read from the printed PDF",
    "Inferred pickup length",
    "Time signature corrected from the printed PDF",
    "Ending brackets without a recognized repeat",
    "Recovered a missed notehead",
    "Recovered note attacks omitted",
)

# A sheet is "rough" when any of these is crossed. Overridable per stack
# without a release; the defaults were chosen against the local test pieces.
PROBLEM_MEASURE_RATIO = float(os.environ.get("ALERT_PROBLEM_MEASURE_RATIO", "0.3"))
PROBLEM_MEASURE_MIN = int(os.environ.get("ALERT_PROBLEM_MEASURE_MIN", "5"))
UNMATCHED_NOTE_RATIO = float(os.environ.get("ALERT_UNMATCHED_NOTE_RATIO", "0.05"))


def location(job, key=None):
    """Where a job's file lives, as something an operator can open."""
    key = key or job.get("input_key")
    if not key:
        return "unknown"
    if not storage.IS_PRODUCTION:
        return str(storage._LOCAL_DIR / key)
    bucket, region = storage.job_bucket(job), storage.job_region(job)
    return (f"s3://{bucket}/{key} ({region})\n"
            f"  https://s3.console.aws.amazon.com/s3/object/{bucket}?region={region}&prefix={key}")


def assess(path):
    """timeline_quality() for a timeline file, or None if it can't be read."""
    try:
        path = Path(path)
        return timeline_quality(json.loads(path.read_text(encoding="utf-8")) if path.exists() else None)
    except Exception:
        traceback.print_exc()
        return None


def timeline_quality(timeline):
    """Summarize a timeline's recognition problems; `reasons` is empty when
    fine. None means the pipeline produced no timeline at all."""
    missing = timeline is None
    timeline = timeline or {}
    measures = timeline.get("measures") or []
    stats = timeline.get("stats") or {}
    counts = {}
    problem_measures = 0
    for measure in measures:
        problems = [w for w in measure.get("warnings") or [] if not w.startswith(INFORMATIONAL_WARNINGS)]
        problem_measures += bool(problems)
        for warning in problems:
            counts[warning] = counts.get(warning, 0) + 1
    matched, unmatched = stats.get("notes_matched", 0), stats.get("notes_unmatched", 0)
    notes = matched + unmatched
    quality = {
        "measures": len(measures),
        "problem_measures": problem_measures,
        "notes": notes,
        "notes_unmatched": unmatched,
        "pages_without_regions": stats.get("pages_without_regions", 0),
        "top_warnings": sorted(counts.items(), key=lambda item: -item[1])[:5],
        "sheet_warnings": [w for w in timeline.get("warnings") or [] if not w.startswith(INFORMATIONAL_WARNINGS)],
    }
    reasons = ["No playback timeline was produced, so practice mode is unavailable"] if missing else []
    if measures and problem_measures >= PROBLEM_MEASURE_MIN and problem_measures / len(measures) >= PROBLEM_MEASURE_RATIO:
        reasons.append(f"{problem_measures} of {len(measures)} measures have recognition warnings")
    if notes and unmatched / notes >= UNMATCHED_NOTE_RATIO:
        reasons.append(f"{unmatched} of {notes} notes could not be matched to the printed page")
    if quality["pages_without_regions"]:
        reasons.append(f"{quality['pages_without_regions']} page(s) have no recognized measures")
    if any(w.startswith("PDF note matching failed") for w in quality["sheet_warnings"]):
        reasons.append("PDF note matching failed for the whole sheet")
    quality["reasons"] = reasons
    return quality


def _log(event, job, **fields):
    print(json.dumps({"event": event, "job_id": job.get("job_id"), "user_id": job.get("user_id"),
                      "music_sheet_id": job.get("music_sheet_id"), "sheet_name": job.get("sheet_name"),
                      **fields}, default=str), flush=True)


def _subject(text):
    # SNS rejects non-ASCII subjects, and sheet names are often not ASCII.
    return text.encode("ascii", "replace").decode()[:99]


def _publish(subject, body):
    topic = os.environ.get("ALERTS_TOPIC_ARN")
    if not topic:
        return
    import boto3
    boto3.client("sns", region_name=topic.split(":")[3]).publish(
        TopicArn=topic, Subject=_subject(subject), Message=body)


def _identity(job):
    return (f"User ID:    {job.get('user_id')}\n"
            f"Sheet ID:   {job.get('music_sheet_id')}\n"
            f"Job ID:     {job.get('job_id')}\n"
            f"Sheet name: {job.get('sheet_name')}\n"
            f"Uploaded:   {location(job)}\n")


def job_failed(job, error):
    try:
        _log("job_failed", job, error=error, attempts=job.get("attempt_count"), stage=job.get("stage"))
        _publish(f"Sheet failed: {job.get('sheet_name') or job.get('job_id')}",
                 "A sheet failed and the user was shown an error.\n\n" + _identity(job)
                 + f"Error:      {error}\n"
                 + f"Attempts:   {job.get('attempt_count', 0)}\n"
                 + f"Last stage: {job.get('stage')}\n")
    except Exception:
        traceback.print_exc()


def job_done(job, quality, output_key=None):
    """Log every finished sheet; alert when its recognition looks rough."""
    try:
        quality = quality or {}
        _log("job_done", job, **{k: v for k, v in quality.items() if k != "top_warnings"})
        if not quality.get("reasons"):
            return
        warnings = "".join(f"  {count:4}  {warning}\n" for warning, count in quality["top_warnings"])
        sheet = "".join(f"  {warning}\n" for warning in quality["sheet_warnings"])
        _publish(f"Sheet needs review: {job.get('sheet_name') or job.get('job_id')}",
                 "A sheet finished, but its recognition looks rough.\n\n" + _identity(job)
                 + (f"Annotated:  {location(job, output_key)}\n" if output_key else "")
                 + "\nWhy:\n" + "".join(f"  - {reason}\n" for reason in quality["reasons"])
                 + (f"\nMost frequent measure warnings:\n{warnings}" if warnings else "")
                 + (f"\nSheet-wide warnings:\n{sheet}" if sheet else ""))
    except Exception:
        traceback.print_exc()
