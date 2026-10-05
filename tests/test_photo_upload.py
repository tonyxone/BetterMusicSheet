"""A photo upload becomes the PDF page the worker reads, at a fixed scale -
the scale the viewer also uses to show a photo whose names failed, so marks
made on it stay where they were drawn (lib/photo-pages.ts photoAsPdf)."""
import struct
import tempfile
import unittest
from pathlib import Path

import pymupdf

import processor


def photo(width, height, rotate_tag=None):
    """JPEG bytes: red down the left edge of the stored pixels, optionally
    tagged the way a phone tags a photo taken sideways."""
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, width, height), False)
    pix.set_rect(pix.irect, (255, 255, 255))
    pix.set_rect(pymupdf.IRect(0, 0, width // 4, height), (255, 0, 0))
    data = pix.tobytes("jpg")
    if rotate_tag is None:
        return data
    # EXIF: one IFD entry, Orientation (0x0112) as a SHORT.
    tiff = b"II*\x00" + struct.pack("<I", 8) + struct.pack("<H", 1) \
        + struct.pack("<HHIHH", 0x0112, 3, 1, rotate_tag, 0) + struct.pack("<I", 0)
    payload = b"Exif\x00\x00" + tiff
    return data[:2] + b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload + data[2:]


class PhotoUploadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name)

    def convert(self, data, name="photo.jpg"):
        (self.path / name).write_bytes(data)
        processor.photo_as_pdf(self.path / name, self.path / "photo.pdf")
        return pymupdf.open(self.path / "photo.pdf")

    def test_a_photo_is_read_one_to_one_whatever_dpi_it_claims(self):
        # A 1080px-wide screenshot claims 72 or 96 dpi; read at that it was
        # enlarged three to four times before recognition saw it.
        with self.convert(photo(1080, 600)) as doc:
            page = doc[0]
            self.assertAlmostEqual(page.rect.width, 1080 * 72 / processor.PHOTO_DPI, places=2)
            self.assertAlmostEqual(page.rect.height, 600 * 72 / processor.PHOTO_DPI, places=2)
            self.assertEqual(page.get_pixmap(dpi=processor.PHOTO_DPI).width, 1080)

    def test_a_photo_taken_sideways_is_turned_upright(self):
        # Orientation 6: shown turned a quarter clockwise, so the stored left
        # edge ends up along the top.
        with self.convert(photo(400, 200, rotate_tag=6)) as doc:
            page = doc[0]
            self.assertAlmostEqual(page.rect.width, 200 * 72 / processor.PHOTO_DPI, places=2)
            self.assertAlmostEqual(page.rect.height, 400 * 72 / processor.PHOTO_DPI, places=2)
            pix = page.get_pixmap(dpi=processor.PHOTO_DPI)
            self.assertGreater(pix.pixel(pix.width - 5, 5)[0], 200)
            self.assertLess(pix.pixel(pix.width - 5, 5)[1], 60)
            self.assertGreater(pix.pixel(5, pix.height - 5)[1], 200)


if __name__ == "__main__":
    unittest.main()
