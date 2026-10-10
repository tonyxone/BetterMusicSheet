"""Heavy processing code, imported only inside a worker process."""
import json
import os
from pathlib import Path


class InvalidSheet(Exception):
    pass


# annotate_pdf's own log prefixes, mapped to something a waiting user can read.
# Recognition dominates the runtime, so worker.py adds page progress to that one.
STAGES = {
    "[1/3]": "Reading sheet music",
    "[1b/3]": "Re-reading unclear pages",
    "[2/3]": "Matching pitches to notes",
    "[2b/3]": "Building playback timeline",
    "[3/3]": "Drawing the annotated sheet",
}
RECOGNITION = STAGES["[1/3]"]

# A photo becomes a page sized so that recognition, which reads a PDF at 300
# DPI, sees the photo's own pixels one to one. The web app sizes the photos it
# puts together the same way (lib/photo-pages.ts), and so does the viewer for
# a photo whose names failed - marks made there are in this page's points. The
# dpi the picture itself claims is ignored: a phone screenshot says 72 or 96,
# which had recognition read it three to four times enlarged and blurred.
PHOTO_DPI = 300


def photo_as_pdf(raw, pdf):
    """Write the photo at ``raw`` to ``pdf`` as one PHOTO_DPI page, turned
    the way its orientation tag says, at its full resolution."""
    import pymupdf
    with pymupdf.open(raw) as photo, pymupdf.open("pdf", photo.convert_to_pdf()) as converted,             pymupdf.open() as out:
        stored = pymupdf.Pixmap(str(raw))
        width, height = stored.width, stored.height
        turned = converted[0].rect
        # Turned a quarter: the stored pixels' sides swap.
        if (turned.width > turned.height) != (width > height):
            width, height = height, width
        page = out.new_page(width=width * 72 / PHOTO_DPI, height=height * 72 / PHOTO_DPI)
        page.show_pdf_page(page.rect, converted, 0)
        out.save(pdf)


def publish(directory, **progress):
    """Hand progress to worker.py, which owns the database write.

    Replaced atomically: the reader polls on its own schedule, and a half
    written file would cost it an update for no reason.
    """
    temporary = directory / "progress.json.tmp"
    temporary.write_text(json.dumps(progress), encoding="utf-8")
    os.replace(temporary, directory / "progress.json")


def generate(raw, directory, options):
    import pymupdf
    from config import MAX_PAGES
    from run import annotate_pdf

    directory = Path(directory)
    pdf = directory / "input.pdf"
    pages = 1
    try:
        with pymupdf.open(raw) as doc:
            if doc.needs_pass or doc.page_count < 1 or doc.page_count > MAX_PAGES:
                raise ValueError("encrypted, empty, or too many pages")
            pages = doc.page_count
            if doc.is_pdf:
                doc.save(pdf)
            else:
                photo_as_pdf(raw, pdf)
    except Exception as exc:
        raise InvalidSheet(f"Upload a valid, unencrypted PDF or image with at most {MAX_PAGES} pages.") from exc

    # Both are known before any recognition runs: one from the page geometry,
    # the other from the noteheads a vector engraving prints itself. Neither
    # costs an OMR pass, so a reader can be told what is coming immediately.
    from run import describe_duration, estimated_seconds, printed_notehead_total
    estimate = estimated_seconds(pdf)
    expected = printed_notehead_total(pdf, pages)

    def detail_for(prefix, rest):
        """The half of the status line that says how much and how long."""
        if prefix == "[1/3]":
            parts = [describe_duration(estimate)]
            if expected:
                parts.append(f"{expected:,} notes to read")
            return " · ".join(parts)
        if prefix == "[1b/3]":
            # run.py has already worked out the cost, and only it knows which
            # pages need what; the wording it logged is carried through rather
            # than recomputed here.
            _, _, tail = rest.partition("; ")
            detail = tail.rstrip(":") or None
            return f"{detail} · thanks for your patience" if detail else None
        if prefix == "[2b/3]" and "notes" in rest:
            return rest.partition(": ")[2].rstrip()
        return None

    def log(message):
        print(message, flush=True)
        prefix, _, rest = message.partition(" ")
        stage = STAGES.get(prefix)
        if stage:
            publish(directory, stage=stage, pages=pages, detail=detail_for(prefix, rest))

    timeline = directory / "timeline.json"
    stats = {}
    redrawn = redraw(pdf, directory, options, log, stats)
    if redrawn is not None:
        return {"count": redrawn, "notes_named": stats.get("notes_named"), "notes_printed": expected,
                "redrawn": True}
    count = annotate_pdf(pdf, directory / "annotated.pdf", directory / "work",
                         style=options["style"], octave=options["octave"], font_size=options["font_size"],
                         dpi=options["dpi"], auto_retry=options["auto_retry"], timeline_path=timeline,
                         labels_path=directory / "labels.json",
                         # .get, not [...]: jobs queued before this option existed
                         # have no colour in their options.json and must still run.
                         color=options.get("color", "#000000"),
                         notation=options.get("notation", "letters"), log=log, stats=stats,
                         notes_path=directory / "notes.json")
    # For the library's "606/634": notes named, out of the notes the sheet
    # prints - the latter only known for a vector PDF (None for a scan).
    # "recognition" is where the MusicXML and .omr were left, relative to
    # ``directory``, so whoever stores them finds them wherever it now is.
    recognition = {kind: os.path.relpath(stats[kind], directory)
                   for kind in ("musicxml", "omr") if stats.get(kind)}
    return {"count": count, "notes_named": stats.get("notes_named"), "notes_printed": expected,
            "recognition": recognition}


def redraw(pdf, directory, options, log, stats):
    """Draw the names from an earlier reading of this same file, which
    worker.py put in ``reuse/`` - the count of labeled groups, or None to
    read the sheet from scratch: there was nothing to redraw from, or it
    failed, which must never cost the reader their sheet."""
    import shutil
    from run import redraw_pdf

    reuse = directory / "reuse"
    if not (reuse / "notes.json").exists():
        return None
    timeline = directory / "timeline.json"
    try:
        if (reuse / "timeline.json").exists():
            shutil.copyfile(reuse / "timeline.json", timeline)
        count = redraw_pdf(pdf, directory / "annotated.pdf", directory / "work", reuse / "notes.json",
                           timeline_path=timeline, style=options["style"], octave=options["octave"],
                           font_size=options["font_size"], color=options.get("color", "#000000"),
                           notation=options.get("notation", "letters"), labels_path=directory / "labels.json",
                           log=log, stats=stats)
    except Exception as exc:
        log(f"Redrawing from the earlier reading failed, reading the sheet instead: {exc}")
        # Nothing of the attempt may leak into the reading that follows.
        for name in ("annotated.pdf", "timeline.json", "labels.json"):
            (directory / name).unlink(missing_ok=True)
        shutil.rmtree(directory / "work", ignore_errors=True)
        stats.clear()
        return None
    try:
        # Kept with this sheet too, so it can be drawn again from here.
        shutil.copyfile(reuse / "notes.json", directory / "notes.json")
    except Exception as exc:
        log(f"Keeping the notes for later failed, this sheet won't be redrawn from: {exc}")
    return count


def main(directory):
    """Run one job in `directory`; the exit status for worker.py. Anything
    other than a final answer below propagates, and is retried as a crash."""
    from run import NotMusic, Unreadable
    try:
        result = generate(directory / "source", directory, json.loads((directory / "options.json").read_text()))
        (directory / "result.json").write_text(json.dumps(result))
        return 0
    except (InvalidSheet, NotMusic, Unreadable) as exc:
        # A final answer the reader can act on - not a crash to retry. Without
        # NotMusic here, "no music notation was detected" never reached them:
        # the worker saw a crash, retried it three times, and showed its own
        # generic message instead.
        (directory / "result.json").write_text(json.dumps({"error": str(exc), "permanent": True}))
        return 2
    except Exception as exc:
        # Still a crash to retry, but worker.py would otherwise only see an
        # exit status: this is what its attempt log says went wrong.
        (directory / "result.json").write_text(json.dumps({"crash": crash_cause(directory, exc)}))
        raise


def crash_cause(directory, exc):
    """One line saying why a run crashed. For Audiveris, its own log names the
    page and the error (e.g. "Error processing stub ... no such edge in graph:
    Exclusion" on "[input#2]"); the CalledProcessError says only "exit 1"."""
    import subprocess
    if isinstance(exc, subprocess.CalledProcessError):
        try:
            logs = sorted((directory / "work").rglob("*.log"), key=lambda p: p.stat().st_mtime)
            lines = logs[-1].read_text(encoding="utf-8", errors="replace").splitlines() if logs else []
        except OSError:
            lines = []
        problems = [line for line in lines if "Error processing stub" in line or "No system found" in line]
        if problems:
            return "Audiveris: " + " ".join(problems[-1].split())[:400]
        return f"Audiveris exited with status {exc.returncode}"
    return f"{type(exc).__name__}: {exc}"[:400]


if __name__ == "__main__":
    import sys
    sys.exit(main(Path(sys.argv[1])))
