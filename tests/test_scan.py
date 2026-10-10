"""Scanned pages: binarizing them for recognition, and reading their 8va lines.

Pages are drawn by hand here - no OMR engine or real scan required.
"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import pymupdf

import run
import scan

IL = 20  # staff interline of the drawn pages, in pixels


class Canvas:
    """A white page to draw black rectangles on."""

    def __init__(self, width=1000, height=700):
        self.width, self.height = width, height
        self.pixels = bytearray(b"\xff" * width * height)

    def fill(self, x0, y0, x1, y1):
        for y in range(y0, y1):
            self.pixels[y * self.width + x0:y * self.width + x1] = b"\x00" * (x1 - x0)

    def ring(self, x0, y0, x1, y1, stroke=3):
        self.fill(x0, y0, x1, y0 + stroke)
        self.fill(x0, y1 - stroke, x1, y1)
        self.fill(x0, y0, x0 + stroke, y1)
        self.fill(x1 - stroke, y0, x1, y1)

    def staff(self, top, left=50, right=950):
        for k in range(5):
            self.fill(left, top + k * IL, right, top + k * IL + 2)
        return tuple(top + k * IL for k in range(5)), (left, right, 120)

    def dashes(self, x0, x1, y, dash=10, period=23):
        for x in range(x0, x1 - dash + 1, period):
            self.fill(x, y, x + dash, y + 3)

    def eight(self, x, y, broken=False):
        """Two stacked loops, 14 wide and 27 tall - a digit "8"."""
        self.ring(x, y, x + 14, y + 15)
        self.ring(x, y + 12, x + 14, y + 27)
        if broken:
            # The hairline top of a scanned italic "8" often loses a pixel or two.
            for row in range(y, y + 3):
                self.pixels[row * self.width + x + 6:row * self.width + x + 8] = b"\xff\xff"
        return x

    def label(self, x, y, letters="va", broken=False):
        """An octave label with its dashed line starting 50px to its right."""
        left = self.eight(x, y, broken)
        if letters:
            self.fill(x + 17, y + 8, x + 23, y + 20)  # "v", x-height
            if letters == "vb":
                self.ring(x + 26, y - 2, x + 36, y + 22, 2)  # "b", with its ascender
            else:
                self.ring(x + 26, y + 8, x + 36, y + 20, 2)  # "a"
        return left, x + 50

    def bitmap(self):
        return scan._Bitmap(self.width, self.height, bytes(self.pixels))


def two_systems():
    """Two piano systems: staves 1-2 at the top, 3-4 lower down."""
    page = Canvas()
    staves = {1: page.staff(100), 2: page.staff(200), 3: page.staff(380), 4: page.staff(480)}
    return page, staves, [[1, 2], [3, 4]]


class OttavaTests(unittest.TestCase):
    def test_labelled_line_raises_its_staff_and_runs_on_into_the_next_system(self):
        page, staves, systems = two_systems()
        left, start = page.label(150, 30)
        page.dashes(start, 940, 30)          # to the right edge: carries on
        page.dashes(130, 500, 320)           # the continuation, after clef and key
        intervals, carried = scan.find_ottavas(page.bitmap(), staves, systems)
        self.assertEqual(set(intervals), {1, 3})
        (x0, x1, amount), = intervals[1]
        self.assertEqual(amount, 1)
        self.assertLess(x0, left)
        self.assertGreaterEqual(x1, 920)
        # From the start of the system to half a space past its last dash (475-485).
        self.assertEqual(intervals[3], [(50, 485 + IL / 2, 1)])
        self.assertIsNone(carried["above"])  # stopped short of the right edge

    def test_line_running_off_the_page_carries_over_to_the_next(self):
        page, staves, systems = two_systems()
        page.dashes(130, 940, 30)            # the first system, carried in from the last page
        page.dashes(130, 940, 320)           # and on through the second
        intervals, carried = scan.find_ottavas(page.bitmap(), staves, systems, {"above": 1})
        self.assertEqual(set(intervals), {1, 3})
        self.assertEqual(carried, {"above": 1, "below": None})
        # The same unlabelled line, with nothing carried in, is not an octave line.
        self.assertEqual(scan.find_ottavas(page.bitmap(), staves, systems)[0], {})

    def test_a_dashed_line_without_an_eight_is_not_an_octave_shift(self):
        page, staves, systems = two_systems()
        page.fill(150, 30, 160, 55)          # "rit." - letters, no double loop
        page.fill(165, 40, 190, 55)
        page.dashes(200, 700, 30)
        self.assertEqual(scan.find_ottavas(page.bitmap(), staves, systems)[0], {})

    def test_an_eight_whose_hairline_broke_is_still_read(self):
        page, staves, systems = two_systems()
        _, start = page.label(150, 30, broken=True)
        page.dashes(start, 700, 30)
        self.assertEqual(list(scan.find_ottavas(page.bitmap(), staves, systems)[0]), [1])

    def test_8va_shifts_the_staff_below_even_nearer_the_staff_above(self):
        # High notes push the line up, next to the previous system's bass staff.
        page, staves, systems = two_systems()
        _, start = page.label(300, 295)
        page.dashes(start, 700, 295)
        intervals, _ = scan.find_ottavas(page.bitmap(), staves, systems)
        self.assertEqual(list(intervals), [3])
        self.assertEqual(intervals[3][0][2], 1)

    def test_8vb_lowers_the_staff_above_it(self):
        page, staves, systems = two_systems()
        _, start = page.label(300, 590, letters="vb")
        page.dashes(start, 700, 590)
        intervals, _ = scan.find_ottavas(page.bitmap(), staves, systems)
        self.assertEqual(list(intervals), [4])
        self.assertEqual(intervals[4][0][2], -1)

    def test_a_bare_eight_goes_to_the_clearly_nearer_staff(self):
        page, staves, systems = two_systems()
        _, start = page.label(300, 590, letters="")
        page.dashes(start, 700, 590)
        self.assertEqual(scan.find_ottavas(page.bitmap(), staves, systems)[0][4][0][2], -1)

    def test_ledger_lines_are_not_dashes(self):
        page, staves, systems = two_systems()
        for x in range(200, 800, 60):        # a run of high notes' ledger lines
            page.fill(x, 80, x + 38, 82)
        self.assertEqual(scan._dashed_lines(page.bitmap(), 0, 95, 0, 1000, IL), [])


class BinarizeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def scan_pdf(self, name, background=255, pages=1):
        """Pages that are each one picture: anti-aliased grey-cored lines."""
        width, height = 200, 100
        samples = bytearray([background] * width * height)
        for top in range(20, 80, 10):
            for x in range(10, 190):
                samples[top * width + x] = 191
                samples[(top + 1) * width + x] = 0
                samples[(top + 2) * width + x] = 127
        pix = pymupdf.Pixmap(pymupdf.csGRAY, width, height, bytes(samples), False)
        path = self.path / name
        with pymupdf.open() as doc:
            for _ in range(pages):
                page = doc.new_page(width=150, height=75)
                # Offset by a fraction of a pixel, as the upload that needed this was.
                page.insert_image(pymupdf.Rect(.37, .37, 150.37, 75.37), pixmap=pix)
            doc.save(path)
        return path

    def levels(self, path, page=0, dpi=200):
        with pymupdf.open(path) as doc:
            pix = doc[page].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
        return set(pix.samples)

    def test_a_clean_scan_is_copied_black_and_white_at_the_reading_dpi(self):
        source = self.scan_pdf("sheet.pdf")
        copy = scan.prepare_for_recognition(source, self.path / "out", dpi=200)
        self.assertEqual(copy, self.path / "out" / "sheet.pdf")
        with pymupdf.open(copy) as doc, pymupdf.open(source) as original:
            self.assertEqual(doc[0].rect, original[0].rect)
        self.assertEqual(self.levels(copy), {0, 255})
        self.assertGreater(len(self.levels(source)), 2)

    def test_a_grey_photographed_page_is_left_to_audiveris(self):
        source = self.scan_pdf("photo.pdf", background=205)
        self.assertEqual(scan.prepare_for_recognition(source, self.path / "out"), source)

    def test_a_vector_page_is_left_alone(self):
        source = self.path / "vector.pdf"
        with pymupdf.open() as doc:
            page = doc.new_page(width=300, height=200)
            for y in range(50, 100, 10):
                page.draw_line((20, y), (280, y))
            doc.save(source)
        self.assertEqual(scan.prepare_for_recognition(source, self.path / "out"), source)

    def test_only_the_pages_being_reread_are_converted(self):
        source = self.scan_pdf("two.pdf", pages=2)
        copy = scan.prepare_for_recognition(source, self.path / "out", dpi=200, pages=[2])
        self.assertGreater(len(self.levels(copy, 0)), 2)
        self.assertEqual(self.levels(copy, 1), {0, 255})


class EnlargeTests(unittest.TestCase):
    """A picture coarser than the reading DPI is resampled to it (Lanczos)."""
    scan_pdf = BinarizeTests.scan_pdf  # 200x100 px on a 150x75 pt page: 96 DPI

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def pictures(self, path, page=0):
        with pymupdf.open(path) as doc:
            return [(i["width"], i["height"]) for i in doc[page].get_image_info()], doc[page].rect

    def test_a_small_picture_is_resampled_to_the_reading_dpi_on_the_same_page(self):
        source = self.scan_pdf("sheet.pdf")
        copy = scan.enlarge_small_pictures(source, self.path / "out", 300)
        self.assertEqual(copy, self.path / "out" / "sheet.pdf")
        pictures, rect = self.pictures(copy)
        self.assertEqual(pictures, [(625, 312)])
        self.assertEqual(rect, self.pictures(source)[1])

    def test_a_picture_near_the_reading_dpi_is_left_alone(self):
        source = self.scan_pdf("sheet.pdf")
        self.assertEqual(scan.enlarge_small_pictures(source, self.path / "out", 100), source)

    def test_a_vector_page_is_left_alone(self):
        source = self.path / "vector.pdf"
        with pymupdf.open() as doc:
            page = doc.new_page(width=300, height=200)
            for y in range(50, 100, 10):
                page.draw_line((20, y), (280, y))
            doc.save(source)
        self.assertEqual(scan.enlarge_small_pictures(source, self.path / "out", 800), source)

    def test_only_the_pages_being_read_are_enlarged(self):
        source = self.scan_pdf("two.pdf", pages=2)
        copy = scan.enlarge_small_pictures(source, self.path / "out", 300, pages=[2])
        self.assertEqual(self.pictures(copy, 0)[0], [(200, 100)])
        self.assertEqual(self.pictures(copy, 1)[0], [(625, 312)])

    def test_a_turned_photo_is_measured_long_side_to_long_side(self):
        # A landscape picture drawn a quarter turn onto a portrait page.
        pix = pymupdf.Pixmap(pymupdf.csGRAY, 400, 300, bytes([255]) * 400 * 300, False)
        with pymupdf.open() as doc:
            page = doc.new_page(width=72, height=96)
            page.insert_image(page.rect, pixmap=pix, rotate=90)
            self.assertAlmostEqual(scan.picture_dpi(page), 300)

    def test_reading_at_a_forced_dpi_reads_the_enlarged_copy(self):
        source = self.scan_pdf("input.pdf")
        with patch.object(run.subprocess, "run") as audiveris, self.assertRaises(RuntimeError):
            run.run_audiveris(source, self.path / "work", dpi=300)  # it wrote no output
        self.assertEqual(audiveris.call_args[0][0][-1], str(self.path / "work" / "enlarged" / "input.pdf"))


class RereadTests(unittest.TestCase):
    def test_missing_staves_counts_against_the_fullest_system(self):
        groups = {1: [[1, 2], [3]], 2: [[1], [2]], 3: [[1, 2]]}
        with patch("run.load_system_staff_groups", side_effect=lambda _, page: groups[page]):
            self.assertEqual(run.missing_staves("book.omr", 3), 3)

    def test_a_page_that_lost_the_same_staff_everywhere_still_counts(self):
        # Every system down to one staff: nothing is "missing" against the
        # fullest system, but a piano score has lost its other hand.
        groups = {1: [[1], [2]]}
        with patch("run.load_system_staff_groups", side_effect=lambda _, page: groups[page]):
            self.assertEqual(run.missing_staves("book.omr", 1), 0)
            self.assertEqual(run.lone_staves("book.omr", 1), 2)

    def test_a_screenshot_with_phone_chrome_is_still_binarized(self):
        # A status bar and an address bar take a third of the picture.
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name)
        source = self.path / "screenshot.pdf"
        with pymupdf.open() as doc:
            page = doc.new_page(width=300, height=300)
            page.draw_rect(pymupdf.Rect(0, 0, 300, 100), color=None, fill=(.2, .2, .2))
            for y in range(150, 175, 6):
                page.draw_line((20, y), (280, y), color=(.5, .5, .5))
            image = page.get_pixmap(dpi=100)
        with pymupdf.open() as doc:
            doc.new_page(width=300, height=300).insert_image(pymupdf.Rect(0, 0, 300, 300), pixmap=image)
            doc.save(source)
        self.assertNotEqual(scan.prepare_for_recognition(source, self.path / "out"), source)

    def test_nothing_to_binarize_means_no_reread(self):
        audiveris = MagicMock()
        with patch("scan.prepare_for_recognition", side_effect=lambda pdf, *_: Path(pdf)), \
             patch("run.run_audiveris", audiveris):
            self.assertIsNone(run.reread_binarized(Path("score.pdf"), Path("work"), "book.omr", 1))
        audiveris.assert_not_called()

    def reread(self, staves, placed):
        """reread_binarized with the re-read finding ``staves`` and placing
        ``placed`` notes, against a first pass that found 7 and placed 150."""
        found = {"first.omr": 7, "copy.omr": staves}
        playable = {"first.omr": 150, "copy.omr": placed}
        with patch("scan.prepare_for_recognition", return_value=Path("work/binarized/input/score.pdf")), \
             patch("run.run_audiveris", return_value=("copy.mxl", "copy.omr")), \
             patch("run.system_sizes", side_effect=lambda book, _: [found[book]]), \
             patch("run.placed_head_ratio", side_effect=lambda book, _: (200, playable[book])):
            return run.reread_binarized(Path("score.pdf"), Path("work"), "first.omr", 1)

    def test_a_reread_that_recovers_staves_is_kept(self):
        self.assertEqual(self.reread(staves=8, placed=189), ("copy.mxl", "copy.omr"))

    def test_a_reread_that_recovers_no_staff_is_dropped(self):
        self.assertIsNone(self.reread(staves=7, placed=189))

    def test_a_reread_that_plays_fewer_notes_is_dropped(self):
        self.assertIsNone(self.reread(staves=8, placed=140))

    def test_page_rereads_of_a_binarized_pass_binarize_too(self):
        audiveris = MagicMock(return_value=(Path("r.mxl"), Path("r.omr")))
        with patch("run.run_audiveris", audiveris), \
             patch("run.staff_interline_pt", return_value=5.0), \
             patch("run.placed_head_ratio", side_effect=[(208, 150), (208, 208)]), \
             patch("run.recognition_quality", side_effect=[.70, .90]):
            run.retry_sparse_pages(Path("score.pdf"), Path("work"), {1: 208}, [1], binarize=True)
        self.assertEqual(audiveris.call_args.kwargs,
                         {"sheets": [1], "binarize": True, "constants": run.NO_MOVEMENTS})

    def test_rereads_are_read_as_one_piece(self):
        """The book pass may only have exported at all once read as one piece;
        a re-read that splits again would be thrown away."""
        audiveris = MagicMock(return_value=(Path("r.mxl"), Path("r.omr")))
        with patch("scan.prepare_for_recognition", return_value=Path("work/binarized/input/score.pdf")), \
             patch("run.run_audiveris", audiveris), \
             patch("run.system_sizes", return_value=[7]), \
             patch("run.placed_head_ratio", return_value=(200, 150)):
            run.reread_binarized(Path("score.pdf"), Path("work"), "first.omr", 1)
        self.assertEqual(audiveris.call_args.kwargs["constants"], run.NO_MOVEMENTS)

    def test_a_page_reread_that_splits_into_movements_keeps_the_original(self):
        """Two uploads failed outright on this: the book read fine as one
        piece, then a page re-read split it again and took the job down."""
        with patch("run.run_audiveris", side_effect=run.SplitIntoMovements("split")) as audiveris, \
             patch("run.staff_interline_pt", return_value=5.0), \
             patch("run.placed_head_ratio", return_value=(208, 150)), \
             patch("run.recognition_quality", return_value=.70):
            overrides = run.retry_sparse_pages(Path("score.pdf"), Path("work"), {1: 208}, [1])
        self.assertEqual(overrides, {})
        # Every approach was still tried after the first one split.
        self.assertGreater(audiveris.call_count, 1)


if __name__ == "__main__":
    unittest.main()
