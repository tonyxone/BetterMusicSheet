"""End-to-end driver: PDF -> Audiveris OMR -> annotated PDF.

Usage:
    .venv\\Scripts\\python.exe run.py "input.pdf" -o "annotated.pdf"
"""
import argparse
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

import pymupdf as fitz

import page_size
import scan
from config import MAX_JOB_SECONDS
from audiveris_heads import (
    _parse_sheet, has_sheet, load_sheet_heads, load_staff_lines, load_system_staff_groups,
)

AUDIVERIS_DIR = Path(__file__).parent / "tools" / "Audiveris" / "Audiveris"
AUDIVERIS_EXE = AUDIVERIS_DIR / "Audiveris.exe"  # Windows launcher (jpackage), bundles its own JRE
AUDIVERIS_APP_DIR = AUDIVERIS_DIR / "app"  # same jars work with a system `java` on Linux

# Measured, not assumed. On the page this retry exists for - a Liszt etude
# printing 738 noteheads that 300 DPI reads 74 of - 400 DPI finds 712 in 66s
# and 600 DPI finds 715 in 181s. The recognition curve has flattened well
# before 600, so the extra 115 seconds a page buys three noteheads.
RETRY_DPI = 400

# Raising the DPI only pays where the staff interline is genuinely too small
# in pixels for Audiveris's scale detection - a low-resolution scan, or a
# miniature engraving. Rasterized from a normal-size vector PDF the interline
# is already 17-21px at Audiveris's default 300 DPI, and a 600 DPI pass then
# returns identical recognition for 5.8x the runtime (measured over a 4-page
# score: same heads, same export, same measures). Below this it earns its cost.
MIN_INTERLINE_PX = 15.0

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

# A page can contain plenty of correctly detected heads while Audiveris fails
# to assign many of them to MusicXML voices/onsets. That was the dominant
# failure in the Chopin Nocturne: all 1241 of its noteheads were detected, and
# only 733 of them reached the export.
#
# An earlier note here credited page 4's recovery - 104 exported notes to 190 -
# to re-running it at 600 DPI. Re-measuring showed DPI had nothing to do with
# it: 300 and 600 DPI both export 190 for that page run on its own, and both
# export 104 for it run as part of the book. The isolation is what recovered
# it, by dropping the wrong time signature inherited from page 1. See
# retry_variants.
MIN_SCORE_NOTE_AGREEMENT = 0.85
# Vector PDFs provide independent evidence of what is actually printed.  When
# the export contains far fewer notes than that evidence, Audiveris can agree
# with itself while still having lost a dense passage.
MIN_VECTOR_EXPORT_RATIO = 0.85
MIN_VECTOR_HEADS_FOR_CHECK = 40
# Detection, as distinct from export: how many of the noteheads the engraving
# prints were found at all. Below this, resolution is worth spending time on,
# whatever the staff interline says - a page can have perfectly normal staves
# and still pack its notes too tightly to separate at the default rasterization.
# Measured on a Liszt etude: page 7 has a healthy 20.7px interline and 738
# printed noteheads, of which 300 DPI found 74 and 600 DPI found 715.
MIN_VECTOR_DETECTION_RATIO = 0.90
MIN_RETRY_QUALITY_GAIN = 0.03

# A notehead becomes a playable note only if Audiveris's RHYTHMS step gives its
# chord a time offset. Heads without one are dropped from the MusicXML export:
# silent in playback, though the annotated PDF still labels them. A head-count
# test is blind to this - every head is present and correct.
#
# Across 243 pages of this project's own uploads the ratio is sharply bimodal -
# median 99.6%, with the broken pages falling away to 69-80% - so the cut sits
# in the gap between the two, and flags about a tenth of pages.
MIN_PLACED_HEAD_RATIO = 0.90
# ...but only where a page holds enough music for the ratio to mean anything.
# At 20 heads a single unplaced chord already reads as 75%.
MIN_HEADS_FOR_RHYTHM_CHECK = 40
# A re-read has to recover real music to be worth keeping, not merely drift up.
MIN_PLACED_GAIN = 0.03
# A retry can produce additional MusicXML notes which the score-to-page matcher
# cannot place on the printed sheet. A couple can be an unavoidable edge case,
# but accepting a pass that adds a large batch of amber, unverified playheads
# without adding positions is worse than leaving the original recognition in
# place. The allowance is deliberately tiny: it is only for rounding and
# recovery edge cases, not a second way to trade verified music for guesses.
MAX_EXTRA_UNVERIFIED_NOTES = 2
# A re-read must not wreck the bar lengths either. It reinterprets the
# whole page, so bars move a little; doubling the longest one is not movement.
# Measured: good re-reads reached 1.5x, the bad ones 5x and 6.4x.
MAX_BAR_GROWTH = 2.0

NOT_MUSIC_MESSAGE = (
    "No music notation was detected in this PDF. Make sure it's actually a sheet "
    "music score (with staff lines and notes) and not a scan of something else, "
    "a blank page, or a non-music document."
)


class NotMusic(ValueError):
    """The upload holds no readable music. A final answer, not a crash:
    processor.py hands NOT_MUSIC_MESSAGE to the reader instead of retrying."""


class Unreadable(ValueError):
    """Audiveris crashed on this upload at every resolution tried. Its crash is
    deterministic, so retrying the same job cannot help: processor.py reports
    this to the reader as a final answer (the operator is still alerted)."""


UNREADABLE_MESSAGE = (
    "We couldn't read the music on this sheet. We've been notified and will look "
    "into it. A flat, evenly lit, straight-on photo or a PDF often reads better."
)
# Resolutions to read an upload at when the default one makes Audiveris crash,
# which it does deterministically on some pages (a NullPointerException in its
# STEMS step on a phone photo). A different resolution changes the staff scale
# and page layout it builds, which is usually enough to avoid the bug.
CRASH_FALLBACK_DPIS = (220, 400)


# Audiveris caps a time signature's width below what a two-digit numeral
# takes. Nuvole Bianche's 12/8 (Sibelius, the 1 and 2 touching) was skipped,
# so every bar after it was expected in 4/4 and lost the chords past that
# length. At 3 interlines it reads 12/8; page 1 of all 20 local test pieces
# read the same time signatures and bar lengths as before.
WIDE_TIME_SIGNATURES = {"org.audiveris.omr.sheet.time.TimeBuilder.maxTimeWidth": 3}


def run_audiveris(pdf_path, out_dir, dpi=None, sheets=None, switches=None, binarize=False, constants=None):
    """Recognize ``pdf_path`` into ``out_dir``; returns the .mxl and .omr.

    ``binarize`` has Audiveris read a black-and-white copy of the scanned pages
    instead, made at the same DPI it will read them at - see scan.py. At a
    forced ``dpi`` a picture coarser than it is enlarged here first
    (scan.enlarge_small_pictures).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    source = pdf_path
    if dpi is not None:
        source = scan.enlarge_small_pictures(source, out_dir / "enlarged", dpi, sheets)
    if binarize:
        source = scan.prepare_for_recognition(source, out_dir / "input", dpi, sheets)
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
        # cap, which is sized for the 300dpi default. Larger pages never get
        # here - see page_size.py.
        cmd += ["-constant", f"org.audiveris.omr.image.ImageLoading.pdfResolution={dpi}",
                "-constant", "org.audiveris.omr.step.LoadStep.maxPixelCount="
                             f"{dpi * dpi * page_size.MAX_PAGE_SQUARE_INCHES}"]
    for name, enabled in (switches or {}).items():
        # Audiveris's own optional detectors, all off by default. One that is
        # wrong for a given score costs accuracy rather than just time, so they
        # are only ever turned on for a targeted re-read - see retry_variants.
        cmd += ["-constant",
                f"org.audiveris.omr.sheet.ProcessingSwitches.{name}="
                f"{'true' if enabled else 'false'}"]
    for name, value in {**WIDE_TIME_SIGNATURES, **(constants or {})}.items():
        cmd += ["-constant", f"{name}={value}"]
    if sheets is not None:
        # -sheets keeps each selected page's original sheet number in the
        # output .omr (e.g. "-sheets 3" still produces sheet#3, not sheet#1),
        # so callers can read it back with that same page number.
        cmd += ["-sheets"] + [str(s) for s in sheets]
    # The copy keeps the original's name, so the output is named alike.
    cmd += ["--", str(source)]
    subprocess.run(cmd, check=True)
    stem = pdf_path.stem
    mxl = out_dir / f"{stem}.mxl"
    omr = out_dir / f"{stem}.omr"
    if omr.exists() and not mxl.exists() and any(out_dir.glob(f"{stem}.mvt*.mxl")):
        raise SplitIntoMovements(f"Audiveris split {pdf_path.name} into movements")
    if not mxl.exists() or not omr.exists():
        raise RuntimeError(f"Audiveris did not produce expected output ({mxl}, {omr})")
    return mxl, omr


class SplitIntoMovements(RuntimeError):
    """Audiveris took an indented system for the start of a new movement and
    exported one file per movement, which nothing downstream reads."""


def _audiveris_log(work_dir, stem):
    """The text of Audiveris's own log for the latest run, or "" if none."""
    logs = sorted(work_dir.glob(f"{stem}-*.log"))
    try:
        return logs[-1].read_text(encoding="utf-8", errors="replace") if logs else ""
    except OSError:
        return ""


def _no_system_found(work_dir, stem):
    """Whether Audiveris's own log for this run shows it aborted with
    'No system found' - it fails outright (not just an empty result) when a
    page has nothing staff-like on it at all, which happens before any of our
    own detection code even runs."""
    return "No system found" in _audiveris_log(work_dir, stem)


# Audiveris sometimes throws while cleaning up one page ("no such edge in
# graph: Exclusion"), and then exports nothing for the whole book. Whether it
# does changes from run to run on the very same file - one sheet failed 4 runs
# in a row and then went through - so an immediate fresh run usually succeeds,
# for a fraction of what a whole job retry costs. Bounded by time as well as
# count, so a long book that crashes falls back to the job retry instead of
# spending its time limit here.
CRASH_RERUNS = 2
CRASH_RERUN_BUDGET_SECONDS = MAX_JOB_SECONDS / 3


def _a_sheet_crashed(work_dir, stem):
    """Whether Audiveris's log for this run shows one of its sheets threw - as
    opposed to failing for a reason a fresh run would only repeat."""
    return _STUB_CRASH.search(_audiveris_log(work_dir, stem)) is not None


# A page Audiveris drops as holding no music is logged like a crash, but a
# fresh run only drops it again.
_NO_MUSIC = r"\S*StepException: (Sheet removed|No system found|No regularly spaced lines found)"
_STUB_CRASH = re.compile(rf"Error processing stub (?!{_NO_MUSIC})")
# Every page that failed: "[input#3] Book.java:2044 | Error processing stub
# <cause>" ("[input]" in a one-page book) - a page with no music on it, such
# as a cover picture or a blank page, or one that crashed - and "Error
# visiting System#6 in {Page#1.2}" for one whose export threw. Any one of
# them fails the whole book.
_FAILED_SHEET = re.compile(r"\[[^\]\s#]*(?:#(\d+))?\][^|\n]*\|\s*Error processing stub (.*)")
_FAILED_EXPORT = re.compile(r"Error visiting System#\d+ in \{Page#(\d+)\.")


def _failed_sheets(work_dir, stem):
    """{page: whether it simply holds no music} for each page that failed."""
    text = _audiveris_log(work_dir, stem)
    failed = {}
    for number, cause in _FAILED_SHEET.findall(text):
        page = int(number or 1)
        failed[page] = failed.get(page, True) and re.match(_NO_MUSIC, cause) is not None
    for number in _FAILED_EXPORT.findall(text):
        failed[int(number)] = False
    return failed


# "With a too low interline value of 7 pixels, either this sheet contains no
# multi-line staves, or the picture resolution is too low". A phone screenshot
# saved as a PDF: its staff lines are there, just too few pixels apart.
_LOW_INTERLINE = re.compile(r"too low interline value of (\d+) pixels")
# Rasterizing such a page finer gives Audiveris enough pixels between the
# lines; measured on two screenshots with 7px and 9px interlines, both read
# in full at 600 DPI. Bounded, as the pages it applies to are small but the
# cost grows with the square.
MAX_UPSCALE_DPI = 800


def _upscaled_dpi(work_dir, stem, dpi):
    """The DPI that gives the staves Audiveris dropped as too fine a usable
    interline, or None if there are none or it would not read them finer."""
    found = _LOW_INTERLINE.findall(_audiveris_log(work_dir, stem))
    if not found:
        return None
    current = dpi or DEFAULT_DPI
    needed = current * MIN_INTERLINE_PX / max(1, min(int(px) for px in found))
    target = min(MAX_UPSCALE_DPI, -(-int(needed) // 100) * 100)
    return target if target > current else None


# Audiveris starts a new movement at an indented system, and an indent is all
# it takes - the cut-off last system of a phone photo was one. Raised past any
# page width, no system counts as indented, and the book exports as one piece.
NO_MOVEMENTS = {"org.audiveris.omr.sheet.SystemManager.minIndentation": 1000}


def recognize_book(pdf_path, work_dir, dpi=None, log=print):
    """The whole-book Audiveris pass, read again where a fresh run does
    better: at once if a page crashed, finer if its staves were too coarse to
    find, as one piece if it came back split into movements, and without any
    page it cannot read - a cover picture, a blank page, one that keeps
    crashing - so one such page never costs the rest. Only a book with no
    readable page at all fails. Returns the .mxl, the .omr, and the DPI they
    were read at."""
    started = time.monotonic()
    constants, runs, crashes, sheets = None, 0, 0, None
    fallbacks = list(CRASH_FALLBACK_DPIS)
    while True:
        runs += 1
        try:
            mxl, omr = run_audiveris(pdf_path, work_dir, dpi=dpi, sheets=sheets, constants=constants)
            if sheets:
                number_pages(mxl, sheets)
            return mxl, omr, dpi
        except SplitIntoMovements:
            if constants:
                raise
            log("[1/3] Audiveris split the sheet into movements; reading it again as one piece ...")
            constants = NO_MOVEMENTS
        except (subprocess.CalledProcessError, RuntimeError):
            stem = pdf_path.stem
            finer = _upscaled_dpi(work_dir, stem, dpi)
            # One more run costs about what the runs so far averaged.
            spent = time.monotonic() - started
            within_budget = spent * (runs + 1) / runs <= CRASH_RERUN_BUDGET_SECONDS
            if finer:
                log(f"[1/3] The pages are too low-resolution to read; reading them again at {finer} DPI ...")
                dpi = finer
            elif _a_sheet_crashed(work_dir, stem) and crashes < CRASH_RERUNS and within_budget:
                crashes += 1
                log(f"[1/3] Audiveris crashed on a page; reading the sheet again ({crashes} of {CRASH_RERUNS}) ...")
            else:
                pages = sheets or list(range(1, count_pages(pdf_path) + 1))
                failed = {page: no_music for page, no_music in _failed_sheets(work_dir, stem).items()
                          if page in pages}
                kept = [page for page in pages if page not in failed]
                if failed and kept and within_budget:
                    left_out = ", ".join(str(page) for page in sorted(failed))
                    log(f"[1/3] No music could be read on page {left_out}; reading the other pages ...")
                    sheets = kept
                elif failed and not kept and all(failed.values()):
                    raise NotMusic(NOT_MUSIC_MESSAGE)
                elif _a_sheet_crashed(work_dir, stem) and fallbacks and within_budget:
                    # Reruns at this resolution only repeat a deterministic
                    # crash; another resolution changes what Audiveris builds.
                    dpi = fallbacks.pop(0)
                    log(f"[1/3] Audiveris keeps crashing; reading the sheet again at {dpi} DPI ...")
                elif _a_sheet_crashed(work_dir, stem) and crashes:
                    raise Unreadable(UNREADABLE_MESSAGE)
                else:
                    raise
        _clear_audiveris_output(work_dir, pdf_path.stem)


def number_pages(mxl_path, pages):
    """Stamp each page of an export with the PDF page it was read from, as
    MusicXML's print page-number. An export numbers only the pages it read, so
    with a cover left out the music's first page would claim to be page 1."""
    import xml.etree.ElementTree as ET
    import zipfile
    with zipfile.ZipFile(mxl_path) as z:
        entries = {info: z.read(info.filename) for info in z.infolist()}
    score = next(info for info in entries if info.filename.endswith(".xml")
                 and not info.filename.startswith("META-INF/"))
    root = ET.fromstring(entries[score])
    for part in root.iter("part"):
        index = 0
        for position, measure in enumerate(part.iter("measure")):
            pr = measure.find("print")
            if position == 0:
                if pr is None:
                    pr = ET.Element("print")
                    measure.insert(0, pr)
            elif pr is None or pr.get("new-page") != "yes":
                continue
            else:
                index += 1
            if index < len(pages):
                pr.set("page-number", str(pages[index]))
    entries[score] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    with zipfile.ZipFile(mxl_path, "w", zipfile.ZIP_DEFLATED) as z:
        for info, data in entries.items():
            z.writestr(info, data)


def _clear_audiveris_output(work_dir, stem):
    """Remove a failed run's book and log, so the next run starts clean and
    its own log is the one read back - by _a_sheet_crashed, and by the
    worker's page progress."""
    for path in [work_dir / f"{stem}.omr", work_dir / f"{stem}.mxl", *work_dir.glob(f"{stem}.mvt*.mxl"),
                 *work_dir.glob(f"{stem}-*.log")]:
        path.unlink(missing_ok=True)


# Audiveris's cost tracks the rasterized area of a page and, to within the
# noise, nothing else: fitting recognition time against both page area and
# printed notehead count over 35 scores put the whole weight on area and drove
# the notehead term to zero. A dense page and a sparse one of the same size
# cost the same. Median error 9%, 90th percentile 16%.
SECONDS_PER_MEGAPIXEL = 1.6
# What a page is rasterized to when no DPI is forced, matching Audiveris's own
# default - see run_audiveris.
DEFAULT_DPI = 300
# Re-reading a single page costs about three quarters more than that page's
# share of a whole-book pass: the run pays for starting the engine and opening
# the book once for one page, where a book pass spreads that over all of them.
# Measured at three resolutions on the same page - 23-37s against 21 predicted,
# 66s against 37, 142s against 84.
RETRY_PASS_OVERHEAD = 1.75


def page_megapixels(pdf_path, dpi=DEFAULT_DPI):
    """Rasterized size of each page, in megapixels, as Audiveris will see it -
    an oversized page at the size page_size.py shrinks it to."""
    try:
        with fitz.open(pdf_path) as doc:
            return [(page.rect.width * dpi / 72) * (page.rect.height * dpi / 72)
                    * page_size.page_scale(page) ** 2 / 1e6
                    for page in doc]
    except (OSError, RuntimeError, ValueError):
        return []


def estimated_seconds(pdf_path, dpi=DEFAULT_DPI, pages=None, single_page=False):
    """How long one recognition pass over these pages should take.

    Available the moment a file arrives - it needs the page geometry and
    nothing else, so it works for a scan as readily as for a vector PDF, and
    costs no OMR. It covers a single pass; re-reading unclear pages is charged
    separately, because which pages need it cannot be known until the first
    pass has finished (notehead density does not predict it - a 680-notehead
    page recognized cleanly while a 382-notehead one needed two re-reads).
    """
    sizes = page_megapixels(pdf_path, dpi)
    if pages is not None:
        sizes = [sizes[p - 1] for p in pages if 1 <= p <= len(sizes)]
    seconds = SECONDS_PER_MEGAPIXEL * sum(sizes)
    return seconds * RETRY_PASS_OVERHEAD if single_page else seconds


def estimated_retry_seconds(pdf_path, sparse_pages, poor_recall_pages=()):
    """Best and worst case for re-reading the flagged pages, in seconds.

    Chargeable only once the first pass has named the pages, which is also the
    first honest moment to tell someone a score is going to take a while.

    A range rather than a number, because the ladder stops as soon as a page
    recovers and there is no way to know in advance which will. A page short of
    noteheads leads with resolution: best case that succeeds and nothing else
    runs, worst case it fails and both cheap passes follow. A page whose heads
    were all found but never voiced only ever gets the cheap passes.

    On the score this was built for the range came out 4.3 to 9.3 minutes
    against a measured 6.1.
    """
    pages = list(sparse_pages)[:MAX_RETRY_PAGES]
    low = high = 0.0
    poor = set(poor_recall_pages)
    for page in pages:
        cheap = estimated_seconds(pdf_path, DEFAULT_DPI, [page], single_page=True)
        if page in poor:
            dearer = estimated_seconds(pdf_path, RETRY_DPI, [page], single_page=True)
            low += dearer
            high += dearer + 2 * cheap
        else:
            low += cheap
            high += 2 * cheap
    return low, high


def printed_notehead_total(pdf_path, num_pages):
    """Noteheads the engraving itself draws, or None where it cannot be read.

    A vector PDF states its own note count, so a waiting reader can be told how
    much music is being worked through rather than only which page.
    """
    counts = [n for n in vector_notehead_counts(pdf_path, num_pages).values() if n]
    return sum(counts) if counts else None


def describe_duration(low, high=None):
    """A waiting reader's idea of how long, not a stopwatch's.

    Rounded to the minute above a minute, and rendered as a range when one is
    given: the re-read ladder stops early whenever a page recovers, so a single
    number would be a promise the pipeline has no way to keep.
    """
    def minutes(seconds):
        return max(1, round(seconds / 60))

    if high is None or minutes(high) == minutes(low):
        if low < 90:
            return "less than a minute" if low < 45 else "about a minute"
        return f"about {minutes(low)} minutes"
    return f"{minutes(low)}-{minutes(high)} minutes"


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


def system_sizes(omr_path, num_pages):
    """Staves recognized in each system of the document, in reading order."""
    sizes = []
    for page in range(1, num_pages + 1):
        try:
            sizes += [len(group) for group in load_system_staff_groups(str(omr_path), page)]
        except Exception:
            continue
    return sizes


def missing_staves(omr_path, num_pages):
    """Staves recognition dropped from systems that should have them.

    Every system of a score carries the same staves, so a system with fewer
    than the fullest one has lost some - and with them a hand's notes, its
    bar structure (Audiveris merged three bars of a one-staff system into
    one), and playback from there on. Counted against the fullest system
    rather than the commonest, because a badly read scan can lose a staff
    from half its systems or more: one upload kept 10 of 20 intact.
    """
    sizes = system_sizes(omr_path, num_pages)
    return sum(max(sizes) - size for size in sizes) if sizes else 0


def lone_staves(omr_path, num_pages):
    """Systems recognized with a single staff. A page that lost the same staff
    from every system looks complete to missing_staves - a phone screenshot of
    a piano score came back as one staff - though a melody line genuinely has
    one, and the black-and-white re-read then simply finds no more."""
    return sum(size == 1 for size in system_sizes(omr_path, num_pages))


def reread_binarized(pdf_path, work_dir, omr_path, num_pages, dpi=None, log=print):
    """Re-read a scan that lost staves from a black-and-white copy of it.

    See scan.py for why a digitally rendered scan loses staves and why
    binarizing it first recovers them. Returns (mxl, omr) of the re-read when
    it recovered staves without placing fewer notes, else None - including when
    nothing in the document is a scan clean enough to binarize safely.

    Only offered where staves went missing. On scans that keep all their
    staves the copy reads about as well, not better - over three such test
    scores it moved the notehead count by -1.3% to +1.3% of what the
    engraving prints, at every threshold tried - so there it would buy a
    difference, not an improvement. Where staves were lost it recovered all
    of them: 30 of 40 staves to 40, and 21 of 30 to 30.
    """
    target = work_dir / "binarized"
    source = scan.prepare_for_recognition(pdf_path, target / "input", dpi)
    if source == Path(pdf_path):
        return None
    log(f"[1b/3] Some staves look unrecognized; re-reading "
        f"the scan should take {describe_duration(estimated_seconds(pdf_path, dpi or DEFAULT_DPI))}:")
    try:
        mxl, omr = run_audiveris(source, target, dpi=dpi, constants=NO_MOVEMENTS)
    except (subprocess.CalledProcessError, RuntimeError):
        print("  the re-read failed; keeping the original recognition")
        return None

    def placed(book):
        total = 0
        for page in range(1, num_pages + 1):
            try:
                total += placed_head_ratio(book, page)[1]
            except Exception:
                continue
        return total

    staves = sum(system_sizes(omr, num_pages))
    if staves > sum(system_sizes(omr_path, num_pages)) and placed(omr) >= placed(omr_path):
        print(f"  the black-and-white copy found {staves} staves - keeping it")
        return mxl, omr
    print("  no better; keeping the original recognition")
    return None


def placed_head_ratio(omr_path, page):
    """How many detected noteheads Audiveris's RHYTHMS step actually placed.

    A head only becomes a playable note if its chord was given a time offset;
    one that never gets there is dropped from the MusicXML export and is silent
    in playback, even though the annotated PDF still labels it. That failure is
    invisible to a head count - the heads are all there, correctly positioned -
    which is why it went unmeasured for so long.

    Returns ``(heads, placed)``; a page with no heads returns ``(0, 0)``.
    """
    from audiveris_heads import load_chord_id_groups
    from score_notes import page_structure

    heads = load_sheet_heads(omr_path, page)
    if not heads:
        return 0, 0
    chords = load_chord_id_groups(omr_path, page)
    _, chord_meta = page_structure(_parse_sheet(omr_path, page),
                                   load_staff_lines(omr_path, page))
    placed = sum(1 for h in heads
                 if chord_meta.get(chords.get(h["id"]), {}).get("onset") is not None)
    return len(heads), placed


def staff_interline_pt(pdf_path, page):
    """Median staff-line spacing on a page, in PDF points, read from the PDF's
    own vector rules - so it is known before Audiveris has run at all.

    Returns None when the page has no vector staff lines, which is the scanned
    case, and precisely the one where a higher DPI is worth trying.
    """
    try:
        doc = fitz.open(pdf_path)
    except (OSError, RuntimeError, ValueError):
        # Unreadable or absent: the same answer as a page with no vector staff
        # lines, which is "cannot measure", not "the staves are fine".
        return None
    with doc:
        if not 1 <= page <= doc.page_count:
            return None
        ys = scan.vector_staff_rule_ys(doc[page - 1])
    ordered = sorted(ys)
    # Gaps within one staff only: anything larger is the space between staves.
    gaps = [b - a for a, b in zip(ordered, ordered[1:]) if 2 < b - a < 15]
    return statistics.median(gaps) if gaps else None


def vector_notehead_counts(pdf_path, num_pages):
    """Count standard SMuFL noteheads printed by each vector-PDF page.

    ``None`` means the page has no usable SMuFL text layer (usually a scan),
    not that the page contains zero notes.
    """
    noteheads = {0xE0A2, 0xE0A3, 0xE0A4}
    counts = {}
    try:
        with fitz.open(pdf_path) as doc:
            for page in range(min(num_pages, doc.page_count)):
                chars = [ord(char['c'])
                         for block in doc[page].get_text('rawdict')['blocks']
                         for line in block.get('lines', [])
                         for span in line.get('spans', [])
                         for char in span.get('chars', [])]
                counts[page + 1] = sum(char in noteheads for char in chars) if any(
                    char in noteheads for char in chars) else None
    except (OSError, RuntimeError, ValueError):
        return {}
    return counts


def find_sparse_pages(omr_path, num_pages, mxl_path=None, pdf_path=None):
    """Return pages whose note detection or score structure looks incomplete.

    Raw head density catches visibly sparse recognition. When MusicXML is
    available, head/note disagreement also catches pages where the heads were
    found but never assigned usable voices or onsets.

    The relative and absolute density tests above are combined with structural
    agreement. Returns (counts, pages) with pages ordered worst-first, so a
    caller that can only afford to re-run some of them re-runs the ones most
    likely to be broken.
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

    # Heads that never reached a voice slot. This is the failure a head count
    # cannot see, and the one that actually costs notes in playback.
    placed = {}
    for page in range(1, num_pages + 1):
        try:
            total, in_voice = placed_head_ratio(omr_path, page)
        except Exception:
            continue
        if total < MIN_HEADS_FOR_RHYTHM_CHECK:
            continue
        placed[page] = in_voice / total
        if placed[page] < MIN_PLACED_HEAD_RATIO:
            sparse.add(page)

    agreements = {}
    vector_agreements = {}
    empty_export_pages = set()
    vector_counts = vector_notehead_counts(pdf_path, num_pages) if pdf_path else {}
    if mxl_path is not None:
        try:
            import musicxml
            notes, measures = musicxml.load_score_notes(mxl_path)
            for page in range(1, num_pages + 1):
                wanted = {m['measure_index'] for m in measures if m['page'] == page}
                exported = sum(n['measure_index'] in wanted for n in notes)
                agreements[page] = min(counts[page], exported) / max(1, counts[page], exported)
                if counts[page] and agreements[page] < MIN_SCORE_NOTE_AGREEMENT:
                    sparse.add(page)
                printed = vector_counts.get(page)
                if printed is not None and printed >= MIN_VECTOR_HEADS_FOR_CHECK:
                    vector_agreements[page] = exported / printed
                    if vector_agreements[page] < MIN_VECTOR_EXPORT_RATIO:
                        sparse.add(page)

            exported_by_measure = {m['measure_index']: 0 for m in measures}
            for note in notes:
                exported_by_measure[note['measure_index']] += 1
            # A real silent measure is represented by a rest. An entirely
            # empty MusicXML measure in a score with printed notation is an
            # export hole, and page-level density alone can hide a single lost
            # bar inside an otherwise healthy page.
            for measure in measures:
                if not exported_by_measure[measure['measure_index']] and not measure['rests']:
                    sparse.add(measure['page'])
                    empty_export_pages.add(measure['page'])
        except (OSError, ValueError, KeyError):
            # Head-density checks remain useful when an incomplete export
            # cannot be parsed at all.
            pass

    # Deliberately left as a plain count comparison, with no staff condition:
    # this is the pre-existing test and a page whose staves went undetected
    # entirely is one of the cases it already covers.
    # A page the book left out as holding no music has nothing to re-read.
    read = {page for page in counts if has_sheet(str(omr_path), page)}
    if len(read) >= 2:
        median = statistics.median(counts[page] for page in read)
        if median >= SPARSE_MIN_MEDIAN:
            sparse.update(p for p in read if counts[p] < SPARSE_RATIO * median)
    sparse &= read

    def severity(page):
        # Noteheads per staff, so a short final page isn't ranked as worse than
        # a full one simply for holding less music. Pages with no staves sort
        # last: re-running them is the least likely to recover anything, since
        # staff detection survives low resolution far better than noteheads do.
        if not staves[page]:
            return (1, 1.0, 0.0)
        # Worst first by whichever kind of incompleteness is the more severe:
        # music missing from the export, or heads missing from the page.
        return (0 if page in empty_export_pages else 1,
                min(agreements.get(page, 1.0), placed.get(page, 1.0),
                       vector_agreements.get(page, 1.0)),
                counts[page] / staves[page])

    return counts, sorted(sparse, key=severity)


def retry_variants(pdf_path, page, base_dpi=None, poor_recall=False):
    """Re-recognition attempts for one incomplete page, cheapest first.

    Each is a different hypothesis about why the page failed, not a larger dose
    of the same one:

    - **The page on its own.** A sheet inherits the time signature recognized
      earlier in the book, and a wrong one is worse than none at all: Audiveris
      force-fits the music into bars too short to hold it and discards whatever
      overflows. Running the page alone drops that inheritance. On page 4 of a
      Chopin nocturne this by itself took the export from 104 notes to 190, at
      unchanged resolution.
    - **Inferred tuplets.** An unmarked tuplet - an ornamental run written over
      a plain bass - has no rational fit, so its chords never receive a time
      offset and never reach the export. Inferring them took that same score
      from 733 exported notes to 1226, against 1240 actually printed. Left off
      by default because inferring tuplets in music that has none is its own
      failure mode, which is why this is a targeted re-read and not a setting.
    - **Higher DPI**, last, because it costs several times the runtime and on
      ordinary engraving returns identical recognition. Two different things
      make it worth paying for, and a page needs only one of them: staff lines
      too close together to resolve (MIN_INTERLINE_PX), or notes too densely
      packed to separate, which shows up as noteheads the engraving prints and
      recognition never found (``poor_recall``). The second was missed at first
      because it is invisible to the interline test: the Liszt page that gained
      641 noteheads at 600 DPI has staves of an entirely normal size.
    """
    base = {"sheets": [page]}
    if base_dpi is not None:
        base["dpi"] = base_dpi
    cheap = [("the page on its own", base),
             ("inferred tuplets", {**base, "switches": {"implicitTuplets": True}})]
    interline = staff_interline_pt(pdf_path, page)
    small_staves = interline is None or interline * 300 / 72 < MIN_INTERLINE_PX
    dearer = []
    if (base_dpi or DEFAULT_DPI) < RETRY_DPI and (small_staves or poor_recall):
        dearer = [(f"{RETRY_DPI} DPI", {"sheets": [page], "dpi": RETRY_DPI}),
                  (f"{RETRY_DPI} DPI with inferred tuplets",
                   {"sheets": [page], "dpi": RETRY_DPI, "switches": {"implicitTuplets": True}})]
    # Cheapest first is the wrong order when noteheads are missing outright: no
    # amount of re-reading the same pixels differently will conjure a notehead
    # that was never detected, so resolution leads for those pages even though
    # it costs the most. A page whose heads were all found but never placed in
    # a voice is the opposite case, and the cheap passes are the ones with a
    # chance. Measured: leading with resolution saves both cheap passes once it
    # succeeds, which were 69s and 74s of pure waste on one upload.
    yield from (dearer + cheap if poor_recall else cheap + dearer)


def _longest_bar(mxl_path, page, single_page=False):
    """Beats in the page's longest measure, by written content.

    Acceptance has to be able to refuse one specific trade outright: a re-read
    that places more noteheads into voices while inventing absurd bar lengths.
    One observed pass took a page from 86% placed to 100% and returned measures
    of 30, 40 and 45 beats in a score whose bars hold 6 - worse for playback
    than the under-recognition it replaced, because the music after such a bar
    is adrift rather than merely incomplete.

    Measured against written content rather than the time signature, because a
    page re-read on its own has no time signature to measure against: the meter
    is usually printed once, on the first page, and an isolated page never sees
    it. Every re-read that proved good across this project's scores stayed
    within 1.5x its page's original longest bar, while the two bad ones ran
    to 5x and 6.4x - so the comparison is meaningful even when the meter is not.
    """
    import musicxml
    try:
        _, measures = musicxml.load_score_notes(mxl_path)
    except (OSError, ValueError, KeyError):
        return 0.0
    lengths = [m["content_length_beats"] for m in measures
               if single_page or m["page"] == page]
    return max(lengths, default=0.0)


def _page_alignment(pdf_path, mxl_path, omr_path, num_pages, page, page_override=None):
    """Return positioned and unverified playback notes for one printed page.

    This uses the same score-to-page alignment as the playback timeline rather
    than treating every MusicXML note as a win. It distinguishes a retry that
    restores real, visible notes from one that only creates additional amber
    playheads with no verified location.
    """
    from timeline import prepare_score

    try:
        prepared = prepare_score(pdf_path, mxl_path, omr_path, num_pages,
                                 page_omr_overrides=page_override)
    except Exception:
        return None
    notes = [note for measure, notes in prepared['printed']
             if measure['page'] == page for note in notes]
    return {'positioned': sum(note.get('bbox_pt') is not None for note in notes),
            'unverified': sum(note.get('bbox_pt') is None for note in notes)}


def _page_scores(omr_path, mxl_path, page, single_page=False, alignment=None):
    """The numbers a re-read is judged on, for one page."""
    try:
        heads, placed = placed_head_ratio(omr_path, page)
    except Exception:
        heads, placed = 0, 0
    scores = {"count": heads,
              "placed": placed / heads if heads else 0.0,
              "longest_bar": _longest_bar(mxl_path, page, single_page=single_page),
              "quality": recognition_quality(omr_path, mxl_path, page, single_page=single_page)}
    if alignment is not None:
        scores.update(alignment)
    return scores


def _recovered_more_music(new, old):
    """Whether a re-read earned its place over what we already had.

    Never on notehead count alone: more detections are not more correct notes,
    and a pass that finds extra heads while placing fewer of them into voices
    has made playback worse while looking better.
    """
    if new["count"] < old["count"] * .9:
        return False  # lost heads outright - whatever else improved, reject it
    if new["placed"] < old["placed"] - MIN_PLACED_GAIN:
        # Fewer of the heads are playable than before. This has to be checked
        # ahead of the head-count test below, which would otherwise accept a
        # pass that found extra noteheads while dropping the music they belong
        # to - the exact trade this function exists to refuse.
        return False
    if old["longest_bar"] and new["longest_bar"] > old["longest_bar"] * MAX_BAR_GROWTH:
        # Bar lengths fell apart. Checked before every acceptance test below,
        # including the placed-head one: a page whose measures no longer add up
        # carries the music after them out of time, which is a worse failure
        # than the missing notes this re-read was meant to recover.
        return False
    if 'positioned' in old and 'positioned' not in new:
        # The original page was verified against the PDF, but this candidate
        # could not be. Do not downgrade a known position map to a guess.
        return False
    if 'positioned' in old and 'positioned' in new:
        positioned_gain = new['positioned'] - old['positioned']
        unverified_gain = new['unverified'] - old['unverified']
        if positioned_gain < 0:
            return False
        if unverified_gain > max(MAX_EXTRA_UNVERIFIED_NOTES, positioned_gain):
            # More notes with no location are not a recovery. In particular,
            # this rejects a real observed retry which added 17 unverified
            # notes while leaving its 226 positioned notes unchanged.
            return False
    if new["placed"] >= old["placed"] + MIN_PLACED_GAIN:
        return True  # more of the page is actually playable
    if new["count"] > old["count"] and new["quality"] >= old["quality"] - .03:
        return True  # the pre-existing head-count test, unchanged
    return (new["placed"] >= old["placed"]
            and new["quality"] >= old["quality"] + MIN_RETRY_QUALITY_GAIN)


def retry_sparse_pages(pdf_path, work_dir, counts, sparse_pages, num_pages=None, base_dpi=None,
                       binarize=False):
    """Re-read each flagged page, trying variants until one recovers the music.

    Returns {page: {"omr": path, "mxl": path}} for pages a re-read improved;
    a page nothing helped keeps its original recognition and is absent here.

    Both halves of Audiveris's output are kept, not just the .omr: anything
    reading rhythm from the MusicXML (see timeline.py) has to read the SAME
    recognition pass this page's pixel data came from, or the two sources
    disagree on note counts for exactly the pages that needed a retry. For the
    same reason ``binarize`` says the pass in ``work_dir`` read a binarized
    copy of the scan (see reread_binarized), and the re-reads do too.
    """
    overrides = {}
    if num_pages is None:
        if not Path(pdf_path).is_file():
            # Unit-level callers can exercise retry selection with a synthetic
            # OMR/MusicXML pair and no rendered PDF. Production always passes
            # num_pages from annotate_pdf, so it always gets alignment checks.
            num_pages = 0
        else:
            num_pages = count_pages(pdf_path)
    original_omr = work_dir / f"{pdf_path.stem}.omr"
    original_mxl = work_dir / f"{pdf_path.stem}.mxl"
    # How much of what the engraving prints was found at all, per page. Only a
    # vector PDF can answer this; a scan reports None and falls back to the
    # staff-size test alone.
    printed = vector_notehead_counts(pdf_path, num_pages) if num_pages else {}
    if len(sparse_pages) > MAX_RETRY_PAGES:
        print(f"  {len(sparse_pages)} pages look under-recognized; re-running only the "
              f"{MAX_RETRY_PAGES} worst to bound how long one upload can run")
        sparse_pages = sparse_pages[:MAX_RETRY_PAGES]
    # Back into page order once the cap has taken the worst ones, so the log
    # reads down the document rather than by severity.
    for page in sorted(sparse_pages):
        original_alignment = (_page_alignment(pdf_path, original_mxl, original_omr,
                                              num_pages, page)
                              if num_pages else None)
        best = _page_scores(original_omr, original_mxl, page,
                            alignment=original_alignment)
        print(f"  page {page}: recognition looks incomplete ({counts[page]} noteheads, "
              f"{best['placed']:.0%} of them placed in a voice) - re-reading ...")
        expected = printed.get(page)
        poor_recall = (expected is not None and expected >= MIN_VECTOR_HEADS_FOR_CHECK
                       and counts[page] < expected * MIN_VECTOR_DETECTION_RATIO)
        if poor_recall:
            print(f"    only {counts[page]} of the {expected} noteheads this page prints "
                  f"were found; resolution is worth trying")
        resolution_helped = None
        for index, (label, variant) in enumerate(
                retry_variants(pdf_path, page, base_dpi, poor_recall)):
            if page in overrides and best["placed"] >= MIN_PLACED_HEAD_RATIO:
                # Already recovered; a further pass cannot earn its runtime.
                break
            if variant.get("dpi") and resolution_helped is False:
                # The expensive pass already showed this page gains nothing from
                # more pixels; its companion costs the same for the same answer.
                # Two such passes were 126s and 142s on one upload.
                print(f"    skipping {label}: the higher-resolution pass found no "
                      f"extra noteheads")
                continue
            retry_dir = work_dir / f"_retry_p{page}_{index}"
            try:
                # A re-read is weighed against the book read as one piece, so
                # it is read as one piece too.
                mxl, omr = run_audiveris(pdf_path, retry_dir, constants=NO_MOVEMENTS,
                                         **({**variant, "binarize": True} if binarize else variant))
            except (subprocess.CalledProcessError, RuntimeError):
                # A re-read is only ever a chance at a better page; the one
                # already read stands if it fails, whatever the reason.
                print(f"    {label}: Audiveris failed; trying the next approach")
                continue
            override = {page: {'omr': str(omr), 'mxl': str(mxl)}}
            alignment = (_page_alignment(pdf_path, original_mxl, original_omr,
                                         num_pages, page, override)
                         if num_pages else None)
            scores = _page_scores(omr, mxl, page, single_page=True,
                                  alignment=alignment)
            if variant.get("dpi"):
                # Judged on detected heads, not on acceptance: the only question
                # is whether more pixels reveal more notation.
                resolution_helped = scores["count"] > counts[page] * 1.05
            summary = (f"{scores['count']} noteheads, {scores['placed']:.0%} placed, "
                       f"quality {scores['quality']:.2f}")
            if 'positioned' in scores:
                summary += (f", {scores['positioned']} positioned, "
                            f"{scores['unverified']} unverified")
            if _recovered_more_music(scores, best):
                overrides[page] = {"omr": str(omr), "mxl": str(mxl)}
                best = scores
                print(f"    {label}: {summary} - keeping this one")
            else:
                print(f"    {label}: {summary} - no better than what we have")
        if page not in overrides:
            print(f"    no re-read improved page {page}; keeping the original recognition")
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
                  dpi=None, auto_retry=True, log=print, timeline_path=None, color="#000000",
                  labels_path=None, notation="letters", stats=None, notes_path=None):
    """Run the full PDF -> Audiveris OMR -> annotated PDF pipeline. Shared by the
    CLI (main(), below) and the web API (server.py) so the two stay in sync.

    ``timeline_path``: optional path to also write the playback timeline JSON
    (see timeline.py). Best-effort - a failure there is logged and ignored, so
    a bug in the playback data can never cost someone their annotated PDF.

    ``labels_path``: optional path to also write the placed labels as JSON
    (see label_export.py), for the web viewer's editable label layer. Also
    best-effort, for the same reason.

    ``notes_path``: optional path to also save the notes read (save_notes),
    so the same file can later be drawn with other settings by redraw_pdf.
    Best-effort too.

    ``stats``: optional dict, filled in with ``notes_named`` - how many
    noteheads the reader identified, each given a name. (A chord repeated
    within a bar is named once, by its first label, but its notes count.)

    Returns the number of labeled beat-groups written to ``output``.
    """
    pdf_path = Path(pdf_path)
    work_dir = Path(work_dir)
    # Everything below reads the shrunk copy of an oversized page, and what it
    # produces is scaled back to the upload's pages at the end.
    upload = pdf_path
    pdf_path, scales = page_size.shrink_oversized(upload, work_dir / "page-size")

    log(f"[1/3] Running Audiveris OMR on {pdf_path.name} ...")
    mxl, omr, dpi = recognize_book(pdf_path, work_dir, dpi, log)
    num_pages = count_pages(pdf_path)

    if not has_any_staff(omr, num_pages):
        raise NotMusic(NOT_MUSIC_MESSAGE)

    page_overrides = {}
    binarized = False
    if auto_retry:
        if missing_staves(omr, num_pages) or lone_staves(omr, num_pages):
            reread = reread_binarized(pdf_path, work_dir, omr, num_pages, dpi, log)
            if reread:
                mxl, omr = reread
                # The page re-reads below compare against, and re-read, this pass.
                work_dir, binarized = Path(omr).parent, True
        counts, sparse = find_sparse_pages(omr, num_pages, mxl, pdf_path)
        if sparse:
            # The first honest moment to say a score will take a while: which
            # pages need re-reading, and why, are both known now, and neither
            # could be guessed from the file itself.
            printed = vector_notehead_counts(pdf_path, num_pages)
            detection_failures = [
                page for page in sparse
                if (printed.get(page) or 0) >= MIN_VECTOR_HEADS_FOR_CHECK
                and counts[page] < (printed.get(page) or 0) * MIN_VECTOR_DETECTION_RATIO]
            low, high = estimated_retry_seconds(pdf_path, sparse, detection_failures)
            log(f"[1b/3] {len(sparse)} page(s) look incomplete; re-reading them should "
                f"take {describe_duration(low, high)}:")
            page_overrides = retry_sparse_pages(pdf_path, work_dir, counts, sparse, num_pages, dpi,
                                                binarize=binarized)

    log("[2/3] Matching pitches to notehead positions ...")
    from score_notes import resolve_score_notes
    resolved = resolve_score_notes(str(pdf_path), str(omr), num_pages, page_overrides)
    prepared = None
    try:
        from timeline import prepare_score
        prepared = prepare_score(str(pdf_path), str(mxl), str(omr), num_pages,
                                 page_overrides, resolved_notes=resolved)
    except Exception as e:
        log(f"Rhythm alignment unavailable; using resolved OMR labels: {e}")
    if stats is not None:
        stats["notes_named"] = len(resolved["notes"])
        # The book as read, kept beside the sheet once it is done (worker.py).
        # Pages re-read on their own count only in the names, not in these.
        stats["musicxml"], stats["omr"] = str(mxl), str(omr)
    unnamed = []
    if labels_path is not None:
        try:
            from unnamed_notes import unnamed_notes
            # Printed notes nothing read - the viewer rings them. In the
            # shrunk copy's points, like the names, until restored below.
            unnamed = unnamed_notes(str(pdf_path), resolved, num_pages)
            if unnamed:
                log(f"[2/3] {len(unnamed)} printed note(s) were not recognized and have no name")
        except Exception as e:
            log(f"Unnamed-note check skipped: {e}")

    tl = None
    if timeline_path is not None:
        try:
            import json

            from timeline import build_timeline
            tl = build_timeline(str(pdf_path), str(mxl), str(omr), num_pages,
                                page_omr_overrides=page_overrides, prepared_score=prepared)
            Path(timeline_path).write_text(json.dumps(
                page_size.restore_timeline(tl, scales) if scales else tl), encoding="utf-8")
            log(f"[2b/3] Playback timeline: {len(tl['measures'])} measures, "
                f"{len(tl['notes'])} notes")
        except Exception as e:
            log(f"[2b/3] Timeline build failed, Play mode unavailable for this sheet: {e}")

    if notes_path is not None:
        try:
            save_notes(notes_path, resolved, unnamed, tl if scales else None)
        except Exception as e:
            log(f"Saving the read notes failed, this sheet can't be redrawn: {e}")
    return draw_names(pdf_path, upload, scales, output, resolved, tl, unnamed, style=style, octave=octave,
                      font_size=font_size, color=color, notation=notation, labels_path=labels_path, log=log)


def draw_names(pdf_path, upload, scales, output, resolved, tl, unnamed, style="unicode", octave=False,
               font_size=6.5, color="#000000", notation="letters", labels_path=None, log=print):
    """Everything the settings decide, from notes already read: the names'
    text, the annotated PDF, and the labels for the viewer. Shared by
    annotate_pdf and redraw_pdf, so a sheet drawn again from saved notes
    comes out exactly as reading it afresh would.

    ``pdf_path`` is the copy recognition read (shrunk, when ``scales``), and
    ``resolved``, ``tl`` and ``unnamed`` are in its points; ``upload`` is
    the file as uploaded, which the output is scaled back to.
    """
    from annotate import records_from_resolved, render
    records = records_from_resolved(resolved, style, octave, notation=notation)
    log(f"Resolved {len(resolved['notes'])} noteheads into {len(records)} label groups.")
    log(f"[3/3] Rendering {output} ...")
    placed = render(str(pdf_path), str(output), records, font_size=font_size, color=color)
    if scales:
        page_size.restore_pdf(output, upload, scales)
    if labels_path is not None:
        try:
            import json

            from label_export import labels_document
            # Matched to the timeline's notes while both are still in the
            # shrunk copy's points.
            document = labels_document(placed, tl, font_size=font_size, color=color, notation=notation,
                                       unnamed=unnamed)
            if scales:
                document = page_size.restore_labels(document, scales)
            Path(labels_path).write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        except Exception as e:
            log(f"Label export failed, label editing unavailable for this sheet: {e}")
    log(f"Done: {output} ({len(records)} labeled beat-groups)")
    return len(records)


# The notes a reading found, saved so that the same file uploaded again with
# other settings is only drawn again (redraw_pdf), not read again. Bump when
# what is saved changes shape; an older file is then read from scratch.
NOTES_VERSION = 1


def save_notes(path, resolved, unnamed, shrunk_timeline=None):
    """``shrunk_timeline``: the timeline in the shrunk copy's points, for an
    oversized upload only - otherwise the published timeline already is."""
    import json
    Path(path).write_text(json.dumps({"version": NOTES_VERSION, "resolved": resolved, "unnamed": unnamed,
                                      "timeline": shrunk_timeline}, ensure_ascii=False), encoding="utf-8")


def _number_keys(mapping):
    """JSON keeps only string keys; page and staff numbers were ints."""
    return {int(k) if isinstance(k, str) and k.lstrip("-").isdigit() else k: v for k, v in mapping.items()}


def load_notes(path):
    """What save_notes wrote, with its page and staff numbers ints again."""
    import json
    saved = json.loads(Path(path).read_text(encoding="utf-8"))
    if saved.get("version") != NOTES_VERSION:
        raise ValueError(f"saved notes are version {saved.get('version')}, not {NOTES_VERSION}")
    resolved = saved["resolved"]
    resolved["pages"] = {page: {**data, "staff_lines_pt": _number_keys(data.get("staff_lines_pt") or {})}
                         for page, data in _number_keys(resolved.get("pages") or {}).items()}
    return saved


def redraw_pdf(pdf_path, output, work_dir, notes_path, timeline_path=None, style="unicode", octave=False,
               font_size=6.5, color="#000000", notation="letters", labels_path=None, log=print, stats=None):
    """annotate_pdf for a file whose notes were already read (save_notes):
    the names are drawn with these settings, and nothing is read again.
    ``timeline_path``: the reading's published timeline, if it has one."""
    import json
    upload = Path(pdf_path)
    pdf_path, scales = page_size.shrink_oversized(upload, Path(work_dir) / "page-size")
    saved = load_notes(notes_path)
    tl = saved.get("timeline")
    if tl is None and timeline_path is not None and Path(timeline_path).exists():
        tl = json.loads(Path(timeline_path).read_text(encoding="utf-8"))
    resolved = saved["resolved"]
    if stats is not None:
        stats["notes_named"] = len(resolved["notes"])
    return draw_names(pdf_path, upload, scales, output, resolved, tl, saved.get("unnamed") or [], style=style,
                      octave=octave, font_size=font_size, color=color, notation=notation,
                      labels_path=labels_path, log=log)


def main():
    ap = argparse.ArgumentParser(description="Annotate a piano sheet-music PDF with note-name labels.")
    ap.add_argument("input_pdf")
    ap.add_argument("-o", "--output", default=None)
    ap.add_argument("--style", choices=["unicode", "ascii"], default="unicode")
    ap.add_argument("--octave", action="store_true")
    ap.add_argument("--notation", choices=["letters", "numbers", "solfege"], default="letters",
                    help="letter names (C D E), jianpu numbers, 1 = C (1 2 3), or solfege (do re mi)")
    ap.add_argument("--font-size", type=float, default=6.5)
    ap.add_argument("--color", default="#000000",
                     help="Note-label colour as #rrggbb (default: black).")
    ap.add_argument("--work-dir", default="output")
    ap.add_argument("--timeline", default=None,
                     help="Also write the playback timeline JSON here (see timeline.py).")
    ap.add_argument("--labels", default=None,
                     help="Also write the placed labels as JSON here (see label_export.py).")
    ap.add_argument("--dpi", type=int, default=None,
                     help="Override Audiveris's PDF rasterization DPI (default: Audiveris's own, "
                          "normally 300). Worth raising only for scans or miniature engraving, where "
                          "the staff interline is under ~15px at 300 DPI; on normal vector engraving "
                          "it returns identical recognition for several times the runtime.")
    ap.add_argument("--no-auto-retry", action="store_true",
                     help="Disable automatically re-reading pages whose recognition looks "
                             "incomplete - either too few noteheads found, or too few of the ones "
                          "found placed into voices.")
    args = ap.parse_args()

    pdf_path = Path(args.input_pdf)
    output = args.output or str(pdf_path.with_name(pdf_path.stem + " (annotated).pdf"))

    annotate_pdf(pdf_path, output, args.work_dir, style=args.style, octave=args.octave, notation=args.notation,
                 font_size=args.font_size, dpi=args.dpi, auto_retry=not args.no_auto_retry,
                 timeline_path=args.timeline, color=args.color, labels_path=args.labels)


if __name__ == "__main__":
    main()
