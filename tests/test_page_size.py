"""Oversized pages: shrunk for recognition, and everything restored afterwards.

Pages are drawn by hand here - no OMR engine required.
"""
import tempfile
import unittest
from pathlib import Path

import pymupdf

import page_size
import run

A4 = (595, 842)
FIVE_A4 = (2976, 4209)  # the upload this exists for: exactly five times A4


def ink_box(page, dpi):
    """Where the page's ink is, as fractions of the rendered page."""
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
    xs, ys = [], []
    for y in range(pix.height):
        row = pix.samples[y * pix.stride:y * pix.stride + pix.width]
        for x in range(pix.width):
            if row[x] < 128:
                xs.append(x)
                ys.append(y)
    return (min(xs) / pix.width, min(ys) / pix.height, max(xs) / pix.width, max(ys) / pix.height)


class PageSizeTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def save(self, doc, name="input.pdf"):
        path = self.dir / name
        doc.save(path)
        return path

    def oversized(self):
        doc = pymupdf.open()
        page = doc.new_page(width=FIVE_A4[0], height=FIVE_A4[1])
        page.draw_rect(pymupdf.Rect(300, 500, 2500, 700), fill=(0, 0, 0))
        page.insert_text((300, 400), "Allegro", fontsize=60)
        return doc

    def test_ordinary_pages_are_left_alone(self):
        doc = pymupdf.open()
        doc.new_page(width=A4[0], height=A4[1])
        doc.new_page(width=842, height=1191)  # A3
        path = self.save(doc)
        self.assertEqual(page_size.shrink_oversized(path, self.dir / "out"), (path, None))
        self.assertFalse((self.dir / "out").exists())

    def test_an_oversized_page_is_read_at_a4_size(self):
        doc = self.oversized()
        doc.new_page(width=A4[0], height=A4[1])
        path, scales = page_size.shrink_oversized(self.save(doc), self.dir / "out")
        self.assertEqual(path.name, "input.pdf")  # Audiveris names its output after it
        self.assertAlmostEqual(scales[0], 0.2, places=3)
        self.assertEqual(scales[1], 1)
        with pymupdf.open(path) as shrunk:
            first = shrunk[0]
            self.assertAlmostEqual(first.rect.width, A4[0], delta=1)
            self.assertAlmostEqual(first.rect.height, A4[1], delta=1)
            rect = first.get_drawings()[0]["rect"]
            self.assertAlmostEqual(rect.x0, 300 * scales[0], delta=0.5)
            self.assertAlmostEqual(rect.y0, 500 * scales[0], delta=0.5)
            self.assertEqual([w[4] for w in first.get_text("words")], ["Allegro"])
            self.assertEqual(shrunk[1].rect, pymupdf.Rect(0, 0, *A4))

    def test_a_rotated_page_keeps_its_rotation(self):
        doc = pymupdf.open()
        page = doc.new_page(width=FIVE_A4[1], height=FIVE_A4[0])
        page.draw_rect(pymupdf.Rect(100, 100, 1500, 400), fill=(0, 0, 0))
        page.set_rotation(90)
        before = ink_box(page, 8)
        path, _ = page_size.shrink_oversized(self.save(doc), self.dir / "out")
        with pymupdf.open(path) as shrunk:
            self.assertEqual(shrunk[0].rotation, 90)
            for got, want in zip(ink_box(shrunk[0], 40), before):
                self.assertAlmostEqual(got, want, delta=0.01)

    def test_the_result_is_restored_to_the_upload_size(self):
        upload = self.save(self.oversized())
        path, scales = page_size.shrink_oversized(upload, self.dir / "out")
        # A label drawn on the shrunk page, as annotate.render() would.
        with pymupdf.open(path) as doc:
            doc[0].insert_text((100, 200), "C", fontsize=6.5)
            output = self.dir / "annotated.pdf"
            doc.save(output)
        page_size.restore_pdf(output, upload, scales)
        with pymupdf.open(output) as doc, pymupdf.open(upload) as original:
            page = doc[0]
            self.assertEqual(page.mediabox, original[0].mediabox)
            words = {w[4]: w for w in page.get_text("words")}
            self.assertAlmostEqual(words["C"][0], 100 / scales[0], delta=1)
            # Its box reaches below the baseline by the font's descent - at the
            # restored size, five times 6.5pt's.
            self.assertTrue(200 / scales[0] < words["C"][3] < 200 / scales[0] + 6.5 / scales[0] / 2)
            self.assertAlmostEqual(words["C"][3] - words["C"][1], 6.5 / scales[0] * 1.2, delta=6.5)
            rect = page.get_drawings()[0]["rect"]
            self.assertAlmostEqual(rect.x0, 300, delta=0.5)
            self.assertAlmostEqual(rect.y1, 700, delta=0.5)
            self.assertAlmostEqual(words["Allegro"][0], original[0].get_text("words")[0][0], delta=0.5)

    def test_timeline_and_labels_are_given_in_upload_points(self):
        scales = [0.2, 1.0]
        timeline = {
            "measures": [{"index": 0, "page": 1, "bbox_pt": [10, 20, 30, 40]},
                         {"index": 1, "page": 2, "bbox_pt": [10, 20, 30, 40]}],
            "notes": [{"measure_index": 0, "bbox_pt": [1, 2, 3, 4]},
                      {"measure_index": 1, "bbox_pt": [1, 2, 3, 4]},
                      {"measure_index": 0, "bbox_pt": None}],
        }
        restored = page_size.restore_timeline(timeline, scales)
        self.assertEqual(restored["measures"][0]["bbox_pt"], [50, 100, 150, 200])
        self.assertEqual(restored["measures"][1]["bbox_pt"], [10, 20, 30, 40])
        self.assertEqual(restored["notes"][0]["bbox_pt"], [5, 10, 15, 20])
        self.assertEqual(restored["notes"][1]["bbox_pt"], [1, 2, 3, 4])
        self.assertIsNone(restored["notes"][2]["bbox_pt"])
        self.assertEqual(timeline["measures"][0]["bbox_pt"], [10, 20, 30, 40])  # a copy

        labels = {"font_size": 6.5, "items": [{"page": 1, "x": 10, "y": 20, "size": 6.5},
                                              {"page": 2, "x": 10, "y": 20, "size": 6.5}]}
        restored = page_size.restore_labels(labels, scales)
        self.assertEqual([(i["x"], i["y"], i["size"]) for i in restored["items"]],
                         [(50, 100, 32.5), (10, 20, 6.5)])

    def test_the_time_estimate_is_for_the_page_actually_read(self):
        big = self.save(self.oversized(), "big.pdf")
        doc = pymupdf.open()
        doc.new_page(width=A4[0], height=A4[1])
        normal = self.save(doc, "normal.pdf")
        self.assertAlmostEqual(run.page_megapixels(big)[0], run.page_megapixels(normal)[0], delta=0.1)


if __name__ == "__main__":
    unittest.main()
