"""Scanned pages: preparing them for recognition, and reading their octave lines.

A vector PDF tells Audiveris exactly where every staff line is. A scan only
shows it a picture, which Audiveris resamples to its own resolution and
binarizes itself - and a digitally rendered scan does not survive that well.
Its staff lines are a one-pixel core with anti-aliased grey either side; drawn
at a scale the picture was not made for, that grey lands on a varying number of
pixels, and Audiveris's binarization counts the darker half of it as ink. Some
staves come out with 3px lines and others with 5px, and Audiveris drops every
staff whose lines are thicker than the rest. Measured on a five-page 200 DPI
upload: 30 of its 40 staves kept at 300 DPI, every dropped one a staff whose
lines had grown to 5px, and no cure in resolution - at 400 DPI its first page
still lost 3 of 8. A system that loses its bass staff loses its left hand,
its bar structure and its playback with it.

So a scan is binarized here first, at exactly the resolution Audiveris will
read it at, with a fixed mid-grey threshold that turns every line into the
same few pixels. Audiveris then sees a clean black-and-white picture it has no
reason to resample or re-threshold.

Octave lines are the other thing a scan loses. On a vector page pdf_marks reads
the "8va" glyph and its dashed line straight from the PDF; a scan has neither,
and Audiveris links none of them to notes (five 8va passages in the upload
above, several running across systems and pages, and not one note shifted).
ottava_intervals() finds them in the picture instead - see its docstring.
"""
import re
from pathlib import Path
from statistics import median

import pymupdf

from audiveris_heads import (
    load_binary_image, load_staff_extents, load_staff_lines, load_system_staff_groups,
)

# Audiveris's own PDF rasterization when no DPI is forced.
DEFAULT_DPI = 300

# A pixel darker than this is ink. Mid-grey, a little towards white, so an
# anti-aliased hairline keeps its core pixel wherever the resampling grid lands
# relative to it: at 128 some staff lines of the upload above thinned to 2px,
# at 160 every one of them came out 3-4px.
INK_LEVEL = 160

# Only pictures with a truly white background are thresholded here. That is
# what a digitally rendered sheet looks like - and what makes one fixed
# threshold safe. A photographed or paper-scanned page has a grey, unevenly lit
# background that a global threshold would turn into black blotches, and is
# left to Audiveris's own adaptive binarization, as before.
WHITE_LEVEL = 250
MIN_WHITE_FRACTION = 0.75

_WHITE = bytes(1 if v >= WHITE_LEVEL else 0 for v in range(256))
_BINARY = bytes(0 if v < INK_LEVEL else 255 for v in range(256))


def vector_staff_rule_ys(page):
    """y of every long horizontal vector rule on a page - its staff lines, if
    it draws any. Empty for a scan."""
    ys = set()
    for drawing in page.get_drawings():
        for item in drawing["items"]:
            # Engravers draw staff lines as either hairline strokes or very
            # flat filled rectangles; both are long and horizontal.
            if (item[0] == "l" and abs(item[1].y - item[2].y) < .3
                    and abs(item[2].x - item[1].x) > 100):
                ys.add(round(item[1].y, 2))
            elif item[0] == "re" and item[1].height < 1.5 and item[1].width > 100:
                ys.add(round(item[1].y0 + item[1].height / 2, 2))
    return ys


def is_scanned(page):
    """Whether the page's music is a picture rather than vector notation."""
    return bool(page.get_images()) and not vector_staff_rule_ys(page)


def _clean_binary(page, dpi):
    """The page as a black-and-white pixmap at ``dpi``, or None when it is not
    a digitally clean picture (see MIN_WHITE_FRACTION)."""
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
    samples = pix.samples
    if samples.translate(_WHITE).count(1) < MIN_WHITE_FRACTION * len(samples):
        return None
    return pymupdf.Pixmap(pymupdf.csGRAY, pix.width, pix.height,
                          samples.translate(_BINARY), False)


def prepare_for_recognition(pdf_path, out_dir, dpi=None, pages=None):
    """The PDF Audiveris should read: ``pdf_path`` itself, or a copy with its
    clean scanned pages binarized (see the module docstring).

    ``pages`` (1-based) limits the work to the pages a re-read will actually
    recognize; every other page is carried over untouched so page numbers stay
    put. The copy keeps the original's file name, and so its stem, because
    Audiveris names its output after it.
    """
    pdf_path = Path(pdf_path)
    dpi = dpi or DEFAULT_DPI
    cleaned = 0
    with pymupdf.open(pdf_path) as src, pymupdf.open() as out:
        for index, page in enumerate(src):
            binary = None
            if (pages is None or index + 1 in pages) and is_scanned(page):
                binary = _clean_binary(page, dpi)
            if binary is None:
                out.insert_pdf(src, from_page=index, to_page=index)
                continue
            copy = out.new_page(width=page.rect.width, height=page.rect.height)
            copy.insert_image(copy.rect, pixmap=binary)
            cleaned += 1
        if not cleaned:
            return pdf_path
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / pdf_path.name
        out.save(target, garbage=3, deflate=True)
    return target


# ---- octave lines -----------------------------------------------------------
#
# All measurements below are in staff interlines, so they hold at any DPI.
# Measured on the upload this was built for: dashes 0.5 long on a 1.17 period,
# the line 4.6 above the staff. The only other short horizontal strokes found
# regularly above or below a staff are ledger lines, which are about 1.9 long
# and follow the notes' own irregular spacing.
DASH_LENGTH = (0.2, 1.0)
DASH_GAP = (0.35, 1.5)
# Every step of one line repeats the same period; a stray run of short marks
# (staccato dots, the letters of a word) does not.
PERIOD_TOLERANCE = 0.35
MIN_DASHES = 3
# The shortest real line, "- - -" over a single beat, is about 3 long; the
# strokes of a clef or brace can line up as three short marks in half that.
MIN_LINE_LENGTH = 2.5
MAX_LINE_THICKNESS = 0.45
# A crossing stem or notehead cuts a line in two; pieces this close together at
# the same height are one line.
MAX_LINE_BREAK = 3.0
# Farthest from its staff an octave line is drawn, and how much nearer to its
# own staff than to any other it must be to belong to it.
MAX_STAFF_DISTANCE = 8.0
MIN_STAFF_MARGIN = 1.0
# Where the "8" of an 8va/8vb label is looked for: left of the line's first
# dash, the digit's height spanning the line.
LABEL_REACH = 5.0
DIGIT_HEIGHT = (0.8, 2.2)
DIGIT_WIDTH = (0.35, 1.6)
# Breaks sealed before counting the digit's loops: the hairlines of an italic
# "8" come out of binarization with 1-4px gaps in them at 300 DPI. Its loops
# are about half an interline across, so they stay well clear of the minimum.
LABEL_SEAL = 0.08
LABEL_MIN_LOOP = 0.04
# A letter after the "8" this tall, relative to the digit, has an ascender:
# the "b" of "8vb". The "v" and "a" of "8va" measured 0.45-0.5.
LETTER_ASCENDER = 0.75
# A line that runs on to the next system ends this close to its staff's right
# edge, and its continuation starts this soon after the clef and key.
OPEN_END = 3.0
CONTINUATION_START = 2.5

_INK_RUN = re.compile(rb"\x00+")
_TO_INK = bytes(0 if v < 128 else 255 for v in range(256))
_BIT_CHARS = bytes(ord("1") if v == 0 else ord("0") for v in range(256))


class _Bitmap:
    """A black-and-white page picture: one byte per pixel, 0 for ink."""

    def __init__(self, width, height, samples):
        self.width, self.height = width, height
        self.samples = bytes(samples).translate(_TO_INK)

    @classmethod
    def from_png(cls, png):
        pix = pymupdf.Pixmap(png)
        if pix.alpha:
            pix = pymupdf.Pixmap(pix, 0)
        if pix.n != 1:
            pix = pymupdf.Pixmap(pymupdf.csGRAY, pix)
        return cls(pix.width, pix.height, pix.samples)

    def ink(self, x, y):
        return (0 <= x < self.width and 0 <= y < self.height
                and self.samples[y * self.width + x] == 0)

    def runs(self, y, left, right):
        """(start, end) of every ink run on row y between left and right."""
        left, right = max(0, int(left)), min(self.width, int(right))
        row = self.samples[y * self.width + left:y * self.width + right]
        return [(m.start() + left, m.end() + left) for m in _INK_RUN.finditer(row)]


def _row_dashes(runs, interline):
    """Chains of regularly spaced dashes on one row, as (x0, x1)."""
    shortest, longest = (v * interline for v in DASH_LENGTH)
    closest, farthest = (v * interline for v in DASH_GAP)
    chains, chain = [], []

    def close():
        if len(chain) >= MIN_DASHES:
            chains.append((chain[0][0], chain[-1][1]))

    for start, end in runs:
        if not shortest <= end - start <= longest:
            close()
            chain = []
            continue
        if chain:
            fits = closest <= start - chain[-1][1] <= farthest
            if fits and len(chain) >= 2:
                period = (chain[-1][0] - chain[0][0]) / (len(chain) - 1)
                fits = abs(start - chain[-1][0] - period) <= PERIOD_TOLERANCE * period
            if not fits:
                close()
                chain = []
        chain.append((start, end))
    close()
    return chains


def _dashed_lines(bitmap, top, bottom, left, right, interline):
    """Horizontal dashed lines between rows top and bottom, as dicts with
    x0, x1, y0, y1 (y1 inclusive)."""
    pieces = []
    for y in range(max(0, int(top)), min(bitmap.height, int(bottom))):
        for x0, x1 in _row_dashes(bitmap.runs(y, left, right), interline):
            for piece in pieces:
                # The same line seen on the next row down: a line is a few
                # pixels thick, and every row through it reads the same dashes.
                overlap = min(x1, piece["x1"]) - max(x0, piece["x0"])
                if y - piece["y1"] <= 2 and overlap > .5 * min(x1 - x0, piece["x1"] - piece["x0"]):
                    piece.update(x0=min(x0, piece["x0"]), x1=max(x1, piece["x1"]), y1=y)
                    break
            else:
                pieces.append({"x0": x0, "x1": x1, "y0": y, "y1": y})
    pieces = [p for p in pieces if p["y1"] - p["y0"] + 1 <= MAX_LINE_THICKNESS * interline]
    lines = []
    for piece in sorted(pieces, key=lambda p: p["x0"]):
        middle = (piece["y0"] + piece["y1"]) / 2
        for line in lines:
            if (abs((line["y0"] + line["y1"]) / 2 - middle) <= .25 * interline
                    and 0 <= piece["x0"] - line["x1"] <= MAX_LINE_BREAK * interline):
                line.update(x1=max(line["x1"], piece["x1"]), y0=min(line["y0"], piece["y0"]),
                            y1=max(line["y1"], piece["y1"]))
                break
        else:
            lines.append(dict(piece))
    return [line for line in lines if line["x1"] - line["x0"] >= MIN_LINE_LENGTH * interline]


def _dilate(rows, width, radius):
    """Grow ink by ``radius`` pixels. Each row is an int, bit i = pixel i."""
    mask = (1 << width) - 1
    wide = []
    for bits in rows:
        grown = bits
        for step in range(1, radius + 1):
            grown |= (bits << step) | (bits >> step)
        wide.append(grown & mask)
    return [_or(wide[max(0, y - radius):y + radius + 1]) for y in range(len(rows))]


def _or(rows):
    result = 0
    for bits in rows:
        result |= bits
    return result


def _pixels(rows, left, top):
    found = set()
    for y, bits in enumerate(rows):
        while bits:
            low = bits & -bits
            found.add((left + low.bit_length() - 1, top + y))
            bits ^= low
    return found


def _thickened(component, radius):
    """A component grown by ``radius`` pixels all round.

    A hairline stroke of a scanned glyph often comes out of binarization with
    a gap in it, opening a loop that is closed on the page; thickening seals
    any gap up to twice the radius, while the glyph's real loops, several
    times wider, stay open inside. Growing the glyph on its own, never the
    window around it, keeps it from fusing with the letters beside it.
    """
    xs = [x for x, _ in component]
    ys = [y for _, y in component]
    left, top = min(xs) - radius, min(ys) - radius
    width, height = max(xs) + radius + 1 - left, max(ys) + radius + 1 - top
    rows = [0] * height
    for x, y in component:
        rows[y - top] |= 1 << (x - left)
    return _pixels(_dilate(rows, width, radius), left, top)


def _components(bitmap, left, top, right, bottom):
    """Ink components inside a window, each a set of (x, y) pixels."""
    left, top = max(0, int(left)), max(0, int(top))
    right, bottom = min(bitmap.width, int(right)), min(bitmap.height, int(bottom))
    if right <= left or bottom <= top:
        return []
    rows = []
    for y in range(top, bottom):
        row = bitmap.samples[y * bitmap.width + left:y * bitmap.width + right]
        rows.append(int(row.translate(_BIT_CHARS)[::-1].decode(), 2))
    pixels = _pixels(rows, left, top)
    found = []
    while pixels:
        start = pixels.pop()
        component, stack = {start}, [start]
        while stack:
            x, y = stack.pop()
            for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if n in pixels:
                    pixels.discard(n)
                    component.add(n)
                    stack.append(n)
        found.append(component)
    return found


def _glyphs(components):
    """Components grouped into glyphs: pieces whose bounding boxes overlap.

    A glyph whose hairlines broke in two places comes out of binarization as
    two components, one lying largely inside the other's box. The next letter
    along, however close, sits beside it rather than within it.
    """
    boxes = []
    for component in components:
        xs = [x for x, _ in component]
        ys = [y for _, y in component]
        boxes.append([min(xs), min(ys), max(xs), max(ys), set(component)])
    merged = True
    while merged:
        merged = False
        for i, a in enumerate(boxes):
            for b in boxes[i + 1:]:
                if a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]:
                    a[:4] = min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])
                    a[4] |= b[4]
                    boxes.remove(b)
                    merged = True
                    break
            if merged:
                break
    return [box[4] for box in boxes]


def _holes(component, min_area=3):
    """Enclosed background regions of a component - two for an "8" - of at
    least ``min_area`` pixels."""
    xs = [x for x, _ in component]
    ys = [y for _, y in component]
    left, right, top, bottom = min(xs) - 1, max(xs) + 1, min(ys) - 1, max(ys) + 1
    outside, stack = {(left, top)}, [(left, top)]
    while stack:
        x, y = stack.pop()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if (left <= nx <= right and top <= ny <= bottom
                    and (nx, ny) not in outside and (nx, ny) not in component):
                outside.add((nx, ny))
                stack.append((nx, ny))
    inside = ({(x, y) for x in range(left, right + 1) for y in range(top, bottom + 1)}
              - outside - component)
    holes = 0
    while inside:
        stack, size = [inside.pop()], 1
        while stack:
            x, y = stack.pop()
            for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if n in inside:
                    inside.discard(n)
                    stack.append(n)
                    size += 1
        # A pinhole left by binarization is not a loop of the glyph.
        holes += size >= min_area
    return holes


def _box(component):
    xs = [x for x, _ in component]
    ys = [y for _, y in component]
    return min(xs), min(ys), max(xs), max(ys)


def _octave_label(bitmap, line, interline):
    """The "8" labelling a dashed line, as (left edge, direction), or None.

    The digit is the one thing an 8va or 8vb label is sure to contain, and a
    closed double loop sits next to a dashed line for no other reason - "rit.",
    "cresc." and "accel." lines have none. So an unlabelled line, or one
    labelled with words, is never read as an octave shift.

    Direction is +1 for "8va", -1 for "8vb" or "8va bassa", None for a bare
    "8" that leaves it to the line's placement. The letters are told apart by
    height alone: "va" is all x-height, while the "b" of "vb" and "bassa"
    rises to the digit's own height.
    """
    middle = (line["y0"] + line["y1"]) / 2
    # Engravers set the label with the line level with its top, its middle or
    # its baseline, so the window reaches a full label height either way.
    window = (line["x0"] - LABEL_REACH * interline, middle - 2.5 * interline,
              line["x0"] + .3 * interline, middle + 2.5 * interline)
    radius = max(1, round(LABEL_SEAL * interline))
    min_loop = LABEL_MIN_LOOP * interline ** 2
    glyphs = [(_box(glyph), glyph) for glyph in _glyphs(_components(bitmap, *window))]
    for (left, top, right, bottom), glyph in glyphs:
        width, height = right - left + 1, bottom - top + 1
        if not (DIGIT_HEIGHT[0] * interline <= height <= DIGIT_HEIGHT[1] * interline
                and DIGIT_WIDTH[0] * interline <= width <= DIGIT_WIDTH[1] * interline
                and top - interline <= middle <= bottom + interline):
            continue
        if _holes(_thickened(glyph, radius), min_loop) != 2:
            continue
        letters = [box for box, _ in glyphs
                   if right - 1 <= box[0] <= right + 1.5 * interline and box[2] < line["x0"] - 1
                   and top <= (box[1] + box[3]) / 2 <= bottom
                   and box[3] - box[1] + 1 >= .25 * height]
        if not letters:
            return left, None
        tall = any(box[3] - box[1] + 1 >= LETTER_ASCENDER * height for box in letters)
        return left, -1 if tall else 1
    return None


def _interline(ys):
    return median(b - a for a, b in zip(ys, ys[1:]))


def find_ottavas(bitmap, staves, systems, carried=None):
    """Octave lines on one page, as {staff: [(x0, x1, octaves)]} in pixels.

    ``staves`` maps each staff id to (its five line ys, (left, right,
    header_stop)); ``systems`` lists staff ids per system, top to bottom.

    Only lines outside a system are read: above its top staff, raising that
    staff (8va), or below its bottom staff, lowering it (8vb). A line between
    two staves of one system could belong to either and is left alone.

    A line between two systems lies above one and below the other, and which
    one it shifts is the label's call when the label says: an "8va" line
    raises the staff under it however close it sits to the staff over it,
    which it often does when the notes it covers climb high. Only a bare "8"
    falls back to whichever staff is clearly nearer.

    A line starts an octave shift only where an "8" labels it (see
    _octave_label). A line carried on from the previous system has no label,
    only dashes starting straight after the clef and key, and counts only when
    the previous system's line of the same kind ran to its right edge.
    ``carried`` is that state coming in - {"above": octaves, "below": octaves}
    - and the same state going out is returned with the intervals, so a line
    can run on across a page turn too.
    """
    carried = dict(carried or {})
    systems = [system for system in ([sid for sid in s if sid in staves] for s in systems) if system]
    # Gap k runs from system k-1's bottom staff (or the top of the page) down
    # to system k's top staff (or the bottom of the page). Labelled lines are
    # assigned to a staff here; unlabelled ones wait to be claimed as the
    # continuation of a line carried over from the system before.
    labelled, loose = {}, {}
    for k in range(len(systems) + 1):
        upper = staves[systems[k - 1][-1]][0] if k else None
        lower = staves[systems[k][0]][0] if k < len(systems) else None
        interline = _interline(lower or upper)
        reach = MAX_STAFF_DISTANCE * interline
        top = upper[-1] + .5 * interline if upper else lower[0] - reach
        bottom = lower[0] - .5 * interline if lower else upper[-1] + reach
        extents = [staves[sid][1] for system in systems[max(0, k - 1):k + 1] for sid in system]
        left = min(e[0] for e in extents) - 2 * interline
        right = max(e[1] for e in extents) + 2 * interline
        for line in _dashed_lines(bitmap, top, bottom, left, right, interline):
            middle = (line["y0"] + line["y1"]) / 2
            below_upper = middle - upper[-1] if upper else float("inf")
            above_lower = lower[0] - middle if lower else float("inf")
            if min(below_upper, above_lower) > reach:
                continue
            label = _octave_label(bitmap, line, interline)
            if label is None:
                loose.setdefault(k, []).append(line)
                continue
            start, direction = label
            if direction is None:
                if abs(below_upper - above_lower) < MIN_STAFF_MARGIN * interline:
                    continue  # a bare "8" midway between two staves: whose is unclear
                direction = 1 if above_lower < below_upper else -1
            if direction > 0 and above_lower <= reach:
                labelled.setdefault(("above", k), []).append((line, start))
            elif direction < 0 and below_upper <= reach:
                labelled.setdefault(("below", k - 1), []).append((line, start))

    intervals, claimed = {}, set()
    for index, system in enumerate(systems):
        found = {}
        for role, sid, gap in (("above", system[0], index), ("below", system[-1], index + 1)):
            ys, (left, right, header) = staves[sid]
            interline = _interline(ys)
            sign = 1 if role == "above" else -1
            candidates = [(line, start - .3 * interline, sign)
                          for line, start in labelled.get((role, index), [])]
            if carried.get(role):
                limit = ((header if header is not None else left + 10 * interline)
                         + CONTINUATION_START * interline)
                for line in loose.get(gap, []):
                    middle = (line["y0"] + line["y1"]) / 2
                    distance = ys[0] - middle if role == "above" else middle - ys[-1]
                    if (id(line) not in claimed and line["x0"] <= limit
                            and distance <= MAX_STAFF_DISTANCE * interline):
                        candidates.append((line, None, carried[role]))
            accepted, open_amount = [], None
            for line, start, amount in sorted(candidates, key=lambda c: c[0]["x0"]):
                if start is None:
                    if accepted:
                        continue  # only the first line of a system continues one
                    claimed.add(id(line))
                    start = left
                accepted.append((start, line["x1"] + .5 * interline, amount))
                open_amount = amount if line["x1"] >= right - OPEN_END * interline else None
            found[role] = open_amount
            if accepted:
                intervals.setdefault(sid, []).extend(accepted)
        carried = found
    return intervals, carried


def ottava_intervals(omr_path, sheet, carried=None):
    """find_ottavas() for one sheet of an Audiveris book, read from the book's
    own binarized picture and staff geometry."""
    png = load_binary_image(omr_path, sheet)
    if png is None:
        return {}, {}
    lines, extents = load_staff_lines(omr_path, sheet), load_staff_extents(omr_path, sheet)
    staves = {sid: (ys, extents[sid]) for sid, ys in lines.items() if sid in extents}
    return find_ottavas(_Bitmap.from_png(png), staves,
                        load_system_staff_groups(omr_path, sheet), carried)
