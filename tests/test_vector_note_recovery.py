import unittest

import timeline
from score_notes import vector_pdf_noteheads


class _VectorPage:
    def get_text(self, kind):
        assert kind == 'rawdict'
        return {'blocks': [{'lines': [{'spans': [{'chars': [
            {'c': chr(0xE0A4), 'origin': (30, 47.5), 'bbox': (30, 30, 36, 60)},
            {'c': 'B', 'origin': (80, 47.5), 'bbox': (80, 40, 86, 55)},
        ]}]}]}]}


class VectorNoteRecoveryTests(unittest.TestCase):
    def test_reads_smufl_black_notehead_and_calculates_staff_pitch(self):
        heads = vector_pdf_noteheads(_VectorPage(), {1: (40, 45, 50, 55, 60)})
        self.assertEqual(len(heads), 1)
        self.assertEqual((heads[0]['staff'], heads[0]['pitch']), (1, -1))

    def test_uniform_run_restores_middle_head_and_retimes_following_notes(self):
        measure = {'identity': ('3', 0), 'label': '3', 'length_beats': 4.0,
                   'content_length_beats': 3.5, 'rests': [], 'warnings': []}
        heads = []
        for i, pitch in enumerate((-1, -8, -7, -8, -6, -8, -5, -8)):
            source = f'h{i}'
            heads.append({'source_id': source, 'role': 0, 'cx': 100 + i * 20,
                          'shape': 'NOTEHEAD_BLACK', 'confidence': .95,
                          'pitch_uncertain': False, 'diatonic': pitch,
                          'alter': 0, 'bbox_pt': [i * 10, 0, i * 10 + 5, 5],
                          'vector_pdf': i == 2})
        notes = []
        for sequence, head_index in enumerate((0, 1, 3, 4, 5, 6, 7)):
            notes.append({'identity': ('3', sequence), 'label': '3', 'part': 0,
                          'staff': 1, 'voice': '1', 'step': 'C', 'octave': 6,
                          'alter': 0, 'start_beat_in_measure': sequence * .5,
                          'duration_beats': .5, 'is_grace': False, 'chord': False,
                          'tie_start': False, 'tie_stop': False, 'clef': {'sign': 'G'},
                          'octave_shift': 0, 'key_fifths': 0, 'transpose': 0,
                          'source_id': f'n{sequence}', 'printed_id': f'n{sequence}',
                          'head_id': f'h{head_index}', 'midi': 84, 'xml_midi': 84,
                          'bbox_pt': [0, 0, 1, 1], 'articulations': [],
                          'ornaments': [], 'fermata': False, 'arpeggiate': False,
                          'fingering': None})
        used = {f'h{i}' for i in (0, 1, 3, 4, 5, 6, 7)}

        self.assertEqual(timeline._recover_uniform_vector_run(measure, notes, heads, used), 1)
        self.assertEqual([n['start_beat_in_measure'] for n in notes],
                         [0, .5, 1.5, 2, 2.5, 3, 3.5, 1])
        recovered = notes[-1]
        self.assertEqual((recovered['step'], recovered['octave'], recovered['midi']),
                         ('B', 5, 83))
        self.assertEqual(measure['content_length_beats'], 4)

    def test_uniform_run_rejects_irregular_visual_spacing(self):
        measure = {'identity': ('1', 0), 'label': '1', 'length_beats': 2.0,
                   'content_length_beats': 1.5, 'rests': [], 'warnings': []}
        heads = [
            {'source_id': f'h{i}', 'role': 0, 'cx': x, 'shape': 'NOTEHEAD_BLACK',
             'confidence': .95, 'pitch_uncertain': False, 'diatonic': -1,
             'alter': 0, 'bbox_pt': [0, 0, 1, 1], 'vector_pdf': i == 2}
            for i, x in enumerate((10, 20, 37, 50))]
        notes = [
            {'staff': 1, 'voice': '1', 'start_beat_in_measure': i * .5,
             'duration_beats': .5, 'is_grace': False, 'chord': False,
             'tie_start': False, 'tie_stop': False, 'head_id': f'h{j}'}
            for i, j in enumerate((0, 1, 3))]
        self.assertEqual(timeline._recover_uniform_vector_run(
            measure, notes, heads, {'h0', 'h1', 'h3'}), 0)


if __name__ == '__main__':
    unittest.main()


class _Glyphs:
    def __init__(self, glyphs):
        self.glyphs = glyphs

    def get_text(self, kind):
        assert kind == 'rawdict'
        return {'blocks': [{'lines': [{'spans': [{'chars': [
            {'c': chr(cp), 'origin': (x, y), 'bbox': (x, y - 3, x + 6, y + 3)} for cp, x, y in self.glyphs
        ]}]}]}]}


class WiderGapFillerTests(unittest.TestCase):
    # Two staves, interline 5: middle lines at 50 and 110.
    STAVES = {1: (40, 45, 50, 55, 60), 2: (100, 105, 110, 115, 120)}

    def test_whole_and_half_noteheads_are_read_with_their_shape(self):
        heads = vector_pdf_noteheads(_Glyphs([(0xE0A2, 10, 50), (0xE0A3, 20, 55), (0xE0A4, 30, 60)]), self.STAVES)
        self.assertEqual([h['shape'] for h in heads], ['WHOLE_NOTE', 'NOTEHEAD_VOID', 'NOTEHEAD_BLACK'])

    def test_high_ledger_notes_are_read_when_clearly_one_staffs(self):
        # 5.5 spaces above the top staff (an 8va run), far from the other one.
        heads = vector_pdf_noteheads(_Glyphs([(0xE0A4, 10, 22.5)]), self.STAVES)
        self.assertEqual([(h['staff'], h['pitch']) for h in heads], [(1, -11)])

    def test_a_note_halfway_between_staves_is_left_alone(self):
        # Six spaces from each middle line: which staff it belongs to is a guess.
        self.assertEqual(vector_pdf_noteheads(_Glyphs([(0xE0A4, 10, 80)]), self.STAVES), [])
        # Within two ledger lines the nearer staff is still taken, as before.
        self.assertEqual(len(vector_pdf_noteheads(_Glyphs([(0xE0A4, 10, 70)]), self.STAVES)), 1)

    def test_nothing_beyond_the_ledger_limit(self):
        self.assertEqual(vector_pdf_noteheads(_Glyphs([(0xE0A4, 10, 12.5)]), {1: self.STAVES[1]}), [])


class AlignedVectorHeadTests(unittest.TestCase):
    """Bach-style bars: recognized notes, and heads only the PDF had."""

    def note(self, sid, staff, start, duration, midi, head_id):
        return {'identity': ('1', sid), 'label': '1', 'part': 0, 'staff': staff, 'voice': str(staff),
                'step': 'C', 'octave': 4, 'alter': 0, 'start_beat_in_measure': start,
                'duration_beats': duration, 'is_grace': False, 'chord': False, 'tie_start': False,
                'tie_stop': False, 'clef': {'sign': 'G' if staff == 1 else 'F', 'line': 2, 'octave': 0},
                'octave_shift': 0, 'key_fifths': -2, 'transpose': 0, 'source_id': sid, 'printed_id': sid,
                'head_id': head_id, 'midi': midi, 'xml_midi': midi, 'bbox_pt': [0, 0, 1, 1],
                'articulations': [], 'ornaments': [], 'fermata': False, 'arpeggiate': False, 'fingering': None}

    def head(self, sid, role, cx, diatonic, shape, vector_pdf=False):
        return {'source_id': sid, 'role': role, 'cx': cx, 'w': 10, 'diatonic': diatonic, 'alter': 0,
                'shape': shape, 'clef': 'G' if role == 0 else 'F', 'key_fifths': -2,
                'bbox_pt': [cx, 0, cx + 5, 5], 'confidence': 1.0, 'vector_pdf': vector_pdf}

    def measure(self):
        return {'identity': ('1', 0), 'label': '1', 'length_beats': 4.0, 'content_length_beats': 4.0,
                'rests': [], 'warnings': []}

    def test_a_missed_chord_note_takes_its_chord_partners_timing(self):
        # Final bar: D3 recognized as a whole note, the G2 under it missed.
        notes = [self.note('n1', 2, 0, 4.0, 50, 'h-d3')]
        heads = [self.head('h-d3', 1, 200, 12, 'WHOLE_NOTE'), self.head('pdf-g2', 1, 201, 16, 'WHOLE_NOTE', True)]
        measure = self.measure()
        self.assertEqual(timeline._recover_aligned_vector_heads(measure, notes, heads, {'h-d3'}), 1)
        added = notes[-1]
        self.assertEqual((added['midi'], added['staff'], added['start_beat_in_measure'], added['duration_beats']),
                         (43, 2, 0, 4.0))
        self.assertEqual((added['pitch_source'], added['timing_source'], added['chord']),
                         ('pdf-vector-recovered', 'aligned-chord', True))
        self.assertTrue(measure['warnings'][0].startswith('Recovered a missed notehead'))

    def test_a_missed_whole_note_chord_is_timed_from_the_other_staff(self):
        # Bar 63: the whole bass chord missed; the treble's first note is on beat 0.
        notes = [self.note('t1', 1, 0, .25, 67, 'h-t1'), self.note('t2', 1, .25, .25, 70, 'h-t2')]
        heads = [self.head('h-t1', 0, 100, 2, 'NOTEHEAD_BLACK'), self.head('h-t2', 0, 140, 0, 'NOTEHEAD_BLACK'),
                 self.head('pdf-b1', 1, 101, 16, 'WHOLE_NOTE', True), self.head('pdf-b2', 1, 101, 14, 'WHOLE_NOTE', True)]
        self.assertEqual(timeline._recover_aligned_vector_heads(self.measure(), notes, heads, {'h-t1', 'h-t2'}), 2)
        bass = [n for n in notes if n['staff'] == 2]
        self.assertEqual(sorted((n['midi'], n['start_beat_in_measure'], n['duration_beats']) for n in bass),
                         [(43, 0, 4.0), (47, 0, 4.0)])
        self.assertEqual({n['clef']['sign'] for n in bass}, {'F'})

    def test_a_lone_black_head_stays_silent(self):
        # Nothing in its own staff to join, and a black head's length is unknown.
        notes = [self.note('t1', 1, 0, 1.0, 67, 'h-t1')]
        heads = [self.head('h-t1', 0, 100, 2, 'NOTEHEAD_BLACK'), self.head('pdf-x', 1, 100, 16, 'NOTEHEAD_BLACK', True)]
        self.assertEqual(timeline._recover_aligned_vector_heads(self.measure(), notes, heads, {'h-t1'}), 0)

    def test_nothing_is_added_twice(self):
        # The PDF head's pitch already sounds at that moment in that staff.
        notes = [self.note('n1', 2, 0, 4.0, 43, 'h-a'), self.note('n2', 2, 0, 4.0, 50, 'h-b')]
        heads = [self.head('h-a', 1, 200, 12, 'WHOLE_NOTE'), self.head('h-b', 1, 230, 16, 'WHOLE_NOTE'),
                 self.head('pdf-g2', 1, 201, 16, 'WHOLE_NOTE', True)]
        self.assertEqual(timeline._recover_aligned_vector_heads(self.measure(), notes, heads, {'h-a', 'h-b'}), 0)


class PrintedAccidentalTests(unittest.TestCase):
    STAVES = {1: (40, 45, 50, 55, 60)}

    def read(self, glyphs):
        return [(h['shape'], h['accidental']) for h in vector_pdf_noteheads(_Glyphs(glyphs), self.STAVES)]

    def test_a_missed_head_keeps_the_sharp_printed_before_it(self):
        self.assertEqual(self.read([(0xE262, 2, 55), (0xE0A2, 10, 55)]), [('WHOLE_NOTE', 'SHARP')])

    def test_an_accidental_on_another_line_is_not_its(self):
        self.assertEqual(self.read([(0xE260, 2, 45), (0xE0A2, 10, 55)]), [('WHOLE_NOTE', None)])

    def test_an_earlier_note_keeps_its_own_accidental(self):
        # Sharp, then a note on that line, then this note: the sharp is the first note's.
        self.assertEqual(self.read([(0xE262, 2, 55), (0xE0A4, 10, 55), (0xE0A4, 40, 55)]),
                         [('NOTEHEAD_BLACK', 'SHARP'), ('NOTEHEAD_BLACK', None)])
