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
