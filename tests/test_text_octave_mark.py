"""Recognition without OCR takes an "8" of the page's text for an octave mark:
Bach's "(1685-1750)" above a Minuet started an 8va the export carried to the
end of the page, and every bar after it was flagged."""
import unittest

import pymupdf

from pdf_marks import octave_mark_is_text


def _page(*words):
    """A page with each (text, x, y) written at its point."""
    page = pymupdf.open().new_page(width=600, height=800)
    for text, x, y in words:
        page.insert_text((x, y), text, fontsize=10)
    return page


class TextOctaveMarkTests(unittest.TestCase):
    def test_the_eight_of_a_composers_dates_is_text(self):
        page = _page(('Johann Sebastian Bach (1685-1750)', 380, 70))
        eight = page.search_for('1685')[0]
        self.assertTrue(octave_mark_is_text(page, (eight.x0 + 10, eight.y0, eight.x1, eight.y1)))

    def test_a_tempo_marks_number_is_text(self):
        page = _page(('= 138', 100, 70))
        number = page.search_for('138')[0]
        self.assertTrue(octave_mark_is_text(page, tuple(number)))

    def test_a_spelled_out_8va_is_an_octave_mark(self):
        page = _page(('8va', 100, 70))
        self.assertFalse(octave_mark_is_text(page, tuple(page.search_for('8va')[0])))

    def test_nothing_printed_there_is_left_to_recognition(self):
        # An 8va drawn as outlines has no text under it.
        self.assertFalse(octave_mark_is_text(_page(('sempre', 100, 300)), (100, 60, 110, 72)))


if __name__ == '__main__':
    unittest.main()
