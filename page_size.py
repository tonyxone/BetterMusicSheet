"""Pages far larger than paper: shrunk for recognition, restored afterwards.

A PDF's page size is whatever made it said it was. Two real uploads: an
engraving exported at exactly five times A4 (2976x4209pt, 41x58 inches), and a
phone photo converted with one pixel to the point (3024x4032pt). Audiveris
reads a page at 300 DPI and refuses any picture over 20 million pixels, so both
failed three attempts each - 217 million pixels. And nothing after recognition
is made for such a page either: labels are set in points, 6.5pt by default,
which on a page five times too big come out a fifth of their proper size.

So an oversized page is read from a copy shrunk to the area of an A4 sheet, the
whole pipeline runs on that copy, and everything it produces is scaled back to
the uploaded page before anyone sees it: the viewer lays the labels and
playback boxes over the upload itself, in its own points.

The page is scaled in place rather than redrawn onto a new one: its boxes are
scaled, and its drawing is wrapped in a matching transform. That keeps its
rotation, which pymupdf's show_pdf_page loses, and leaves its text, vector
paths and images where every other reader of the page expects them.
"""
import copy
import math
from pathlib import Path

import pymupdf

# The largest page run_audiveris hands to Audiveris. At a forced DPI it raises
# Audiveris's pixel cap to this many square inches of page; at Audiveris's own
# 300 DPI the cap is 20 million pixels, about 222. A3 is 193.
MAX_PAGE_SQUARE_INCHES = 200
# What an oversized page is shrunk to: the area of an A4 sheet.
A4_SQUARE_POINTS = 595 * 842

_BOXES = ("MediaBox", "CropBox", "TrimBox", "BleedBox", "ArtBox")


def page_scale(page):
    """The factor that brings this page to A4 area, or 1 if it already fits."""
    area = page.rect.width * page.rect.height
    if area <= MAX_PAGE_SQUARE_INCHES * 72 * 72:
        return 1.0
    return math.sqrt(A4_SQUARE_POINTS / area)


def _scale_page(doc, page, factor, boxes=None):
    """Scale ``page`` about its origin by ``factor``, in place.

    ``boxes`` sets each page box to exactly these values instead of scaling it,
    so a restored page gets back the upload's boxes unrounded.
    """
    for key in _BOXES:
        if boxes is not None:
            if key in boxes:
                doc.xref_set_key(page.xref, key, boxes[key])
            continue
        kind, value = doc.xref_get_key(page.xref, key)
        if kind == "array":
            numbers = (float(v) * factor for v in value.strip("[]").split())
            doc.xref_set_key(page.xref, key, "[%s]" % " ".join(f"{n:.6f}" for n in numbers))
    # Balanced, so anything drawn on the page later is drawn in page space.
    page.wrap_contents()
    start, end = doc.get_new_xref(), doc.get_new_xref()
    for xref, stream in ((start, f"q {factor:.9f} 0 0 {factor:.9f} 0 0 cm\n"), (end, "Q\n")):
        doc.update_object(xref, "<<>>")
        doc.update_stream(xref, stream.encode())
    contents = [start, *page.get_contents(), end]
    doc.xref_set_key(page.xref, "Contents", "[%s]" % " ".join(f"{x} 0 R" for x in contents))


def shrink_oversized(pdf_path, out_dir):
    """The PDF to recognize, and each page's scale - or ``pdf_path`` and None
    when every page already fits, which is nearly always.

    The copy keeps the original's file name, and so its stem, because
    Audiveris names its output after it.
    """
    pdf_path = Path(pdf_path)
    with pymupdf.open(pdf_path) as doc:
        scales = [page_scale(page) for page in doc]
        if all(s == 1 for s in scales):
            return pdf_path, None
        for page, s in zip(doc, scales):
            if s != 1:
                _scale_page(doc, page, s)
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / pdf_path.name
        doc.save(target, garbage=3, deflate=True)
    return target, scales


def restore_pdf(pdf_path, original_path, scales):
    """Scale ``pdf_path``'s pages back to ``original_path``'s size, in place."""
    with pymupdf.open(original_path) as original:
        boxes = []
        for page in original:
            found = {}
            for key in _BOXES:
                kind, value = original.xref_get_key(page.xref, key)
                if kind == "array":
                    found[key] = value
            boxes.append(found)
    with pymupdf.open(pdf_path) as doc:
        for page, s, found in zip(doc, scales, boxes):
            if s != 1:
                _scale_page(doc, page, 1 / s, found)
        data = doc.tobytes(garbage=3, deflate=True)
    Path(pdf_path).write_bytes(data)


def _enlarged(box, s):
    return [v / s for v in box] if box else box


def restore_timeline(timeline, scales):
    """A copy of a playback timeline (timeline.py) in the upload's points."""
    timeline = copy.deepcopy(timeline)
    pages = {}
    for m in timeline["measures"]:
        pages[m["index"]] = m["page"]
        m["bbox_pt"] = _enlarged(m["bbox_pt"], scales[m["page"] - 1])
    for n in timeline["notes"]:
        n["bbox_pt"] = _enlarged(n["bbox_pt"], scales[pages[n["measure_index"]] - 1])
    return timeline


def restore_labels(document, scales):
    """A copy of a labels document (label_export.py) in the upload's points."""
    document = copy.deepcopy(document)
    for item in document["items"]:
        s = scales[item["page"] - 1]
        item["x"], item["y"], item["size"] = (round(v / s, 2) for v in (item["x"], item["y"], item["size"]))
    for head in document.get("unnamed", ()):
        s = scales[head["page"] - 1]
        head["x"], head["y"], head["w"] = (round(v / s, 2) for v in (head["x"], head["y"], head["w"]))
    return document
