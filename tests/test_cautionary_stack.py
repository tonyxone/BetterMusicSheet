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

    def test_a_bar_split_by_a_repeat_keeps_each_halfs_chords(self):
        # Rondo alla Turca: each phrase ends on a repeat sign inside its bar,
        # whose two halves are stacks of one number and measures 8 and X8.
        root = ET.fromstring(
            '<sheet><system><part id="1"><staff id="1"/>'
            '<measure id="8"><head-chords>11</head-chords></measure>'
            '<measure id="X8"><head-chords>12 13</head-chords></measure></part>'
            '<stack id="8" left="1312" right="1476" special="FIRST_HALF" duration="1/4"/>'
            '<stack id="8" left="1476" right="1666" special="SECOND_HALF" duration="1/4"/>'
            '</system></sheet>')
        regions, chord_meta = page_structure(root, {})
        self.assertEqual([(r['system_measure'], r['label']) for r in regions], [(0, '8'), (1, 'X8')])
        self.assertEqual({cid: meta['system_measure'] for cid, meta in chord_meta.items()},
                         {'11': 0, '12': 1, '13': 1})


if __name__ == '__main__':
    unittest.main()
