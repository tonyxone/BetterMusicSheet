"""Printed notes left without a name - the one recognition miss the viewer can
point at with certainty.

A vector PDF draws every notehead itself, as a glyph from the music font, so
those positions are ground truth: the publisher put them there. A printed
notehead that no recognized note covers was never read, so it has no name on
the sheet. The viewer rings each one and offers to add the name (see
better_music_sheet_web/app/sheet-viewer/sheet-editor.tsx).

Most such heads never get here: score_notes.merge_vector_pdf_noteheads adds
them to recognition first, so they are named like any other note. What is
left is what it could not place - a head between two staves, or further out
than its ledger limit.

Other recognition signals - low confidence, unmatched rhythm notes, octave or
duration warnings - turned out to flag mostly names that are right, so they
are not shown to readers. Only standard SMuFL noteheads are trusted, read by
the same score_notes.pdf_notehead_glyphs the gap filler uses: a scan has none,
and a legacy font's notehead can only be guessed at. Either way nothing is
reported, rather than a guess.
"""
import pymupdf

from score_notes import pdf_notehead_glyphs

# How far outside a recognized note's box a printed head's centre may fall and
# still be that note, in points: boxes are read from a raster, glyphs exactly.
MATCH_MARGIN_PT = 1.5


def printed_heads(page):
    """(centre x, centre y, width) of each notehead the page draws, in points.

    A SMuFL notehead sits on its baseline: the origin's y is the staff
    position the head is centred on. The same head drawn twice (some exports
    overprint) counts once."""
    heads = {}
    for _, _, y, (x0, _, x1, _) in pdf_notehead_glyphs(page):
        cx = (x0 + x1) / 2
        heads.setdefault((round(cx), round(y)), (cx, y, x1 - x0))
    return list(heads.values())


def unnamed_heads(heads_by_page, resolved_notes):
    """The printed heads no recognized note covers, as
    [{'page', 'x', 'y', 'w'}] - x and y the head's centre."""
    boxes = {}
    for n in resolved_notes:
        if n.get("bbox_pt"):
            boxes.setdefault(n["page"], []).append(n["bbox_pt"])
    m = MATCH_MARGIN_PT
    out = []
    for page, heads in sorted(heads_by_page.items()):
        for x, y, w in heads:
            if not any(b[0] - m <= x <= b[2] + m and b[1] - m <= y <= b[3] + m for b in boxes.get(page, ())):
                out.append({"page": page, "x": round(x, 2), "y": round(y, 2), "w": round(w, 2)})
    return out


def unnamed_notes(pdf_path, resolved, num_pages):
    """Printed notes on ``pdf_path`` that ``resolved`` (score_notes) never
    read, so they have no name. Empty for a scan."""
    with pymupdf.open(pdf_path) as doc:
        heads = {page + 1: printed_heads(doc[page]) for page in range(min(num_pages, doc.page_count))}
    return unnamed_heads(heads, resolved["notes"])
