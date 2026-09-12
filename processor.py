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
                with pymupdf.open("pdf", doc.convert_to_pdf()) as converted:
                    converted.save(pdf)
    except Exception as exc:
        raise InvalidSheet(f"Upload a valid, unencrypted PDF or image with at most {MAX_PAGES} pages.") from exc

    def log(message):
        print(message, flush=True)
        stage = STAGES.get(message.split(" ", 1)[0])
        if stage:
            publish(directory, stage=stage, pages=pages)

    timeline = directory / "timeline.json"
    count = annotate_pdf(pdf, directory / "annotated.pdf", directory / "work",
                         style=options["style"], octave=options["octave"], font_size=options["font_size"],
                         dpi=options["dpi"], auto_retry=options["auto_retry"], timeline_path=timeline,
                         log=log)
    return count


if __name__ == "__main__":
    import sys
    directory = Path(sys.argv[1])
    try:
        count = generate(directory / "source", directory, json.loads((directory / "options.json").read_text()))
        (directory / "result.json").write_text(json.dumps({"count": count}))
    except InvalidSheet as exc:
        (directory / "result.json").write_text(json.dumps({"error": str(exc), "permanent": True}))
        sys.exit(2)
