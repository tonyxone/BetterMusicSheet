"""Hollow heads printed beside their chord, a 2nd from a recognized head.

Pages are drawn by hand here - no OMR engine or real scan required.
"""
import unittest

import scan
from score_notes import displaced_noteheads, merge_displaced_noteheads

IL = 20  # staff interline of the drawn page, in pixels
TOP = 100  # the staff's top line; its middle line, pitch 0, is at TOP + 2 * IL
W, H = 28, 20  # a whole note's box


class Canvas:
    """A white page with one five-line staff."""

    def __init__(self, width=600, height=300):
        self.width, self.height = width, height
        self.pixels = bytearray(b"\xff" * width * height)
        for k in range(5):
            self.fill(20, TOP + k * IL, width - 20, TOP + k * IL + 2)

    def fill(self, x0, y0, x1, y1):
        for y in range(y0, y1):
            self.pixels[y * self.width + x0:y * self.width + x1] = b"\x00" * (x1 - x0)

    def head(self, cx, pitch, hollow=True):
        """A whole note centred at cx on a staff position; a filled one if
        not hollow."""
        cy = centre(pitch)
        for y in range(cy - H // 2, cy + H // 2 + 1):
            for x in range(cx - W // 2, cx + W // 2 + 1):
                outer = ((x - cx) / (W / 2)) ** 2 + ((y - cy) / (H / 2)) ** 2 <= 1
                hole = ((x - cx) / 7) ** 2 + ((y - cy) / 6) ** 2 <= 1
                if outer and not (hollow and hole):
                    self.pixels[y * self.width + x] = 0

    def bitmap(self):
        return scan._Bitmap(self.width, self.height, bytes(self.pixels))


def centre(pitch):
    return TOP + 2 * IL + pitch * IL // 2


def recognized(head_id, cx, pitch):
    """A head as audiveris_heads.load_sheet_heads reads it."""
    cy = centre(pitch)
    return {'staff': 1, 'shape': 'WHOLE_NOTE', 'id': head_id, 'pitch': pitch, 'confidence': .6,
            'x': cx - W / 2, 'y': cy - H / 2, 'w': W, 'h': H, 'cx': cx, 'cy': cy}


LINES = {1: tuple(TOP + k * IL for k in range(5))}


class DisplacedHeadTests(unittest.TestCase):
    def test_finds_the_head_printed_beside_a_recognized_one(self):
        page = Canvas()
        page.head(300, -1)
        page.head(300 - W, 0)  # a 2nd below, pushed to the left
        found = displaced_noteheads(page.bitmap(), [recognized('h1', 300, -1)], LINES)
        self.assertEqual([(f['staff'], f['pitch'], f['shape']) for f in found], [(1, 0, 'WHOLE_NOTE')])
        self.assertAlmostEqual(found[0]['cx'], 300 - W, delta=2)
        self.assertAlmostEqual(found[0]['cy'], centre(0), delta=1)

    def test_a_found_head_joins_its_neighbours_chord(self):
        page = Canvas()
        page.head(300, -1)
        page.head(300 - W, 0)
        heads, chords = [recognized('h1', 300, -1)], {'h1': 'chord-7'}
        self.assertEqual(merge_displaced_noteheads(page.bitmap(), heads, chords, LINES, 1), 1)
        added = heads[-1]
        self.assertEqual(added['id'], 'displaced-head-1-0')
        self.assertEqual(chords[added['id']], 'chord-7')

    def test_a_head_recognition_already_has_is_not_added_again(self):
        page = Canvas()
        page.head(300, -1)
        page.head(300 - W, 0)
        heads = [recognized('h1', 300, -1), recognized('h2', 300 - W, 0)]
        self.assertEqual(displaced_noteheads(page.bitmap(), heads, LINES), [])

    def test_a_lone_head_gains_no_neighbour(self):
        page = Canvas()
        page.head(300, -1)
        self.assertEqual(displaced_noteheads(page.bitmap(), [recognized('h1', 300, -1)], LINES), [])

    def test_filled_heads_called_hollow_are_not_a_template(self):
        page = Canvas()
        page.head(300, -1, hollow=False)
        page.head(300 - W, 0, hollow=False)
        self.assertEqual(displaced_noteheads(page.bitmap(), [recognized('h1', 300, -1)], LINES), [])

    def test_a_beam_stack_called_hollow_is_not_a_template(self):
        page = Canvas()
        # Beams half a space apart with slivers of white between, crossed by
        # stems a head-width apart that wall the slivers in: the picture
        # repeats a step and a head-width over, exactly as a chord would.
        for y in range(110, 160, IL // 2):
            page.fill(150, y, 450, y + 6)
        for x in range(150, 451, W):
            page.fill(x, 90, x + 3, 165)
        self.assertEqual(displaced_noteheads(page.bitmap(), [recognized('h1', 300, -1)], LINES), [])


if __name__ == '__main__':
    unittest.main()
