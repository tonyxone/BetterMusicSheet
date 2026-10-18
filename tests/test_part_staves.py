"""A voice above a piano: recognition numbers a head by its staff in the
system (0 the voice, 1 the right hand, 2 the left), so MusicXML notes have to
be matched on that number, not on their staff within their own part - and a
part only some systems hold moves the others only in those systems."""
import tempfile
import unittest
import zipfile
from pathlib import Path

import musicxml
import timeline
from score_notes import page_structure

NOTE = ('<note><pitch><step>{step}</step><octave>{octave}</octave></pitch><duration>1</duration>'
        '<voice>1</voice><type>quarter</type>{staff}</note>')


def _score(parts):
    """A one-measure score; ``parts`` is a list of (staves, [(step, octave, staff), ...])."""
    header = ''.join(f'<score-part id="P{i}"><part-name>P{i}</part-name></score-part>'
                     for i in range(1, len(parts) + 1))
    body = ''
    for i, (staves, notes) in enumerate(parts, 1):
        attributes = '<attributes><divisions>1</divisions>' + (f'<staves>{staves}</staves>' if staves else '')
        attributes += '<time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
        content = ''
        for step, octave, staff in notes:
            if content:
                content += '<backup><duration>1</duration></backup>'
            content += NOTE.format(step=step, octave=octave, staff=f'<staff>{staff}</staff>' if staff else '')
        body += f'<part id="P{i}"><measure number="1">{attributes}{content}</measure></part>'
    return f'<score-partwise version="4.0"><part-list>{header}</part-list>{body}</score-partwise>'


def _region(system_parts):
    """The region page_structure makes of one system holding ``system_parts``,
    a list of (logical part id, staff count)."""
    import xml.etree.ElementTree as ET
    staff_id, parts = 0, ''
    for part_id, count in system_parts:
        staves = ''
        for _ in range(count):
            staff_id += 1
            staves += f'<staff id="{staff_id}"/>'
        parts += f'<part id="{part_id}">{staves}</part>'
    root = ET.fromstring(f'<sheet><system>{parts}<stack id="1" left="0" right="10"/></system></sheet>')
    return page_structure(root, {})[0][0]


class PartStavesTests(unittest.TestCase):
    def load(self, parts):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'score.mxl'
            with zipfile.ZipFile(path, 'w') as z:
                z.writestr('score.xml', _score(parts))
            notes, _ = musicxml.load_score_notes(path)
        return sorted(notes, key=lambda n: (n['part'], n['staff']))

    def roles(self, notes, region):
        timeline._place_on_system_staves(notes, [], region)
        return [timeline._role(n) for n in notes]

    def test_a_piano_under_a_voice_starts_on_the_systems_second_staff(self):
        notes = self.load([(None, [('A', 4, None)]), (2, [('C', 5, 1), ('C', 3, 2)])])
        self.assertEqual(self.roles(notes, _region([('1', 1), ('2', 2)])), [0, 1, 2])

    def test_a_system_without_the_voice_starts_with_the_piano(self):
        # Liebestraum: two cue "voices" printed in one system of 88 measures.
        notes = self.load([(None, []), (None, []), (2, [('C', 5, 1), ('C', 3, 2)])])
        self.assertEqual(self.roles(notes, _region([('3', 2)])), [0, 1])
        self.assertEqual(self.roles(notes, _region([('1', 1), ('2', 1), ('3', 2)])), [2, 3])

    def test_two_staffless_parts_are_still_the_two_hands(self):
        notes = self.load([(None, [('C', 5, None)]), (None, [('C', 3, None)])])
        self.assertEqual(self.roles(notes, _region([('1', 1), ('2', 1)])), [0, 1])
        self.assertEqual(self.roles(notes, None), [0, 1])

    def test_without_the_systems_parts_a_note_keeps_its_own_staff(self):
        notes = self.load([(None, [('A', 4, None)]), (2, [('C', 5, 1), ('C', 3, 2)])])
        self.assertEqual(self.roles(notes, None), [0, 0, 1])

    def test_the_right_hand_matches_the_head_on_the_second_staff(self):
        notes = self.load([(None, [('A', 4, None)]), (2, [('C', 5, 1), ('C', 3, 2)])])
        timeline._place_on_system_staves(notes, [], _region([('1', 1), ('2', 2)]))
        # The same treble position on the voice's staff and on the right hand's.
        heads = [{'source_id': f'h{role}', 'role': role, 'onset': 0.0, 'voice': '1',
                  'pitch': 34 - 5 * 7 - timeline.clef_reference('G', 2)} for role in (0, 1)]
        self.assertEqual(timeline._match_head(notes[1], heads, set())['source_id'], 'h1')


if __name__ == '__main__':
    unittest.main()
