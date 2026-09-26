"""Place note names close to their notes without covering score symbols."""
from array import array
from bisect import bisect_left, bisect_right
from math import ceil, floor
import warnings

import pymupdf as fitz

# How far sideways a label may be nudged, and in what steps, while hunting for
# clear space. The reach is set per record from the label's own width, so a
# label never ends up further from its notehead than its own footprint.
SIDE_STEP = 1.5
# A label further from its noteheads than this is no longer readably attached
# to them, whatever empty space lies beyond.
MAX_DISTANCE = 60


class PageInk:
    """Summed-area ink map for constant-time checks against the printed score."""

    def __init__(self, page):
        self.rect = page.rect
        self.scale = 2
        pix = page.get_pixmap(
            matrix=fitz.Matrix(self.scale, self.scale),
            colorspace=fitz.csGRAY,
            alpha=False,
        )
        self.width, self.height = pix.width, pix.height
        stride = self.width + 1
        sums = array('I', [0]) * (stride * (self.height + 1))
        pixels = pix.samples
        for y in range(self.height):
            total = 0
            row, previous = (y + 1) * stride, y * stride
            for x in range(self.width):
                total += pixels[y * pix.stride + x] < 220
                sums[row + x + 1] = sums[previous + x + 1] + total
        self.sums = sums

    def _count(self, box):
        x0, y0 = floor(box.x0 * self.scale), floor(box.y0 * self.scale)
        x1, y1 = ceil(box.x1 * self.scale), ceil(box.y1 * self.scale)
        if x0 < 0 or y0 < 0 or x1 > self.width or y1 > self.height:
            return float('inf')
        stride, sums = self.width + 1, self.sums
        return (sums[y1 * stride + x1] - sums[y0 * stride + x1]
                - sums[y1 * stride + x0] + sums[y0 * stride + x0])

    def count(self, box, ignored_staff_lines=()):
        """Count printed ink, excluding thin staff lines inside ``box``.

        Labels may cross the five staff lines. Noteheads are protected
        separately using their exact OMR/PDF boxes, so ignoring these narrow
        horizontal bands does not make a note safe to cover.

        ``ignored_staff_lines`` must be sorted: only the lines that fall inside
        ``box`` are looked at, which matters because every candidate placement
        is scored against a page's worth of staff lines.
        """
        total = self._count(box)
        if total == float('inf'):
            return total
        first = bisect_left(ignored_staff_lines, box.y0 - .75)
        last = bisect_right(ignored_staff_lines, box.y1 + .75)
        for y in ignored_staff_lines[first:last]:
            strip = fitz.Rect(
                box.x0, max(box.y0, y - .75),
                box.x1, min(box.y1, y + .75),
            )
            if strip.y1 > strip.y0:
                total -= self._count(strip)
        return max(0, total)


def label_boxes(block, _font=None):
    """Visible label footprints, including a small white-halo clearance."""
    fs = block['fs']
    return [fitz.Rect(
        block['x'] + offset - width / 2 - .5,
        y - fs * .84 - .5,
        block['x'] + offset + width / 2 + .5,
        y + fs * .12 + .5,
    ) for y, offset, width in zip(
        block['ys'], block['label_x_offsets'], block['widths'])]


def layout_page_records(page_records, font_size, measure_font, margin_pt, page):
    """Lay out single notes close by and chords as compact vertical stacks.

    Chords first try the right side of their noteheads. If that space is
    occupied, the label sweeps outward from the heads - up, down and sideways -
    and settles wherever the total of printed ink underneath plus distance
    travelled is smallest. Scoring the two together keeps a name beside the note
    it belongs to: crossing a dashed octave line costs less than escaping to the
    first perfectly clear space far above the system. Single notes prefer above
    for treble and below for bass. Staff lines are allowed under labels;
    noteheads, signatures, octave marks, dynamics and other printed symbols
    remain obstacles.
    """
    ink = PageInk(page)
    occupied = {}
    all_staff_lines = sorted({
        round(y, 2) for rec in page_records
        for y in rec.get('staff_lines_pt', ())
    })

    def cells(box):
        return ((x, y)
                for x in range(floor(box.x0 / 32), floor(box.x1 / 32) + 1)
                for y in range(floor(box.y0 / 32), floor(box.y1 / 32) + 1))

    # Noteheads are bucketed like the labels already placed: the sweep below
    # tests far more candidates than a linear scan of the page can absorb.
    note_cells = {}
    for rec in page_records:
        for box in rec.get('note_boxes_pt', ()):
            note = fitz.Rect(box) + (-.6, -.6, .6, .6)
            for cell in cells(note):
                note_cells.setdefault(cell, []).append(note)

    def assess(block):
        boxes = label_boxes(block)
        if any(box.x0 < 12 or box.x1 > page.rect.width - 12 or
               box.y0 < 12 or box.y1 > page.rect.height - 12
               for box in boxes):
            return None
        for box in boxes:
            for cell in cells(box):
                for other in note_cells.get(cell, ()):
                    if box.intersects(other):
                        return None
                for old in occupied.get(cell, ()):
                    if box.intersects(old):
                        return None
        return sum(ink.count(box, all_staff_lines) for box in boxes)

    def block_at(rec, x, ys, fs, widths):
        return {
            'x': x, 'labels': rec['labels'], 'widths': widths, 'fs': fs,
            'ys': ys, 'label_x_offsets': [0.] * len(widths),
            # Aligned with 'labels': the notehead each line names. Carried
            # through so the placed labels can be exported and tied back to
            # the playback timeline's notes (see label_export.py).
            'note_boxes': rec.get('note_boxes_pt', []),
        }

    def neighbourhood(rec, fs, widths, line_h):
        """(cost, block) pairs, nearest first.

        Each step outward is offered above, below and to either side before the
        sweep moves further away, so a label boxed in vertically - an octave
        line overhead, the next staff underneath - slides into the white space
        beside its chord instead of climbing over the octave line.
        """
        count = len(widths)
        above_base = (rec['top_y_pt'] - margin_pt - fs * .12 - .5
                      - (count - 1) * line_h)
        below_base = rec['bottom_y_pt'] + margin_pt + fs * .84 + .5
        preferred_above = rec['part'] == 0
        reach = max(widths) + rec.get('notehead_w_pt', 0) / 2
        shifts = [step * SIDE_STEP * sign
                  for step in range(int(reach / SIDE_STEP) + 1)
                  for sign in ((-1, 1) if step else (1,))]
        plan = sorted(
            (distance + abs(shift), above is not preferred_above,
             distance, shift, above)
            for distance in range(0, MAX_DISTANCE + 1, 2)
            for above in (True, False)
            for shift in shifts)
        for cost, _, distance, shift, above in plan:
            base = above_base - distance if above else below_base + distance
            yield cost, block_at(
                rec,
                rec['anchor_x_pt'] + shift,
                [base + i * line_h for i in range(count)],
                fs,
                widths,
            )

    placed = []
    # Keep reading order stable. Dense repeated chords have already been
    # reduced to their first occurrence by records_from_resolved().
    for rec in sorted(page_records, key=lambda r: (
            r['system'], r['anchor_x_pt'], r['part'])):
        fs = font_size * rec.get('scale', 1)
        widths = [
            measure_font.text_length(label, fontsize=fs)
            for label in rec['labels']
        ]
        line_h = fs * .92
        best, best_ink, best_score = None, 0, float('inf')

        # Chord labels are always vertical. Use the right side when it is
        # actually clear, including when that means crossing staff lines.
        if len(widths) > 1:
            right_edge = max(
                (box[2] for box in rec.get('note_boxes_pt', ())),
                default=rec['anchor_x_pt'] + rec.get('notehead_w_pt', 0) / 2,
            )
            x = right_edge + 1.5 + max(widths) / 2
            center = (rec['top_y_pt'] + rec['bottom_y_pt']) / 2
            base = center - (len(widths) - 1) * line_h / 2 + fs * .36
            for offset in (0, -1, 1, -2, 2, -3, 3):
                candidate = block_at(
                    rec,
                    x,
                    [base + offset + i * line_h for i in range(len(widths))],
                    fs,
                    widths,
                )
                score = assess(candidate)
                if score is not None and score < best_score:
                    best, best_ink, best_score = candidate, score, score
                if score == 0:
                    break

        # A blocked chord, or any single note, sweeps its neighbourhood. Costs
        # only ever grow along the sweep, and a block's score is at least its
        # cost, so the first clear spot wins outright and anything costing more
        # than the best score so far cannot beat it.
        if best_score:
            for cost, candidate in neighbourhood(rec, fs, widths, line_h):
                if cost >= best_score:
                    break
                score = assess(candidate)
                if score is not None and score + cost < best_score:
                    best, best_ink, best_score = candidate, score, score + cost
                if score == 0:
                    break

        if best is None:
            raise ValueError(
                f"No label placement fits on page {rec['page']}, "
                f"measure {rec.get('measure')}, x={rec['anchor_x_pt']:.1f}")
        if best_ink:
            warnings.warn(
                f"No completely clear label space on page {rec['page']}, "
                f"measure {rec.get('measure')}, x={rec['anchor_x_pt']:.1f}")
        placed.append(best)
        for box in label_boxes(best):
            for cell in cells(box):
                occupied.setdefault(cell, []).append(box)
    return placed
