"""Printed notes left without a name: found from the engraving's own glyphs."""
import unittest

import page_size
from label_export import labels_document
from unnamed_notes import printed_heads, unnamed_heads


def char(c, x0, x1, baseline):
    return {"c": c, "bbox": (x0, baseline - 8, x1, baseline + 2), "origin": (x0, baseline)}


class FakePage:
    def __init__(self, chars):
        self.chars = chars

    def get_text(self, kind):
        assert kind == "rawdict"
        return {"blocks": [{"lines": [{"spans": [{"chars": self.chars}]}]}]}


class PrintedHeadTests(unittest.TestCase):
    def test_reads_smufl_noteheads_centred_on_their_baseline(self):
        page = FakePage([char("", 100, 106, 50), char("", 200, 209, 62), char("A", 300, 305, 50)])
        self.assertEqual(printed_heads(page), [(103.0, 50, 6), (204.5, 62, 9)])

    def test_an_overprinted_head_counts_once(self):
        page = FakePage([char("", 100, 106, 50), char("", 100.1, 106.1, 50.2)])
        self.assertEqual(len(printed_heads(page)), 1)

    def test_a_scan_has_none(self):
        self.assertEqual(printed_heads(FakePage([])), [])


class UnnamedHeadTests(unittest.TestCase):
    def test_only_heads_no_recognized_note_covers(self):
        heads = {1: [(103, 50, 6), (153, 44, 6), (203, 38, 6)], 2: [(103, 50, 6)]}
        resolved = [
            {"page": 1, "bbox_pt": [100, 47, 106, 53]},
            # A repeated chord is recognized but deliberately left unnamed:
            # still covered, so not reported.
            {"page": 1, "bbox_pt": [200.5, 35.5, 206.5, 41.5]},
            {"page": 1, "bbox_pt": None},
        ]
        self.assertEqual(unnamed_heads(heads, resolved),
                         [{"page": 1, "x": 153, "y": 44, "w": 6}, {"page": 2, "x": 103, "y": 50, "w": 6}])

    def test_a_box_read_slightly_off_still_covers_its_head(self):
        self.assertEqual(unnamed_heads({1: [(107, 50, 6)]}, [{"page": 1, "bbox_pt": [100, 47, 106, 53]}]), [])
        self.assertEqual(len(unnamed_heads({1: [(108, 50, 6)]}, [{"page": 1, "bbox_pt": [100, 47, 106, 53]}])), 1)


class DocumentTests(unittest.TestCase):
    def test_labels_json_carries_them(self):
        unnamed = [{"page": 1, "x": 153, "y": 44, "w": 6}]
        self.assertEqual(labels_document([], None, unnamed=unnamed)["unnamed"], unnamed)
        self.assertEqual(labels_document([], None)["unnamed"], [])

    def test_restored_to_the_upload_points_of_an_oversized_page(self):
        document = {"items": [], "unnamed": [{"page": 1, "x": 100, "y": 50, "w": 6}]}
        restored = page_size.restore_labels(document, [0.2])
        self.assertEqual(restored["unnamed"], [{"page": 1, "x": 500, "y": 250, "w": 30}])
        self.assertEqual(document["unnamed"][0]["x"], 100)  # a copy, not the original


if __name__ == "__main__":
    unittest.main()
