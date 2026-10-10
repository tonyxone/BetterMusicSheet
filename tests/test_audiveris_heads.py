import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from audiveris_heads import load_sheet_heads


class LoadSheetHeadsTests(unittest.TestCase):
    def test_a_fractional_pitch_is_taken_to_the_nearest_step(self):
        # Faure Ballade Op. 19 (prod job b9dcab50) crashed on pitch="-11.9".
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'book.omr'
            root = ET.Element('sheet')
            sig = ET.SubElement(root, 'sig')
            for x, pitch in (('10', '-3'), ('40', '-11.9'), ('70', '2.4')):
                head = ET.SubElement(sig, 'head', id=x, shape='NOTEHEAD_BLACK', staff='1', pitch=pitch)
                ET.SubElement(head, 'bounds', x=x, y='50', w='12', h='10')
            with zipfile.ZipFile(path, 'w') as z:
                z.writestr('sheet#1/sheet#1.xml', ET.tostring(root))
            self.assertEqual([h['pitch'] for h in load_sheet_heads(str(path), 1)], [-3, -12, 2])


if __name__ == '__main__':
    unittest.main()
