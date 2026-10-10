"""Correcting a time signature Audiveris misread, in Audiveris's own book.

Audiveris does not read a time signature's digits; it classifies the ink as a
shape, and a two-digit numeral is a shape it barely knows. On a MuseScore
engraving of Chopin's Op. 9 No. 2 the "12" of its 12/8 came out as TIME_SEVEN
at grade 0.18, accepted because a header is expected to hold a meter (its
minimum grade for one is 0.1, and any shape in the classifier's top three is a
candidate), then frozen and reused by every later page. Every bar then held
more music than the 7/8 it expected, so its RHYTHMS step flagged all 37 bars
abnormal and dropped the chords past the limit: 1241 noteheads found, 733
exported. Its duration arithmetic was right throughout - only the expectation
was wrong.

The engraving itself says 12/8, in its text layer (pdf_marks.time_signatures
reads it). So, where the two disagree and Audiveris's own digit grade is weak,
the book file - a zip of XML - is rewritten with the printed meter and the
RHYTHMS and PAGE steps are struck from the affected sheets' done-list.
Audiveris, run again on the book, redoes only those steps: seconds, not the
minutes of a fresh read. Measured on that nocturne: 733 -> 1195 of 1241 notes
exported; the rest sit in an unmetered "senza tempo" cadenza.

This only ever edits the meter Audiveris already found; a signature it missed
outright is not invented here.
"""
import re
import shutil
import xml.etree.ElementTree as ET
import zipfile
from fractions import Fraction
from pathlib import Path

import pymupdf

import pdf_marks

# The numerals Audiveris's classifier can name (ShapeSet.PartialTimes), and the
# denominators its time builder pairs them with. A printed meter outside these
# cannot be written into the book, so it is left alone.
NUMERAL_SHAPES = {2: 'TIME_TWO', 3: 'TIME_THREE', 4: 'TIME_FOUR', 5: 'TIME_FIVE', 6: 'TIME_SIX',
                  7: 'TIME_SEVEN', 8: 'TIME_EIGHT', 9: 'TIME_NINE', 12: 'TIME_TWELVE', 16: 'TIME_SIXTEEN'}
DENOMINATORS = (2, 4, 8, 16)

# Below this, the weakest digit of a signature is not evidence against the
# engraving's own text. The misread "12" graded 0.18; correctly read single
# digits on the same score graded 0.75-0.95.
GOOD_DIGIT_GRADE = 0.8

# The steps a corrected meter invalidates. RHYTHMS turns the meter into bar
# expectations and voices; PAGE ties the sheets' pages together after it.
RHYTHM_STEPS = ('RHYTHMS', 'PAGE')


def _sheet_xml(omr_path, sheet):
    with zipfile.ZipFile(omr_path) as z:
        try:
            with z.open(f'sheet#{sheet}/sheet#{sheet}.xml') as f:
                return ET.parse(f).getroot()
        except KeyError:
            return ET.Element('sheet')


def book_meters(omr_path, sheet):
    """The time signatures Audiveris read on a sheet, with the grade of their
    weakest digit: [{num, den, grade, staff}]. The composite pair averages its
    digits (0.70 for a 0.18 and a 0.80), so the verdict is the digit's."""
    root = _sheet_xml(omr_path, sheet)
    digits = []
    for number in root.iter('time-number'):
        bounds = number.find('bounds')
        if number.get('staff') and bounds is not None and number.get('grade') is not None:
            digits.append((int(number.get('staff')), float(bounds.get('x')), float(number.get('grade'))))
    meters = []
    for pair in root.iter('time-pair'):
        bounds, rational = pair.find('bounds'), pair.get('time-rational') or ''
        if not pair.get('staff') or bounds is None or '/' not in rational:
            continue
        try:
            num, den = (int(v) for v in rational.split('/', 1))
        except ValueError:
            continue
        if den <= 0:
            continue
        staff, x, width = int(pair.get('staff')), float(bounds.get('x')), float(bounds.get('w', '0'))
        grades = [g for s, dx, g in digits if s == staff and x - 2 <= dx <= x + width + 2]
        meters.append({'num': num, 'den': den, 'staff': staff,
                       'grade': min(grades, default=float(pair.get('grade', '1')))})
    return meters


def printed_meters(pdf_path, page):
    """The meters the engraving's own text layer states on a page, as (num, den)
    pairs in document order; [] for a scan, which has no text layer."""
    with pymupdf.open(pdf_path) as pdf:
        if not 1 <= page <= len(pdf):
            return []
        marks = pdf_marks.time_signatures(pdf[page - 1])
    return [(m['num'], m['den']) for m in sorted(marks, key=lambda m: (m['y'], m['x']))
            if m.get('num') and m.get('den')]


def meter_corrections(pdf_path, omr_path, num_pages):
    """Which sheets to rewrite, and to what: {sheet: {'from': (n, d), 'to': (n, d)}}.

    A sheet is corrected when every signature Audiveris read on it says one
    meter, the engraving's text layer states one (other) meter on that page,
    and Audiveris's weakest digit for it is poor. A page stating several meters
    is left alone: which of them a given signature is cannot be told from the
    counts, and a wrong guess would do what the misread did.
    """
    corrections = {}
    for sheet in range(1, num_pages + 1):
        read = book_meters(omr_path, sheet)
        if not read:
            continue
        read_values = {(m['num'], m['den']) for m in read}
        printed = set(printed_meters(pdf_path, sheet))
        if len(read_values) != 1 or len(printed) != 1:
            continue
        (value,), (printed_value,) = read_values, printed
        if value == printed_value or Fraction(*value) == Fraction(*printed_value):
            continue
        num, den = printed_value
        if num not in NUMERAL_SHAPES or den not in DENOMINATORS:
            continue
        if min(m['grade'] for m in read) >= GOOD_DIGIT_GRADE:
            continue
        corrections[sheet] = {'from': value, 'to': printed_value}
    return corrections


def _rewrite_sheet(text, correction):
    (old_num, old_den), (num, den) = correction['from'], correction['to']
    text = text.replace(f'time-rational="{old_num}/{old_den}"', f'time-rational="{num}/{den}"')

    def numeral(match):
        side = match.group('side')
        value = num if side == 'TOP' else den
        attrs = match.group('attrs')
        attrs = re.sub(r'value="[^"]*"', f'value="{value}"', attrs)
        attrs = re.sub(r'shape="[^"]*"', f'shape="{NUMERAL_SHAPES[value]}"', attrs)
        return f'<time-number{attrs}'

    # Audiveris's own number elements, both digits of every pair on the sheet
    # (the sheet carries one meter, by construction of meter_corrections).
    return re.sub(r'<time-number(?P<attrs>(?:\s+[\w-]+="[^"]*")*?\s+side="(?P<side>TOP|BOTTOM)"(?:\s+[\w-]+="[^"]*")*)',
                  numeral, text)


def _rewrite_book_index(text, corrections):
    """Strike the rhythm steps from every corrected sheet and every sheet after
    it - a later sheet without a signature of its own reuses the last one read
    - and restate the corrected meter where the index carries it."""
    first = min(corrections)
    sheets = re.split(r'(?=<sheet number=")', text)
    out = []
    for block in sheets:
        match = re.match(r'<sheet number="(\d+)"', block)
        if match:
            number = int(match.group(1))
            if number >= first:
                block = re.sub(r'(<steps>[^<]*?)\s+' + r'\s+'.join(RHYTHM_STEPS) + r'</steps>',
                               r'\1</steps>', block)
            correction = corrections.get(number)
            if correction:
                (old_num, old_den), (num, den) = correction['from'], correction['to']
                block = block.replace(f'<last-time-rational num="{old_num}" den="{old_den}"/>',
                                      f'<last-time-rational num="{num}" den="{den}"/>')
        out.append(block)
    return ''.join(out)


def patch_book(src, dst, corrections):
    """Write a copy of the book at ``dst`` with each corrected sheet's meter
    rewritten and its rhythm steps left to redo. Everything else - the other
    sheets, the binarized pictures - is copied byte for byte."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == 'book.xml':
                data = _rewrite_book_index(data.decode('utf-8'), corrections).encode('utf-8')
            else:
                match = re.fullmatch(r'sheet#(\d+)/sheet#\1\.xml', item.filename)
                if match and int(match.group(1)) in corrections:
                    data = _rewrite_sheet(data.decode('utf-8'), corrections[int(match.group(1))]).encode('utf-8')
            zout.writestr(item, data)
    return Path(dst)


def describe(corrections):
    """One line per corrected sheet, for the log."""
    return '; '.join(f'page {sheet}: read as {c["from"][0]}/{c["from"][1]}, printed {c["to"][0]}/{c["to"][1]}'
                     for sheet, c in sorted(corrections.items()))


def corrected_book_dir(work_dir):
    return Path(work_dir) / '_meter'


def prepare_corrected_book(omr_path, work_dir, corrections):
    """The patched copy of the book, in its own folder so the original pass
    stays intact for comparison and for the page re-reads that follow."""
    out_dir = corrected_book_dir(work_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    return patch_book(omr_path, out_dir / Path(omr_path).name, corrections), out_dir
