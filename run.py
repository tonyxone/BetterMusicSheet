"""End-to-end driver: PDF -> Audiveris OMR -> annotated PDF.

Usage:
    .venv\\Scripts\\python.exe run.py "input.pdf" -o "annotated.pdf"
"""
import argparse
import statistics
import subprocess
import sys
from pathlib import Path

import pymupdf as fitz

from audiveris_heads import load_sheet_heads, load_system_staff_groups

AUDIVERIS_DIR = Path(__file__).parent / "tools" / "Audiveris" / "Audiveris"
AUDIVERIS_EXE = AUDIVERIS_DIR / "Audiveris.exe"  # Windows launcher (jpackage), bundles its own JRE
AUDIVERIS_APP_DIR = AUDIVERIS_DIR / "app"  # same jars work with a system `java` on Linux

RETRY_DPI = 600

# A page is "sparse" (likely under-recognized, not just genuinely note-light)
# by either of two tests - relative and absolute. They catch different
# failures and neither subsumes the other.
#
# Relative: the page falls well below its own piece's median, AND that median
# is itself large enough to be a meaningful baseline. Catches one bad page in
# an otherwise well-recognized score.
SPARSE_RATIO = 0.4
SPARSE_MIN_MEDIAN = 20

# Absolute: the page has real staves but hardly anything on them. The relative
# test is blind to a scan that is *uniformly* under-recognized - with every
# page equally bad there is no better page to be below, and a low median trips
# SPARSE_MIN_MEDIAN into skipping the piece entirely, which is exactly
# backwards. This one needs no baseline, so it also covers single-page PDFs
# (which the relative test cannot rank at all).
#
# Threshold from the sheets in this project: genuine music pages run 17-65
# noteheads per staff (median 31), while a page known to be under-recognized
# read 2.0. 8 sits clear of both.
SPARSE_MIN_HEADS_PER_STAFF = 8
# ...but only where enough staves were found to be a real system. A non-music
# PDF picks up occasional 1-staff false positives from table rules and
# underlines, and those pages have no noteheads by definition - without this
# floor every one of them would look "under-recognized" and queue a re-run.
# Piano music is two staves per system at minimum; the sparsest real page in
# this project has four.
SPARSE_MIN_STAVES = 2

# Worst case bound. A re-run costs roughly what that page cost the first time,
# and a badly-scanned document can flag every page at once; without a cap one
# upload could occupy a worker for an unbounded stretch. Pages are re-run
# worst-first, so a capped run still fixes the most broken ones.
MAX_RETRY_PAGES = 4

NOT_MUSIC_MESSAGE = (
    "No music notation was detected in this PDF. Make sure it's actually a sheet "
    "music score (with staff lines and notes) and not a scan of something else, "
    "a blank page, or a non-music document."
)


def run_audiveris(pdf_path, out_dir, dpi=None, sheets=None):
    out_dir.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        cmd = [str(AUDIVERIS_EXE), "-batch", "-export", "-output", str(out_dir)]
    else:
        # Audiveris.exe is a jpackage launcher bundling a Windows JRE; on Linux
        # run the same app jars directly with the system `java` instead.
        cmd = ["java", "-cp", str(AUDIVERIS_APP_DIR / "*"), "Audiveris",
               "-batch", "-export", "-output", str(out_dir)]
    if dpi is not None:
        # Audiveris's default 300dpi PDF rasterization can be too coarse for
        # dense/small engraving (16th-note runs etc.), causing it to miss
        # noteheads outright rather than just misreading them. Raising the
        # loader's own DPI also requires raising its max-pixel-count safety
        # cap, which is sized for the 300dpi default.
        cmd += ["-constant", f"org.audiveris.omr.image.ImageLoading.pdfResolution={dpi}",
                "-constant", f"org.audiveris.omr.step.LoadStep.maxPixelCount={dpi * dpi * 200}"]
    if sheets is not None:
        # -sheets keeps each selected page's original sheet number in the
        # output .omr (e.g. "-sheets 3" still produces sheet#3, not sheet#1),
        # so callers can read it back with that same page number.
        cmd += ["-sheets"] + [str(s) for s in sheets]
    cmd += ["--", str(pdf_path)]
    subprocess.run(cmd, check=True)
    stem = pdf_path.stem
    mxl = out_dir / f"{stem}.mxl"
    omr = out_dir / f"{stem}.omr"
    if not mxl.exists() or not omr.exists():
        raise RuntimeError(f"Audiveris did not produce expected output ({mxl}, {omr})")
    return mxl, omr


def _no_system_found(work_dir, stem):
    """Whether Audiveris's own log for this run shows it aborted with
    'No system found' - it fails outright (not just an empty result) when a
    page has nothing staff-like on it at all, which happens before any of our
    own detection code even runs."""
    logs = sorted(work_dir.glob(f"{stem}-*.log"))
    if not logs:
        return False
    try:
        text = logs[-1].read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return "No system found" in text


def count_pages(pdf_path):
    doc = fitz.open(pdf_path)
    n = doc.page_count
    doc.close()
    return n


def has_any_staff(omr_path, num_pages):
    """Whether Audiveris found a musical staff (its GRID step - staff lines
    grouped into systems) anywhere at all in the document. Staff-line detection
    is far more resolution-tolerant than notehead detection, so "zero staves
    anywhere, at default DPI" is a reliable signal the PDF isn't sheet music at
    all, rather than just being under-recognized."""
    for page in range(1, num_pages + 1):
        try:
            if load_system_staff_groups(str(omr_path), page):
                return True
        except Exception:
            continue
    return False


def find_sparse_pages(omr_path, num_pages):
    """Return page numbers whose detected notehead count looks suspiciously
    low - a sign Audiveris under-recognized that page (e.g. dense engraving too
    small for its default rasterization DPI) rather than that page genuinely
    having little music on it.

    Both the relative and absolute tests above are applied; see their comments
    for why one alone is not enough. Returns (counts, pages) with pages ordered
    worst-first, so a caller that can only afford to re-run some of them
    re-runs the ones most likely to be broken.
    """
    counts = {}
    staves = {}
    for page in range(1, num_pages + 1):
        try:
            counts[page] = len(load_sheet_heads(str(omr_path), page))
        except Exception:
            counts[page] = 0
        try:
            staves[page] = sum(len(g) for g in load_system_staff_groups(str(omr_path), page))
        except Exception:
            staves[page] = 0

    sparse = {
        page for page, count in counts.items()
        if staves[page] >= SPARSE_MIN_STAVES
        and count < SPARSE_MIN_HEADS_PER_STAFF * staves[page]
    }

    # Deliberately left as a plain count comparison, with no staff condition:
    # this is the pre-existing test and a page whose staves went undetected
    # entirely is one of the cases it already covers.
    if len(counts) >= 2:
        median = statistics.median(counts.values())
        if median >= SPARSE_MIN_MEDIAN:
            sparse.update(p for p, c in counts.items() if c < SPARSE_RATIO * median)

    def severity(page):
        # Noteheads per staff, so a short final page isn't ranked as worse than
        # a full one simply for holding less music. Pages with no staves sort
        # last: re-running them is the least likely to recover anything, since
        # staff detection survives low resolution far better than noteheads do.
        if not staves[page]:
            return (1, 0.0)
        return (0, counts[page] / staves[page])

    return counts, sorted(sparse, key=severity)


def retry_sparse_pages(pdf_path, work_dir, counts, sparse_pages):
    """Re-run Audiveris at a higher DPI for just the flagged pages. Returns
    {page: {"omr": path, "mxl": path}} for pages where the retry actually found
    more notes than the original pass; pages where it didn't help are left
    alone.

    Both halves of Audiveris's output are kept, not just the .omr: anything
    reading rhythm from the MusicXML (see timeline.py) has to read the SAME
    recognition pass this page's pixel data came from, or the two sources
    disagree on note counts for exactly the pages that needed a retry."""
    overrides = {}
    if len(sparse_pages) > MAX_RETRY_PAGES:
        print(f"  {len(sparse_pages)} pages look under-recognized; re-running only the "
              f"{MAX_RETRY_PAGES} worst to bound how long one upload can run")
        sparse_pages = sparse_pages[:MAX_RETRY_PAGES]
    # Back into page order once the cap has taken the worst ones, so the log
    # reads down the document rather than by severity.
    for page in sorted(sparse_pages):
        print(f"  page {page}: only {counts[page]} noteheads detected "
              f"- retrying at {RETRY_DPI} DPI ...")
        retry_dir = work_dir / f"_retry_p{page}"
        try:
            mxl, omr = run_audiveris(pdf_path, retry_dir, dpi=RETRY_DPI, sheets=[page])
        except subprocess.CalledProcessError:
            print(f"    retry failed for page {page}; keeping the original recognition")
            continue
        new_count = len(load_sheet_heads(str(omr), page))
        old_quality = recognition_quality(work_dir / f'{pdf_path.stem}.omr',
                                          work_dir / f'{pdf_path.stem}.mxl', page)
        new_quality = recognition_quality(omr, mxl, page, single_page=True)
        if new_count > counts[page] and new_quality >= old_quality - 0.03:
            overrides[page] = {"omr": str(omr), "mxl": str(mxl)}
            print(f"    {counts[page]} -> {new_count} noteheads - using the retry for this page")
        else:
            print(f"    {new_count} noteheads, quality {new_quality:.2f} vs {old_quality:.2f}; keeping the original")
    return overrides


def recognition_quality(omr_path, mxl_path, page, single_page=False):
    """Rank retries by recognition confidence and score consistency, not count.

    This is a selection heuristic, not a probability of musical correctness.
    """
    import musicxml
    try:
        heads = load_sheet_heads(str(omr_path), page)
        notes, measures = musicxml.load_score_notes(mxl_path)
        wanted = {m['measure_index'] for m in measures if single_page or m['page'] == page}
        ns = [n for n in notes if n['measure_index'] in wanted]
        ms = [m for m in measures if m['measure_index'] in wanted]
        confidence = statistics.mean(h.get('confidence', 0) for h in heads) if heads else 0
        agreement = min(len(heads), len(ns)) / max(1, len(heads), len(ns))
        from timeline import step_octave_to_midi
        in_range = sum(21 <= step_octave_to_midi(n['step'], n['octave'], n['alter']) <= 108 for n in ns) / max(1, len(ns))
        rhythm = sum(abs(m['content_length_beats'] - m['nominal_length_beats']) < 1e-6 or m['implicit'] for m in ms) / max(1, len(ms))
        return .4 * confidence + .25 * agreement + .2 * in_range + .15 * rhythm
    except (OSError, ValueError, KeyError):
        return 0.0


def annotate_pdf(pdf_path, output, work_dir, style="unicode", octave=False, font_size=6.5,
                  dpi=None, auto_retry=True, log=print, timeline_path=None):
    """Run the full PDF -> Audiveris OMR -> annotated PDF pipeline. Shared by the
    CLI (main(), below) and the web API (server.py) so the two stay in sync.

    ``timeline_path``: optional path to also write the playback timeline JSON
    (see timeline.py). Best-effort - a failure there is logged and ignored, so
    a bug in the playback data can never cost someone their annotated PDF.

    Returns the number of labeled beat-groups written to ``output``.
    """
    pdf_path = Path(pdf_path)
    work_dir = Path(work_dir)

    log(f"[1/3] Running Audiveris OMR on {pdf_path.name} ...")
    try:
        mxl, omr = run_audiveris(pdf_path, work_dir, dpi=dpi)
    except subprocess.CalledProcessError:
        if _no_system_found(work_dir, pdf_path.stem):
            raise ValueError(NOT_MUSIC_MESSAGE)
        raise
    num_pages = count_pages(pdf_path)

    if not has_any_staff(omr, num_pages):
        raise ValueError(NOT_MUSIC_MESSAGE)

    page_overrides = {}
    if dpi is None and auto_retry:
        counts, sparse = find_sparse_pages(omr, num_pages)
        if sparse:
            log(f"[1b/3] {len(sparse)} page(s) look under-recognized:")
            page_overrides = retry_sparse_pages(pdf_path, work_dir, counts, sparse)

    log("[2/3] Matching pitches to notehead positions ...")
    from annotate import build_records, render
    from score_notes import resolve_score_notes
    resolved = resolve_score_notes(str(pdf_path), str(omr), num_pages, page_overrides)
    prepared = None
    try:
        from timeline import prepare_score
        prepared = prepare_score(str(pdf_path), str(mxl), str(omr), num_pages,
                                 page_overrides, resolved_notes=resolved)
    except Exception as e:
        log(f"Rhythm alignment unavailable; using resolved OMR labels: {e}")
    records = build_records(str(pdf_path), str(omr), num_pages, style=style, octave=octave,
                             page_omr_overrides=page_overrides, resolved_notes=resolved)

    if timeline_path is not None:
        try:
            import json

            from timeline import build_timeline
            tl = build_timeline(str(pdf_path), str(mxl), str(omr), num_pages,
                                page_omr_overrides=page_overrides, prepared_score=prepared)
            Path(timeline_path).write_text(json.dumps(tl), encoding="utf-8")
            log(f"[2b/3] Playback timeline: {len(tl['measures'])} measures, "
                f"{len(tl['notes'])} notes")
        except Exception as e:
            log(f"[2b/3] Timeline build failed, Play mode unavailable for this sheet: {e}")

    log(f"[3/3] Rendering {output} ...")
    render(str(pdf_path), str(output), records, font_size=font_size)
    log(f"Done: {output} ({len(records)} labeled beat-groups)")
    return len(records)


def main():
    ap = argparse.ArgumentParser(description="Annotate a piano sheet-music PDF with note-name labels.")
    ap.add_argument("input_pdf")
    ap.add_argument("-o", "--output", default=None)
    ap.add_argument("--style", choices=["unicode", "ascii"], default="unicode")
    ap.add_argument("--octave", action="store_true")
    ap.add_argument("--font-size", type=float, default=6.5)
    ap.add_argument("--work-dir", default="output")
    ap.add_argument("--timeline", default=None,
                     help="Also write the playback timeline JSON here (see timeline.py).")
    ap.add_argument("--dpi", type=int, default=None,
                     help="Override Audiveris's PDF rasterization DPI (default: Audiveris's own, "
                          "normally 300). Try 450-600 for pages where dense passages go unrecognized.")
    ap.add_argument("--no-auto-retry", action="store_true",
                     help="Disable automatically re-scanning pages that look under-recognized "
                          "at a higher DPI (only applies when --dpi isn't set explicitly).")
    args = ap.parse_args()

    pdf_path = Path(args.input_pdf)
    output = args.output or str(pdf_path.with_name(pdf_path.stem + " (annotated).pdf"))

    annotate_pdf(pdf_path, output, args.work_dir, style=args.style, octave=args.octave,
                 font_size=args.font_size, dpi=args.dpi, auto_retry=not args.no_auto_retry,
                 timeline_path=args.timeline)


if __name__ == "__main__":
    main()
