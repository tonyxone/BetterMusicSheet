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

from audiveris_heads import (
    _parse_sheet, load_sheet_heads, load_staff_lines, load_system_staff_groups,
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


def run_audiveris(pdf_path, out_dir, dpi=None, sheets=None, switches=None):
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
    for name, enabled in (switches or {}).items():
        # Audiveris's own optional detectors, all off by default. One that is
        # wrong for a given score costs accuracy rather than just time, so they
        # are only ever turned on for a targeted re-read - see retry_variants.
        cmd += ["-constant",
                f"org.audiveris.omr.sheet.ProcessingSwitches.{name}="
                f"{'true' if enabled else 'false'}"]
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
    """Rasterized size of each page, in megapixels, as Audiveris will see it."""
    try:
        with fitz.open(pdf_path) as doc:
            return [(page.rect.width * dpi / 72) * (page.rect.height * dpi / 72) / 1e6
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
    ys = set()
    try:
        doc = fitz.open(pdf_path)
    except (OSError, RuntimeError, ValueError):
        # Unreadable or absent: the same answer as a page with no vector staff
        # lines, which is "cannot measure", not "the staves are fine".
        return None
    with doc:
        if not 1 <= page <= doc.page_count:
            return None
        for drawing in doc[page - 1].get_drawings():
            for item in drawing["items"]:
                # Engravers draw staff lines as either hairline strokes or very
                # flat filled rectangles; both are long and horizontal.
                if (item[0] == "l" and abs(item[1].y - item[2].y) < .3
                        and abs(item[2].x - item[1].x) > 100):
                    ys.add(round(item[1].y, 2))
                elif item[0] == "re" and item[1].height < 1.5 and item[1].width > 100:
                    ys.add(round(item[1].y0 + item[1].height / 2, 2))
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
    if base_dpi != RETRY_DPI and (small_staves or poor_recall):
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


def retry_sparse_pages(pdf_path, work_dir, counts, sparse_pages, num_pages=None, base_dpi=None):
    """Re-read each flagged page, trying variants until one recovers the music.

    Returns {page: {"omr": path, "mxl": path}} for pages a re-read improved;
    a page nothing helped keeps its original recognition and is absent here.

    Both halves of Audiveris's output are kept, not just the .omr: anything
    reading rhythm from the MusicXML (see timeline.py) has to read the SAME
    recognition pass this page's pixel data came from, or the two sources
    disagree on note counts for exactly the pages that needed a retry.
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
                mxl, omr = run_audiveris(pdf_path, retry_dir, **variant)
            except subprocess.CalledProcessError:
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
                  dpi=None, auto_retry=True, log=print, timeline_path=None, color="#000000"):
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
    if auto_retry:
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
            page_overrides = retry_sparse_pages(pdf_path, work_dir, counts, sparse, num_pages, dpi)

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
    render(str(pdf_path), str(output), records, font_size=font_size, color=color)
    log(f"Done: {output} ({len(records)} labeled beat-groups)")
    return len(records)


def main():
    ap = argparse.ArgumentParser(description="Annotate a piano sheet-music PDF with note-name labels.")
    ap.add_argument("input_pdf")
    ap.add_argument("-o", "--output", default=None)
    ap.add_argument("--style", choices=["unicode", "ascii"], default="unicode")
    ap.add_argument("--octave", action="store_true")
    ap.add_argument("--font-size", type=float, default=6.5)
    ap.add_argument("--color", default="#000000",
                     help="Note-label colour as #rrggbb (default: black).")
    ap.add_argument("--work-dir", default="output")
    ap.add_argument("--timeline", default=None,
                     help="Also write the playback timeline JSON here (see timeline.py).")
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

    annotate_pdf(pdf_path, output, args.work_dir, style=args.style, octave=args.octave,
                 font_size=args.font_size, dpi=args.dpi, auto_retry=not args.no_auto_retry,
                 timeline_path=args.timeline, color=args.color)


if __name__ == "__main__":
    main()
