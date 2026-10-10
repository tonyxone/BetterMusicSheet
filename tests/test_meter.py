"""A time signature Audiveris misread is set right in its own book, from the
engraving's text layer, and only its rhythm step is redone (meter.py)."""
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

import pymupdf

import meter
import pdf_marks
import run

BOOK_INDEX = """<?xml version="1.0" ?>
<book software-version="5.11.0" path="/x/nocturne.pdf">
  <sheet number="1" version="5.11.0">
    <steps>LOAD BINARY SCALE GRID HEADERS STEM_SEEDS BEAMS LEDGERS HEADS STEMS REDUCTION CUE_BEAMS TEXTS MEASURES CHORDS CURVES SYMBOLS LINKS RHYTHMS PAGE</steps>
    <page id="1" delta-measure-id="8">
      <last-time-rational num="7" den="8"/>
    </page>
  </sheet>
  <sheet number="2" version="5.11.0">
    <steps>LOAD BINARY SCALE GRID HEADERS STEM_SEEDS BEAMS LEDGERS HEADS STEMS REDUCTION CUE_BEAMS TEXTS MEASURES CHORDS CURVES SYMBOLS LINKS RHYTHMS PAGE</steps>
    <page id="1" delta-measure-id="11">
    </page>
  </sheet>
  <sheet number="3" version="5.11.0">
    <steps>LOAD BINARY SCALE GRID HEADERS STEM_SEEDS BEAMS LEDGERS HEADS STEMS REDUCTION CUE_BEAMS TEXTS MEASURES CHORDS CURVES SYMBOLS LINKS RHYTHMS PAGE</steps>
    <page id="1" delta-measure-id="7">
      <last-time-rational num="2" den="4"/>
    </page>
  </sheet>
</book>
"""


def sheet_xml(pairs):
    """A sheet carrying time signatures the way Audiveris writes them:
    (rational, top grade, bottom grade), one per staff."""
    root = ET.Element('sheet')
    ET.SubElement(root, 'picture', width='2479', height='3508')
    sig = ET.SubElement(root, 'sig')
    ids = iter(range(100, 1000))
    for staff, (rational, top, bottom) in enumerate(pairs, 1):
        num, den = rational.split('/')
        shapes = {num: meter.NUMERAL_SHAPES.get(int(num), 'TIME_CUSTOM'),
                  den: meter.NUMERAL_SHAPES.get(int(den), 'TIME_CUSTOM')}
        top_id, bottom_id = next(ids), next(ids)
        for side, value, grade, id_ in (('TOP', num, top, top_id), ('BOTTOM', den, bottom, bottom_id)):
            number = ET.SubElement(sig, 'time-number', side=side, value=value, shape=shapes[value],
                                   glyph='167', grade=str(grade), **{'ctx-grade': str(grade)},
                                   frozen='true', staff=str(staff), id=str(id_))
            ET.SubElement(number, 'bounds', x='320', y='472', w='34', h='42')
        pair = ET.SubElement(sig, 'time-pair', **{'time-rational': rational},
                             grade='0.7', frozen='true', staff=str(staff), id=str(next(ids)))
        ET.SubElement(pair, 'bounds', x='320', y='472', w='38', h='85')
        relation = ET.SubElement(sig, 'relation', source=str(top_id), target=str(bottom_id))
        ET.SubElement(relation, 'time-top-bottom', grade='1')
    # A measure's own list of its time inters must not be mistaken for a number.
    measure = ET.SubElement(root, 'measure', id='1')
    ET.SubElement(measure, 'time-numbers').text = '100 101'
    return ET.tostring(root, encoding='unicode')


def write_book(path, sheets):
    """``sheets``: {number: sheet xml}; the book index covers sheets 1-3."""
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('book.xml', BOOK_INDEX)
        for number, xml in sheets.items():
            z.writestr(f'sheet#{number}/sheet#{number}.xml', xml)
            z.writestr(f'sheet#{number}/BINARY.png', b'\x89PNG' + bytes([number]) * 16)
    return path


class PdfMeterTests(unittest.TestCase):
    def test_pdf_marks_carry_the_meter_as_written(self):
        chars = [{'c': chr(0xE081), 'origin': (10, 20)},
                 {'c': chr(0xE082), 'origin': (16, 20)},
                 {'c': chr(0xE088), 'origin': (13, 30)},
                 {'c': chr(0xE08A), 'origin': (100, 70)},
                 {'c': chr(0xE08B), 'origin': (200, 70)}]

        class Page:
            def get_text(self, kind):
                return {'blocks': [{'lines': [{'spans': [{'chars': chars}]}]}]}
        marks = sorted(pdf_marks.time_signatures(Page()), key=lambda m: m['x'])
        self.assertEqual([(m['num'], m['den'], m['beats']) for m in marks],
                         [(12, 8, 6.0), (4, 4, 4.0), (2, 2, 4.0)])

    def test_printed_meters_come_from_the_requested_page_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / 'two.pdf'
            with pymupdf.open() as doc:
                doc.new_page(), doc.new_page()
                doc.save(pdf)
            marks = {0: [dict(x=1, y=1, num=12, den=8)], 1: []}
            with patch.object(pdf_marks, 'time_signatures', side_effect=lambda page: marks[page.number]):
                self.assertEqual(meter.printed_meters(pdf, 1), [(12, 8)])
                self.assertEqual(meter.printed_meters(pdf, 2), [])
                self.assertEqual(meter.printed_meters(pdf, 3), [])


class BookMeterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)

    def book(self, sheets):
        return write_book(self.path / 'book.omr', sheets)

    def test_a_signature_is_graded_by_its_weakest_digit(self):
        book = self.book({1: sheet_xml([('7/8', .176, .799), ('7/8', .2, .8)])})
        read = meter.book_meters(book, 1)
        self.assertEqual([(m['num'], m['den'], m['staff']) for m in read], [(7, 8, 1), (7, 8, 2)])
        self.assertEqual(read[0]['grade'], .176)
        self.assertEqual(meter.book_meters(book, 2), [])

    def corrections(self, sheets, printed):
        book = self.book(sheets)
        with patch.object(meter, 'printed_meters', side_effect=lambda pdf, page: printed.get(page, [])):
            return meter.meter_corrections('any.pdf', book, 3)

    def test_a_poorly_read_signature_contradicted_by_the_print_is_corrected(self):
        """The nocturne: a printed 12/8 read as 7/8, its "7" graded 0.18."""
        found = self.corrections({1: sheet_xml([('7/8', .176, .799), ('7/8', .2, .8)])},
                                 {1: [(12, 8), (12, 8)]})
        self.assertEqual(found, {1: {'from': (7, 8), 'to': (12, 8)}})

    def test_a_signature_matching_the_print_is_left_alone(self):
        self.assertEqual(self.corrections({1: sheet_xml([('2/4', .3, .9)])}, {1: [(2, 4)]}), {})
        # Same bar length written differently is not a misreading either.
        self.assertEqual(self.corrections({1: sheet_xml([('6/4', .3, .9)])}, {1: [(12, 8)]}), {})

    def test_a_confidently_read_signature_is_trusted_over_the_print(self):
        self.assertEqual(self.corrections({1: sheet_xml([('7/8', .85, .9)])}, {1: [(12, 8)]}), {})

    def test_a_page_printing_several_meters_is_left_alone(self):
        self.assertEqual(self.corrections({1: sheet_xml([('7/8', .176, .799)])}, {1: [(12, 8), (2, 4)]}), {})

    def test_a_sheet_whose_staves_disagree_is_left_alone(self):
        self.assertEqual(self.corrections({1: sheet_xml([('7/8', .176, .799), ('6/8', .2, .8)])},
                                          {1: [(12, 8)]}), {})

    def test_a_meter_audiveris_cannot_write_is_left_alone(self):
        self.assertEqual(self.corrections({1: sheet_xml([('7/8', .176, .799)])}, {1: [(10, 8)]}), {})
        self.assertEqual(self.corrections({1: sheet_xml([('7/8', .176, .799)])}, {1: [(3, 1)]}), {})

    def test_a_scan_has_no_printed_meter_to_correct_from(self):
        self.assertEqual(self.corrections({1: sheet_xml([('7/8', .176, .799)])}, {}), {})

    def test_patching_rewrites_the_meter_and_strikes_the_rhythm_steps(self):
        original = self.book({1: sheet_xml([('7/8', .176, .799), ('7/8', .2, .8)]),
                              2: sheet_xml([]), 3: sheet_xml([('2/4', .9, .9)])})
        patched = meter.patch_book(original, self.path / 'patched.omr', {1: {'from': (7, 8), 'to': (12, 8)}})
        with zipfile.ZipFile(patched) as z, zipfile.ZipFile(original) as o:
            self.assertEqual(sorted(z.namelist()), sorted(o.namelist()))
            for name in o.namelist():
                if name.endswith('.png') or name == 'sheet#2/sheet#2.xml' or name == 'sheet#3/sheet#3.xml':
                    self.assertEqual(z.read(name), o.read(name), name)
            sheet = ET.fromstring(z.read('sheet#1/sheet#1.xml'))
            self.assertEqual([p.get('time-rational') for p in sheet.iter('time-pair')], ['12/8', '12/8'])
            numbers = [(n.get('side'), n.get('value'), n.get('shape'), n.get('frozen'), n.get('glyph'))
                       for n in sheet.iter('time-number')]
            self.assertEqual(numbers, [('TOP', '12', 'TIME_TWELVE', 'true', '167'),
                                       ('BOTTOM', '8', 'TIME_EIGHT', 'true', '167')] * 2)
            self.assertEqual(sheet.find('measure/time-numbers').text, '100 101')
            index = z.read('book.xml').decode()
        self.assertIn('<last-time-rational num="12" den="8"/>', index)
        self.assertNotIn('num="7" den="8"', index)
        # Sheet 3's own 2/4 is its own business.
        self.assertIn('<last-time-rational num="2" den="4"/>', index)
        steps = [s.text for s in ET.fromstring(index).iter('steps')]
        self.assertEqual([s.endswith('LINKS') for s in steps], [True, True, True])
        self.assertTrue(all(' RHYTHMS' not in s and ' PAGE' not in s for s in steps))
        self.assertIn('software-version="5.11.0"', index)

    def test_only_sheets_from_the_corrected_one_on_are_redone(self):
        """An earlier sheet never reused the corrected meter, so its work stands."""
        original = self.book({1: sheet_xml([('3/4', .9, .9)]), 2: sheet_xml([('7/8', .176, .799)]), 3: sheet_xml([])})
        patched = meter.patch_book(original, self.path / 'patched.omr', {2: {'from': (7, 8), 'to': (12, 8)}})
        with zipfile.ZipFile(patched) as z:
            steps = [s.text for s in ET.fromstring(z.read('book.xml')).iter('steps')]
        self.assertTrue(steps[0].endswith('RHYTHMS PAGE'))
        self.assertTrue(steps[1].endswith('LINKS') and steps[2].endswith('LINKS'))

    def test_describe_names_the_page_and_both_readings(self):
        self.assertEqual(meter.describe({1: {'from': (7, 8), 'to': (12, 8)}}),
                         'page 1: read as 7/8, printed 12/8')


class CorrectMeterTests(unittest.TestCase):
    """run.correct_meter: the corrected pass replaces the first only when it
    keeps at least as many notes, and nothing here can cost the first pass."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.mxl, self.omr = self.work / 'song.mxl', self.work / 'song.omr'
        write_book(self.omr, {1: sheet_xml([('7/8', .176, .799)])})
        self.mxl.write_bytes(b'')
        self.log = []

    def correct(self, corrections, counts=None, rerun=None):
        counts = counts or {}

        def count(path):
            return counts.get(Path(path).parent.name, counts.get('base'))

        def default_rerun(book, out_dir):
            mxl = Path(out_dir) / 'song.mxl'
            mxl.write_bytes(b'')
            return mxl, Path(book)
        with patch.object(meter, 'meter_corrections', return_value=corrections), \
             patch.object(run, 'rerun_book', side_effect=rerun or default_rerun) as self.rerun, \
             patch.object(run, 'exported_note_count', side_effect=count):
            return run.correct_meter(self.work / 'song.pdf', self.work, self.mxl, self.omr, 1, self.log.append)

    def test_nothing_to_correct_changes_nothing(self):
        self.assertEqual(self.correct({}), (self.mxl, self.omr))
        self.assertEqual(self.rerun.call_count, 0)
        self.assertEqual(self.log, [])

    def test_a_corrected_pass_that_keeps_more_notes_replaces_the_first(self):
        mxl, omr = self.correct({1: {'from': (7, 8), 'to': (12, 8)}}, {'base': 733, '_meter': 1195})
        self.assertEqual(Path(omr).parent, self.work / '_meter')
        self.assertEqual(Path(mxl).parent, self.work / '_meter')
        self.assertTrue(Path(omr).exists())
        with zipfile.ZipFile(omr) as z:
            self.assertIn('time-rational="12/8"', z.read('sheet#1/sheet#1.xml').decode())
        # The first pass is untouched for the page re-reads to compare against.
        with zipfile.ZipFile(self.omr) as z:
            self.assertIn('time-rational="7/8"', z.read('sheet#1/sheet#1.xml').decode())
        self.assertIn('page 1: read as 7/8, printed 12/8', self.log[0])
        self.assertIn('1195 notes in the export, up from 733', self.log[-1])

    def test_a_corrected_pass_that_loses_notes_is_discarded(self):
        self.assertEqual(self.correct({1: {'from': (7, 8), 'to': (12, 8)}}, {'base': 733, '_meter': 700}),
                         (self.mxl, self.omr))
        self.assertIn('fewer notes', self.log[-1])

    def test_a_failed_rerun_keeps_the_first_pass(self):
        def crash(book, out_dir):
            raise RuntimeError('Audiveris did not produce expected output')
        self.assertEqual(self.correct({1: {'from': (7, 8), 'to': (12, 8)}}, rerun=crash), (self.mxl, self.omr))
        self.assertIn('keeping the first reading', self.log[-1])

    def test_a_failed_check_keeps_the_first_pass(self):
        with patch.object(meter, 'meter_corrections', side_effect=OSError('no such file')):
            self.assertEqual(run.correct_meter(self.work / 'song.pdf', self.work, self.mxl, self.omr, 1, self.log.append),
                             (self.mxl, self.omr))
        self.assertIn('skipped', self.log[-1])


if __name__ == '__main__':
    unittest.main()
