"""Place note names close to their notes without covering score symbols."""
from array import array
from math import ceil, floor
import warnings

import pymupdf as fitz


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
        """
        total = self._count(box)
        if total == float('inf'):
            return total
        for y in ignored_staff_lines:
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
    occupied, they use the closest clear area above or below. Single notes
    prefer above for treble and below for bass. Staff lines are allowed under
    labels; noteheads, signatures, octave marks, dynamics and other printed
    symbols remain obstacles.
    """
    ink = PageInk(page)
    occupied = {}
    all_staff_lines = sorted({
        round(y, 2) for rec in page_records
        for y in rec.get('staff_lines_pt', ())
    })
    note_boxes = [
        fitz.Rect(box) + (-.6, -.6, .6, .6)
        for rec in page_records for box in rec.get('note_boxes_pt', ())
    ]

    def cells(box):
        return ((x, y)
                for x in range(floor(box.x0 / 32), floor(box.x1 / 32) + 1)
                for y in range(floor(box.y0 / 32), floor(box.y1 / 32) + 1))

    def assess(block):
        boxes = label_boxes(block)
        if any(box.x0 < 12 or box.x1 > page.rect.width - 12 or
               box.y0 < 12 or box.y1 > page.rect.height - 12
               for box in boxes):
            return None
        if any(box.intersects(note) for box in boxes for note in note_boxes):
            return None
        if any(box.intersects(old) for box in boxes for cell in cells(box)
               for old in occupied.get(cell, ())):
            return None
        return sum(ink.count(box, all_staff_lines) for box in boxes)

    def block_at(rec, x, ys, fs, widths):
        return {
            'x': x, 'labels': rec['labels'], 'widths': widths, 'fs': fs,
            'ys': ys, 'label_x_offsets': [0.] * len(widths),
        }

    def vertical_candidates(rec, fs, widths, line_h):
        count = len(widths)
        above_base = (rec['top_y_pt'] - margin_pt - fs * .12 - .5
                      - (count - 1) * line_h)
        below_base = rec['bottom_y_pt'] + margin_pt + fs * .84 + .5
        preferred_above = rec['part'] == 0
        for distance in range(0, 61, 2):
            for above in (preferred_above, not preferred_above):
                base = above_base - distance if above else below_base + distance
                for shift in (0, -1.5, 1.5, -3, 3, -4.5, 4.5, -6, 6):
                    yield block_at(
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
        best, best_ink = None, float('inf')

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
                if score is not None and score < best_ink:
                    best, best_ink = candidate, score
                if score == 0:
                    break

        # A blocked chord, or any single note, uses the closest clear vertical
        # position. Above/below are checked at each distance so an 8va line can
        # send a label into nearby staff space instead of far above the line.
        if best_ink != 0:
            for candidate in vertical_candidates(rec, fs, widths, line_h):
                score = assess(candidate)
                if score is not None and score < best_ink:
                    best, best_ink = candidate, score
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
