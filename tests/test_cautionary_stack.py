"""A courtesy key or time signature closing a system is a stack of its own in
Audiveris's book (special="CAUTIONARY", no duration), but not a measure of the
MusicXML it exports - so it is not a printed region either."""
import unittest
import xml.etree.ElementTree as ET

from score_notes import page_structure


class CautionaryStackTests(unittest.TestCase):
    def test_a_cautionary_stack_is_not_a_measure(self):
        root = ET.fromstring(
            '<sheet><system><part id="1"><staff id="1"/></part>'
            '<stack id="14" left="945" right="1635" duration="3/4"/>'
            '<stack id="15" left="1635" right="2335" duration="3/4"/>'
            '<stack id="15" left="2335" right="2362" special="CAUTIONARY" duration="0"/>'
            '</system><system><part id="1"><staff id="2"/></part>'
            '<stack id="16" left="163" right="1297" duration="3/4"/></system></sheet>')
        regions = page_structure(root, {})[0]
        self.assertEqual([(r['system'], r['system_measure'], r['label']) for r in regions],
                         [(0, 0, '14'), (0, 1, '15'), (1, 0, '16')])


if __name__ == '__main__':
    unittest.main()
