"""Labels must avoid printed notation, including unrecognized/scanned marks."""
import unittest
import warnings

import pymupdf as fitz

from label_layout import PageInk, label_boxes, layout_page_records


def chord(x=140, part=0, labels=None):
    labels = labels or ['F', 'D', 'B', 'G']
    centers = [122 + (i - (len(labels) - 1) / 2) * 6 for i in range(len(labels))]
    return dict(page=1, system=0, part=part, anchor_x_pt=x,
                top_y_pt=min(centers), bottom_y_pt=max(centers), labels=labels,
                staff_top_pt=110, staff_bottom_pt=134, space_top_pt=20,
                space_bottom_pt=210, measure=39, notehead_w_pt=6,
                staff_lines_pt=[110, 116, 122, 128, 134],
                note_boxes_pt=[(x - 3, y - 2, x + 3, y + 2) for y in centers])


class LabelLayoutTests(unittest.TestCase):
    def setUp(self):
        self.doc = fitz.open()
        self.addCleanup(self.doc.close)
        self.page = self.doc.new_page(width=320, height=250)
        self.font = fitz.Font('helv')
        for y in range(110, 135, 6):
            self.page.draw_line((35, y), (285, y), width=.5)
        for x in (140, 158):
            for y in (113, 119, 125, 131):
                self.page.draw_oval(fitz.Rect(x - 3, y - 2, x + 3, y + 2), fill=(0, 0, 0))
            self.page.draw_line((x + 3, 95), (x + 3, 130))
        # An octave mark and a line occupy the seemingly empty upper margin.
        self.page.insert_text((125, 70), '8va', fontsize=10)
        self.page.draw_line((145, 66), (195, 66), dashes='[3 2] 0')
    def layout(self, records):
        with warnings.catch_warnings():
            warnings.simplefilter('error')
            blocks = layout_page_records(records, 6.5, self.font, 3.2, self.page)
        self.assertEqual(len(blocks), len(records))
        ink = PageInk(self.page)
        footprints = []
        for block in blocks:
            boxes = label_boxes(block, self.font)
            self.assertTrue(all(ink.count(box, [110, 116, 122, 128, 134]) == 0 for box in boxes))
            self.assertFalse(any(box.intersects(old) for box in boxes for old in footprints))
            footprints.extend(boxes)
        return blocks

    def test_four_note_chords_use_compact_vertical_space_on_the_right(self):
        blocks = self.layout([chord(), chord(158)])
        self.assertEqual(sum(len(b['labels']) for b in blocks), 8)
        for block in blocks:
            self.assertTrue(all(offset == 0 for offset in block['label_x_offsets']))
            self.assertLess(max(b - a for a, b in zip(block['ys'], block['ys'][1:])), block['fs'])
        self.assertGreater(blocks[0]['x'], 140)
        self.assertGreater(blocks[1]['x'], 158)

    def test_scanned_notation_is_an_obstacle_without_any_text_layer(self):
        pix = self.page.get_pixmap(matrix=fitz.Matrix(2, 2))
        self.doc = fitz.open()
        self.addCleanup(self.doc.close)
        self.page = self.doc.new_page(width=320, height=250)
        self.page.insert_image(self.page.rect, pixmap=pix)
        self.assertEqual(self.page.get_text(), '')
        self.layout([chord(), chord(158)])

    def test_bass_chord_uses_clear_right_side_instead_of_dynamics_below(self):
        self.page.insert_text((130, 155), 'mf', fontsize=12)
        blocks = self.layout([chord(part=1)])
        self.assertGreater(blocks[0]['x'], 140)

    def test_chord_falls_back_above_or_below_when_right_side_is_blocked(self):
        self.page.draw_rect(fitz.Rect(143, 100, 170, 145), fill=(0, 0, 0))
        blocks = self.layout([chord()])
        boxes = label_boxes(blocks[0], self.font)
        self.assertTrue(max(box.y1 for box in boxes) < 110 or min(box.y0 for box in boxes) > 134)

    def test_single_note_stays_between_an_octave_line_and_the_staff(self):
        record = chord(180, labels=['B'])
        blocks = self.layout([record])
        box = label_boxes(blocks[0], self.font)[0]
        self.assertGreater(box.y0, 70)
        self.assertLessEqual(box.y1, record['top_y_pt'] - 3)

    def test_neighbor_labels_do_not_drift_onto_the_next_chord(self):
        blocks = self.layout([chord(), chord(158), chord(178, labels=['C'])])
        centers = {tuple(block['labels']): block['x'] for block in blocks}
        self.assertLessEqual(abs(centers[('C',)] - 178), 10)

    def test_no_available_whitespace_does_not_silently_drop_labels(self):
        self.page.draw_rect(self.page.rect, fill=(0, 0, 0))
        with self.assertWarns(UserWarning):
            blocks = layout_page_records([chord()], 6.5, self.font, 3.2, self.page)
        self.assertEqual(blocks[0]['labels'], chord()['labels'])


if __name__ == '__main__':
    unittest.main()
