"""Measure how much of a score actually survives recognition.

The unit tests check recognition logic against hand-authored fixtures. This
measures the real thing, on real PDFs, and reports the numbers a change to the
pipeline is supposed to move:

    printed   noteheads the PDF itself draws (vector engraving only) - ground
              truth, since the publisher put them there
    detected  noteheads Audiveris found
    placed    of those, the ones its RHYTHMS step gave a time offset; a head
              without one never reaches the MusicXML and is silent in playback
    exported  pitched notes in the MusicXML
    playable  notes in the built timeline, where one was written

`printed` is the only external ground truth available without hand-labelling a
score, and it exists only for vector PDFs. A scan reports it as `-` rather than
guessing: absent evidence is not evidence of correctness.

    python tools/accuracy.py server_jobs/<id>/work/input.omr
    python tools/accuracy.py --jobs        # every stored job

Read-only. It never runs Audiveris and never writes to a job.
"""
import argparse
import collections
import glob
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pymupdf

import musicxml
from run import placed_head_ratio, staff_interline_pt

# Standard SMuFL codepoints. Leland and Bravura use these, so most modern
# exports are read directly.
SMUFL_NOTEHEADS = (0xE0A2, 0xE0A3, 0xE0A4)
# A glyph is a notehead candidate only where it sits on a staff at a half-space
# position, which is where noteheads - and little else - are drawn.
ON_STAFF_FRACTION = 0.70


def _staff_geometry(page):
    """(middle y, interline) per staff, from the page's own vector rules."""
    ys = set()
    for drawing in page.get_drawings():
        for item in drawing["items"]:
            if (item[0] == "l" and abs(item[1].y - item[2].y) < .3
                    and abs(item[2].x - item[1].x) > 100):
                ys.add(round(item[1].y, 2))
            elif item[0] == "re" and item[1].height < 1.5 and item[1].width > 100:
                ys.add(round(item[1].y0 + item[1].height / 2, 2))
    ordered = sorted(ys)
    staves = []
    for i in range(0, max(0, len(ordered) - 4)):
        group = ordered[i:i + 5]
        gaps = [b - a for a, b in zip(group, group[1:])]
        if max(gaps) - min(gaps) < 1.0 and 2 < gaps[0] < 15:
            staves.append((group[2], statistics.mean(gaps)))
    return staves


def _glyphs(page):
    """Private-use glyphs on the page, as {codepoint: [(x, y), ...]}."""
    found = collections.defaultdict(list)
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                for char in span.get("chars", []):
                    if ord(char["c"]) >= 0xE000:
                        found[ord(char["c"])].append(tuple(char["origin"]))
    return found


def _on_staff(positions, staves):
    """How many of these glyphs sit at a half-space position on some staff."""
    hits = 0
    for _, y in positions:
        for middle, interline in staves:
            if abs(y - middle) > interline * 4.3:
                continue
            steps = (y - middle) / (interline / 2)
            hits += abs(steps - round(steps)) < .22
            break
    return hits


def printed_noteheads(page):
    """Noteheads the engraving itself draws, or None for a scan.

    Standard SMuFL codepoints are used where present. Otherwise the font is a
    legacy or proprietary one with its own private-use layout - MuseScore's old
    MScore font puts the black notehead at U+E12D, Sibelius's Opus elsewhere -
    so the notehead is identified by behaviour instead: the most frequent
    private-use glyph whose occurrences overwhelmingly sit at half-space staff
    positions. Returns (count, basis), naming the evidence used, so a surprising
    number can be traced rather than taken on faith.
    """
    glyphs = _glyphs(page)
    if not glyphs:
        return None, "no vector text layer (scan?)"
    direct = sum(len(glyphs.get(cp, ())) for cp in SMUFL_NOTEHEADS)
    if direct:
        return direct, "SMuFL noteheads"
    staves = _staff_geometry(page)
    if not staves:
        return None, "no vector staff lines"
    ranked = sorted(((len(pos), cp) for cp, pos in glyphs.items()
                     if _on_staff(pos, staves) >= len(pos) * ON_STAFF_FRACTION),
                    reverse=True)
    if not ranked:
        return None, "no staff-aligned glyph found"
    count, cp = ranked[0]
    return count, f"legacy font, notehead inferred as U+{cp:04X}"


def measure_sheet(pdf_path, omr_path, mxl_path=None, timeline_path=None):
    """One row per page, plus the count of bars that are not the modal length."""
    exported = collections.Counter()
    if mxl_path and os.path.exists(mxl_path):
        try:
            notes, measures = musicxml.load_score_notes(mxl_path)
            page_of = {m["measure_index"]: m["page"] for m in measures}
            exported = collections.Counter(page_of.get(n["measure_index"]) for n in notes)
        except Exception as exc:
            print(f"  ! MusicXML unreadable: {exc}")

    playable, off_modal = collections.Counter(), None
    if timeline_path and os.path.exists(timeline_path):
        timeline = json.loads(open(timeline_path, encoding="utf-8").read())
        page_of = {m["printed_index"]: m["page"] for m in timeline["measures"]}
        playable = collections.Counter(page_of.get(n["printed_measure_index"])
                                       for n in timeline["notes"])
        lengths = collections.Counter(m["length_beats"] for m in timeline["measures"])
        # Not every off-modal bar is wrong - a meter change and a pickup are
        # both legitimate - but a score full of them is a rhythm failure.
        modal = lengths.most_common(1)[0][0]
        off_modal = sum(v for k, v in lengths.items() if k != modal)

    rows = []
    with pymupdf.open(pdf_path) as doc:
        for page in range(1, doc.page_count + 1):
            count, basis = printed_noteheads(doc[page - 1])
            try:
                detected, placed = placed_head_ratio(omr_path, page)
            except Exception:
                detected, placed = 0, 0
            rows.append({"page": page, "printed": count, "basis": basis,
                         "detected": detected, "placed": placed,
                         "exported": exported.get(page, 0),
                         "playable": playable.get(page, 0),
                         "interline_px": (staff_interline_pt(pdf_path, page) or 0) * 300 / 72})
    return rows, off_modal


def report(name, rows, off_modal):
    print(f"\n{name}")
    print(f"  {'page':>4} {'printed':>8} {'detected':>9} {'placed':>11} "
          f"{'exported':>9} {'playable':>9} {'px/interline':>13}")
    for r in rows:
        placed = f"{r['placed']} ({r['placed'] / r['detected']:.0%})" if r["detected"] else "-"
        printed = r["printed"] if r["printed"] is not None else "-"
        print(f"  {r['page']:>4} {str(printed):>8} {r['detected']:>9} {placed:>11} "
              f"{r['exported']:>9} {r['playable']:>9} {r['interline_px']:>13.1f}")
    printed = [r["printed"] for r in rows if r["printed"] is not None]
    detected = sum(r["detected"] for r in rows)
    placed = sum(r["placed"] for r in rows)
    summary = (f"  TOTAL printed={sum(printed) if printed else '-'} detected={detected} "
               f"placed={placed}"
               + (f" ({placed / detected:.1%} of detected)" if detected else "")
               + f" exported={sum(r['exported'] for r in rows)}"
               + f" playable={sum(r['playable'] for r in rows)}")
    if off_modal is not None:
        summary += f" off-modal-bars={off_modal}"
    print(summary)
    if printed and detected:
        print(f"  detection recall against the printed engraving: {detected / sum(printed):.1%}"
              f"   ({', '.join(sorted({r['basis'] for r in rows}))})")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("omr", nargs="*", help="one or more .omr files")
    ap.add_argument("--jobs", action="store_true",
                    help="audit every stored job under server_jobs/")
    args = ap.parse_args()

    targets = list(args.omr)
    if args.jobs:
        targets += sorted(glob.glob("server_jobs/*/work/*.omr"))
    if not targets:
        ap.error("give at least one .omr, or --jobs")

    for omr in targets:
        work = os.path.dirname(omr)
        job = os.path.dirname(work)
        stem = os.path.splitext(os.path.basename(omr))[0]
        pdf = os.path.join(job, "input.pdf")
        if not os.path.exists(pdf):
            print(f"\n{omr}\n  ! no input.pdf beside it; skipped")
            continue
        rows, off_modal = measure_sheet(pdf, omr, os.path.join(work, f"{stem}.mxl"),
                                        os.path.join(job, "timeline.json"))
        report(os.path.relpath(omr), rows, off_modal)


if __name__ == "__main__":
    main()
