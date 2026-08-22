"""End-to-end driver: PDF -> Audiveris OMR -> annotated PDF.

Usage:
    .venv\\Scripts\\python.exe run.py "input.pdf" -o "annotated.pdf"
"""
import argparse
import statistics
import subprocess
import sys
from pathlib import Path

import fitz

from audiveris_heads import load_sheet_heads, load_system_staff_groups

AUDIVERIS_DIR = Path(__file__).parent / "tools" / "Audiveris" / "Audiveris"
AUDIVERIS_EXE = AUDIVERIS_DIR / "Audiveris.exe"  # Windows launcher (jpackage), bundles its own JRE
AUDIVERIS_APP_DIR = AUDIVERIS_DIR / "app"  # same jars work with a system `java` on Linux

RETRY_DPI = 600
# a page is "sparse" (likely under-recognized, not just genuinely note-light)
# only if it falls well below its piece's own median AND that median itself
# is large enough to be a meaningful baseline.
SPARSE_RATIO = 0.4
SPARSE_MIN_MEDIAN = 20

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
    """Return page numbers whose detected notehead count looks suspiciously low
    next to the rest of the piece - a sign Audiveris under-recognized that page
    (e.g. dense engraving too small for its default rasterization DPI) rather
    than that page genuinely having little music on it."""
    counts = {}
    for page in range(1, num_pages + 1):
        try:
            counts[page] = len(load_sheet_heads(str(omr_path), page))
        except Exception:
            counts[page] = 0
    if len(counts) < 2:
        return counts, []
    median = statistics.median(counts.values())
    if median < SPARSE_MIN_MEDIAN:
        return counts, []
    sparse = [p for p, c in counts.items() if c < SPARSE_RATIO * median]
    return counts, sparse


def retry_sparse_pages(pdf_path, work_dir, counts, sparse_pages):
    """Re-run Audiveris at a higher DPI for just the flagged pages. Returns
    {page: alternate_omr_path} for pages where the retry actually found more
    notes than the original pass; pages where it didn't help are left alone."""
    overrides = {}
    for page in sparse_pages:
        print(f"  page {page}: only {counts[page]} noteheads detected (piece median "
              f"is much higher) - retrying at {RETRY_DPI} DPI ...")
        retry_dir = work_dir / f"_retry_p{page}"
        try:
            _mxl, omr = run_audiveris(pdf_path, retry_dir, dpi=RETRY_DPI, sheets=[page])
        except subprocess.CalledProcessError:
            print(f"    retry failed for page {page}; keeping the original recognition")
            continue
        new_count = len(load_sheet_heads(str(omr), page))
        if new_count > counts[page]:
            overrides[page] = str(omr)
            print(f"    {counts[page]} -> {new_count} noteheads - using the retry for this page")
        else:
            print(f"    {new_count} noteheads, no better than the original - keeping the original")
    return overrides


def annotate_pdf(pdf_path, output, work_dir, style="unicode", octave=False, font_size=6.5,
                  dpi=None, auto_retry=True, log=print):
    """Run the full PDF -> Audiveris OMR -> annotated PDF pipeline. Shared by the
    CLI (main(), below) and the web API (server.py) so the two stay in sync.

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
            log(f"[1b/3] {len(sparse)} page(s) look under-recognized vs. the rest of the piece:")
            page_overrides = retry_sparse_pages(pdf_path, work_dir, counts, sparse)

    log("[2/3] Matching pitches to notehead positions ...")
    from annotate import build_records, render
    records = build_records(str(pdf_path), str(omr), num_pages, style=style, octave=octave,
                             page_omr_overrides=page_overrides)

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
                 font_size=args.font_size, dpi=args.dpi, auto_retry=not args.no_auto_retry)


if __name__ == "__main__":
    main()
