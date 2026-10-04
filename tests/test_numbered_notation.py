"""Numbered notation (jianpu), fixed-do: 1 = C, 2 = D, ... 7 = B in every key."""
import unittest

import annotate
from label_export import labels_document
from labels import numbered_label, solfege_label

# Diatonic pitch values (0 = B4, counting down): C4 = 6, F4 = 3, G4 = 2.
C4, D4, E4, F4, G4, A4, B4 = 6, 5, 4, 3, 2, 1, 0


class NumberedLabelTests(unittest.TestCase):
    def test_one_is_always_c(self):
        names = [(C4, 0), (D4, 0), (E4, 0), (F4, 0), (G4, 0), (A4, 0), (B4, 0)]
        self.assertEqual([numbered_label(d, a) for d, a in names], ['1', '2', '3', '4', '5', '6', '7'])

    def test_black_keys_keep_their_printed_sharp_or_flat(self):
        # Clair de Lune's D flat major scale, by the keys played.
        names = [(D4, -1), (E4, -1), (F4, 0), (G4, -1), (A4, -1), (B4, -1), (C4, 0)]
        self.assertEqual([numbered_label(d, a) for d, a in names], ['♭2', '♭3', '4', '♭5', '♭6', '♭7', '1'])
        self.assertEqual(numbered_label(F4, 1, style='ascii'), '#4')

    def test_white_keys_read_as_their_own_number_however_spelled(self):
        self.assertEqual(numbered_label(E4, 1), '4')     # E#
        self.assertEqual(numbered_label(C4, -1), '7')    # Cb
        self.assertEqual(numbered_label(C4, 2), '2')     # C double sharp
        self.assertEqual(numbered_label(F4, -2), '♭3')   # F double flat, a black key


class SolfegeLabelTests(unittest.TestCase):
    def test_one_is_always_do(self):
        names = [(C4, 0), (D4, 0), (E4, 0), (F4, 0), (G4, 0), (A4, 0), (B4, 0)]
        self.assertEqual([solfege_label(d, a) for d, a in names],
                          ['do', 're', 'mi', 'fa', 'so', 'la', 'si'])

    def test_black_keys_keep_their_printed_sharp_or_flat(self):
        names = [(D4, -1), (E4, -1), (F4, 0), (G4, -1), (A4, -1), (B4, -1), (C4, 0)]
        self.assertEqual([solfege_label(d, a) for d, a in names],
                          ['♭re', '♭mi', 'fa', '♭so', '♭la', '♭si', 'do'])
        self.assertEqual(solfege_label(F4, 1, style='ascii'), '#fa')

    def test_white_keys_read_as_their_own_syllable_however_spelled(self):
        self.assertEqual(solfege_label(E4, 1), 'fa')    # E#
        self.assertEqual(solfege_label(C4, -1), 'si')   # Cb
        self.assertEqual(solfege_label(C4, 2), 're')    # C double sharp
        self.assertEqual(solfege_label(F4, -2), '♭mi')  # F double flat, a black key


class RecordTests(unittest.TestCase):
    def resolved(self, fifths, *notes):
        return {'pages': {}, 'notes': [
            {'page': 1, 'staff': 1, 'system': 0, 'system_measure': 0, 'role': 0, 'chord_id': str(i),
             'cx': 10 + 20 * i, 'w': 4, 'diatonic': d, 'alter': a, 'key_fifths': fifths,
             'bbox_pt': [8 + 20 * i, 50, 12 + 20 * i, 54]}
            for i, (d, a) in enumerate(notes)]}

    def test_numbers_are_printed_whatever_the_key_and_letters_kept_for_the_viewer(self):
        r = self.resolved(1, (F4, 1), (F4, 0), (G4, 0))
        records = annotate.records_from_resolved(r, notation='numbers')
        self.assertEqual([rec['labels'] for rec in records], [['♯4'], ['4'], ['5']])
        self.assertEqual([rec['letters'] for rec in records], [['F♯'], ['F'], ['G']])

    def test_solfege_is_printed_whatever_the_key_and_letters_kept_for_the_viewer(self):
        r = self.resolved(1, (F4, 1), (F4, 0), (G4, 0))
        records = annotate.records_from_resolved(r, notation='solfege')
        self.assertEqual([rec['labels'] for rec in records], [['♯fa'], ['fa'], ['so']])
        self.assertEqual([rec['letters'] for rec in records], [['F♯'], ['F'], ['G']])

    def test_letters_by_default(self):
        records = annotate.records_from_resolved(self.resolved(0, (F4, 1)))
        self.assertEqual(records[0]['labels'], ['F♯'])

    def test_labels_json_carries_letters_whatever_was_printed(self):
        block = {'x': 10.0, 'labels': ['♯4', '5'], 'letters': ['F♯', 'G'],
                 'ys': [5.0, 12.0], 'label_x_offsets': [0.0, 0.0], 'fs': 6.5, 'widths': [4, 4]}
        doc = labels_document([(1, block)], None, notation='numbers')
        self.assertEqual(doc['notation'], 'numbers')
        self.assertEqual([i['text'] for i in doc['items']], ['F♯', 'G'])
        self.assertNotIn('key', doc['items'][0])

    def test_older_blocks_without_letters_still_export(self):
        block = {'x': 10.0, 'labels': ['G'], 'ys': [5.0], 'label_x_offsets': [0.0], 'fs': 6.5, 'widths': [4]}
        doc = labels_document([(1, block)], None)
        self.assertEqual(doc['items'][0]['text'], 'G')
        self.assertEqual(doc['notation'], 'letters')


if __name__ == '__main__':
    unittest.main()
