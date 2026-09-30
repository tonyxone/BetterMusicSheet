"""Numbered notation (jianpu): note names as scale degrees of the key."""
import unittest

import annotate
from label_export import labels_document
from labels import key_marks, key_name, numbered_label

# Diatonic pitch values (0 = B4, counting down): C4 = 6, F4 = 3, G4 = 2.
C4, D4, E4, F4, G4, A4, B4 = 6, 5, 4, 3, 2, 1, 0


class NumberedLabelTests(unittest.TestCase):
    def test_counts_from_the_major_tonic_of_the_key_signature(self):
        # No sharps or flats: G A B C D E F# reads 5 6 7 1 2 3 #4.
        names = [(G4, 0), (A4, 0), (B4, 0), (C4, 0), (D4, 0), (E4, 0), (F4, 1)]
        self.assertEqual([numbered_label(d, a, 0, style='ascii') for d, a in names],
                         ['5', '6', '7', '1', '2', '3', '#4'])

    def test_accidentals_only_where_the_note_leaves_the_key(self):
        self.assertEqual(numbered_label(F4, 1, 1), '7')     # F# in G major
        self.assertEqual(numbered_label(F4, 0, 1), '♭7')    # F natural in G major
        self.assertEqual(numbered_label(E4, -1, -3), '1')   # Eb in Eb major
        self.assertEqual(numbered_label(B4, 0, -3), '♯5')   # B natural in Eb major

    def test_double_accidentals_read_as_the_degree_they_sound(self):
        self.assertEqual(numbered_label(D4, 1, -4), '5')     # D# before a key change, in Ab
        self.assertEqual(numbered_label(A4, 1, -4), '2')     # A# (= Bb) in Ab
        self.assertEqual(numbered_label(A4, -1, 5), '6')     # Ab in B major
        self.assertEqual(numbered_label(C4, 2, 0), '2')      # C double sharp

    def test_minor_keys_read_from_their_relative_major(self):
        self.assertEqual(numbered_label(A4, 0, 0), '6')
        self.assertEqual(numbered_label(G4, 1, 0), '♯5')

    def test_key_names(self):
        self.assertEqual([key_name(f) for f in range(-7, 8)],
                         ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'])
        self.assertEqual(key_name(-2, 'ascii'), 'Bb')


class KeyMarkTests(unittest.TestCase):
    def test_marks_each_page_and_each_key_change_once_per_printed_measure(self):
        def measure(index, page, printed, x):
            return {'index': index, 'printed_index': printed, 'page': page, 'bbox_pt': [x, 100, x + 50, 190]}
        timeline = {
            'measures': [measure(0, 1, 0, 40), measure(1, 1, 1, 90), measure(2, 1, 2, 140),
                         measure(3, 2, 3, 40), measure(4, 1, 1, 90)],
            'notes': [{'measure_index': i, 'key_fifths': k}
                      for i, k in [(0, 0), (1, 0), (2, -1), (2, -1), (2, 0), (3, -1), (4, 0)]],
        }
        marks = key_marks(timeline, size=7)
        self.assertEqual([(p, x, text) for p, x, _, text in marks],
                         [(1, 40, '1=C'), (1, 140, '1=F'), (2, 40, '1=F')])
        self.assertLess(marks[0][2], 100)  # above the top staff line

    def test_no_timeline_no_marks(self):
        self.assertEqual(key_marks(None), [])


class RecordTests(unittest.TestCase):
    def resolved(self, fifths, *notes):
        return {'pages': {}, 'notes': [
            {'page': 1, 'staff': 1, 'system': 0, 'system_measure': 0, 'role': 0, 'chord_id': str(i),
             'cx': 10 + 20 * i, 'w': 4, 'diatonic': d, 'alter': a, 'key_fifths': fifths,
             'bbox_pt': [8 + 20 * i, 50, 12 + 20 * i, 54]}
            for i, (d, a) in enumerate(notes)]}

    def test_numbers_are_printed_and_letters_kept_for_the_viewer(self):
        r = self.resolved(1, (F4, 1), (F4, 0), (G4, 0))
        records = annotate.records_from_resolved(r, notation='numbers')
        self.assertEqual([rec['labels'] for rec in records], [['7'], ['♭7'], ['1']])
        self.assertEqual([rec['letters'] for rec in records], [['F♯'], ['F'], ['G']])
        self.assertEqual([rec['keys'] for rec in records], [[1], [1], [1]])

    def test_letters_by_default(self):
        records = annotate.records_from_resolved(self.resolved(0, (F4, 1)))
        self.assertEqual(records[0]['labels'], ['F♯'])

    def test_labels_json_carries_letters_and_keys_whatever_was_printed(self):
        block = {'x': 10.0, 'labels': ['7', '1'], 'letters': ['F♯', 'G'], 'keys': [1, 1],
                 'ys': [5.0, 12.0], 'label_x_offsets': [0.0, 0.0], 'fs': 6.5, 'widths': [4, 4]}
        doc = labels_document([(1, block)], None, notation='numbers')
        self.assertEqual(doc['notation'], 'numbers')
        self.assertEqual([(i['text'], i['key']) for i in doc['items']], [('F♯', 1), ('G', 1)])

    def test_older_blocks_without_keys_still_export(self):
        block = {'x': 10.0, 'labels': ['G'], 'ys': [5.0], 'label_x_offsets': [0.0], 'fs': 6.5, 'widths': [4]}
        doc = labels_document([(1, block)], None)
        self.assertEqual(doc['items'][0]['text'], 'G')
        self.assertNotIn('key', doc['items'][0])
        self.assertEqual(doc['notation'], 'letters')


if __name__ == '__main__':
    unittest.main()
