"""Hand-authored musical ground truth; no OMR engine or network required."""
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import MagicMock, patch

import pymupdf
import annotate
import audiveris_heads
import musicxml
import timeline
import pdf_marks
import run
from score_notes import resolve_score_notes


ATTR = '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'


def note(step='C', octave=4, duration=1, extra='', alter=0, voice=1, staff=1):
    return f'<note>{extra}<pitch><step>{step}</step><alter>{alter}</alter><octave>{octave}</octave></pitch><duration>{duration}</duration><voice>{voice}</voice><staff>{staff}</staff></note>'


def measure(content, number=1, attrs=''):
    return f'<measure number="{number}" {attrs}>{content}</measure>'


def mxl(path, body):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>')
        z.writestr('score.xml', '<score-partwise><part id="P1">' + body + '</part></score-partwise>')
    return path


def omr(path, pages, place_voices=True):
    """Two staves per page, one system, with explicit voice/slot identities.

    Each page contains measures of heads: (pitch slot, onset, staff, alter).
    Optional key events are injected by the tests as actual OMR objects.

    ``place_voices=False`` writes the heads without the voice/slot entries that
    give their chords a time offset - Audiveris's RHYTHMS step failing, which
    detects every notehead and still drops it from the exported score.
    """
    with zipfile.ZipFile(path, 'w') as z:
        for page_number, ms in enumerate(pages, 1):
            root = ET.Element('sheet')
            ET.SubElement(root, 'picture', width='200', height='300')
            system = ET.SubElement(root, 'system')
            part = ET.SubElement(system, 'part', id='1')
            sig = ET.SubElement(system, 'sig')
            for staff_id in (1, 2):
                s = ET.SubElement(part, 'staff', id=str(staff_id), left='0', right='200')
                lines = ET.SubElement(s, 'lines')
                for y in range(60 + (staff_id - 1) * 100, 101 + (staff_id - 1) * 100, 10):
                    line = ET.SubElement(lines, 'line')
                    ET.SubElement(line, 'point', x='0', y=str(y))
                clef = ET.SubElement(sig, 'clef', id=f'clef{staff_id}', staff=str(staff_id), kind='TREBLE')
                ET.SubElement(clef, 'bounds', x='0', y='50', w='10', h='30')
            for local, heads in enumerate(ms):
                stack = ET.SubElement(system, 'stack', id=str(local + 1), left=str(local * 100), right=str((local + 1) * 100))
                m = ET.SubElement(part, 'measure', id=str(local + 1))
                voice_els = {}
                ids = []
                for i, (pitch, onset, staff, alter) in enumerate(heads):
                    hid, cid = f'h{local}-{i}', f'c{local}-{i}'
                    ids.append(cid)
                    x = local * 100 + 20 + onset * 15
                    head = ET.SubElement(sig, 'head', id=hid, pitch=str(pitch), staff=str(staff), shape='NOTEHEAD_BLACK', grade='.9')
                    ET.SubElement(head, 'bounds', x=str(x), y=str(78 + (staff - 1) * 100 + pitch * 5), w='8', h='6')
                    ET.SubElement(sig, 'head-chord', id=cid, staff=str(staff))
                    rel = ET.SubElement(sig, 'relation', source=cid, target=hid)
                    ET.SubElement(rel, 'containment')
                    if alter:
                        ET.SubElement(sig, 'alter', id='a' + hid, shape=alter)
                        rel = ET.SubElement(sig, 'relation', source='a' + hid, target=hid)
                        ET.SubElement(rel, 'alter-head')
                    slot = str(i + 1)
                    ET.SubElement(stack, 'slot', id=slot, **{'time-offset': str(onset / 4)})
                    if place_voices:
                        if staff not in voice_els:
                            voice_els[staff] = ET.SubElement(ET.SubElement(m, 'voice', id=str(staff)), 'slots')
                        entry = ET.SubElement(voice_els[staff], 'entry')
                        ET.SubElement(entry, 'key').text = slot
                        ET.SubElement(entry, 'value', chord=cid, status='BEGIN')
                ET.SubElement(m, 'head-chords').text = ' '.join(ids)
            z.writestr(f'sheet#{page_number}/sheet#{page_number}.xml', ET.tostring(root))
    return path


class AccuracyTests(unittest.TestCase):
    def test_structurally_incomplete_page_is_retried_even_when_not_sparse(self):
        score = mxl(self.path / 'score.mxl', measure(ATTR + ''.join(note() for _ in range(10))))
        book = omr(self.path / 'score.omr', [[[(6, i / 2, 1, None) for i in range(20)]]])
        counts, pages = run.find_sparse_pages(book, 1, score)
        self.assertEqual(counts, {1: 20})
        self.assertEqual(pages, [1])

    def test_empty_exported_measure_is_retried(self):
        score = mxl(self.path / 'score.mxl',
                    measure(ATTR + ''.join(note() for _ in range(20)), 1) + measure('', 2))
        book = omr(self.path / 'score.omr', [[[(6, i / 2, 1, None) for i in range(20)]]])
        self.assertEqual(run.find_sparse_pages(book, 1, score)[1], [1])

    @patch('run.vector_notehead_counts', return_value={1: 20, 2: 100})
    def test_empty_exported_measure_outranks_a_lower_quality_page(self, _counts):
        score = mxl(self.path / 'score.mxl',
                    measure(ATTR + ''.join(note() for _ in range(20)), 1) +
                    measure('', 2) +
                    '<measure number="3"><print new-page="yes"/>' + ''.join(note() for _ in range(20)) +
                    '</measure>')
        book = omr(self.path / 'score.omr', [
            [[(6, i / 2, 1, None) for i in range(20)]],
            [[(6, i / 2, 1, None) for i in range(20)]],
        ], place_voices=False)
        self.assertEqual(run.find_sparse_pages(book, 2, score, self.path / 'score.pdf')[1], [1, 2])

    def test_a_full_measure_rest_is_not_mistaken_for_an_export_hole(self):
        score = mxl(self.path / 'score.mxl',
                    measure(ATTR + ''.join(note() for _ in range(20)), 1) +
                    measure('<note><rest/><duration>4</duration></note>', 2))
        book = omr(self.path / 'score.omr', [[[(6, i / 2, 1, None) for i in range(20)]]])
        self.assertEqual(run.find_sparse_pages(book, 1, score)[1], [])

    @patch('run.vector_notehead_counts', return_value={1: 100})
    def test_vector_pdf_deficit_is_retried_even_when_omr_agrees_with_export(self, _counts):
        score = mxl(self.path / 'score.mxl', measure(ATTR + ''.join(note() for _ in range(50))))
        book = omr(self.path / 'score.omr', [[[(6, i / 2, 1, None) for i in range(50)]]])
        self.assertEqual(run.find_sparse_pages(book, 1, score, self.path / 'score.pdf')[1], [1])

    def test_retry_accepts_better_structure_with_the_same_head_count(self):
        original = self.path / 'score.pdf'
        work = self.path / 'work'
        work.mkdir()
        retry_mxl, retry_omr = self.path / 'retry.mxl', self.path / 'retry.omr'
        with patch('run.run_audiveris', return_value=(retry_mxl, retry_omr)), \
             patch('run.load_sheet_heads', return_value=[{}] * 208), \
             patch('run.placed_head_ratio', return_value=(208, 208)), \
             patch('run.recognition_quality', side_effect=[.73, .83]):
            overrides = run.retry_sparse_pages(original, work, {1: 208}, [1])
        self.assertEqual(overrides[1], {'omr': str(retry_omr), 'mxl': str(retry_mxl)})

    def time_omr(self, name, pairs):
        """A sheet carrying only time signatures: (rational, top grade, bottom grade)."""
        path = self.path / name
        with zipfile.ZipFile(path, 'w') as z:
            root = ET.Element('sheet')
            ET.SubElement(root, 'picture', width='200', height='300')
            sig = ET.SubElement(root, 'sig')
            for staff, (rational, top, bottom) in enumerate(pairs, 1):
                for side, value, grade in (('TOP', rational.split('/')[0], top),
                                           ('BOTTOM', rational.split('/')[1], bottom)):
                    number = ET.SubElement(sig, 'time-number', side=side, value=value,
                                           grade=str(grade), staff=str(staff))
                    ET.SubElement(number, 'bounds', x='320', y='472', w='34', h='42')
                pair = ET.SubElement(sig, 'time-pair', **{'time-rational': rational},
                                     grade='.7', staff=str(staff))
                ET.SubElement(pair, 'bounds', x='320', y='472', w='38', h='85')
            z.writestr('sheet#1/sheet#1.xml', ET.tostring(root))
        return path

    def test_a_misread_time_signature_digit_is_reported_as_unreliable(self):
        """A printed 12/8 collapsed into 7/8: the "7" grades far below its "8"."""
        book = self.time_omr('meter.omr', [('7/8', .176, .799)])
        signature, = audiveris_heads.load_time_signatures(book, 1)
        self.assertEqual(signature['beats'], 3.5)
        self.assertEqual(signature['grade'], .176)
        self.assertTrue(signature['low_confidence'])

    def test_a_confidently_read_time_signature_is_trusted(self):
        book = self.time_omr('good.omr', [('2/4', .786, .769)])
        signature, = audiveris_heads.load_time_signatures(book, 1)
        self.assertEqual(signature['beats'], 2.0)
        self.assertFalse(signature['low_confidence'])

    def test_the_verdict_comes_from_the_weakest_digit_not_the_pair(self):
        """The composite pair averages its digits and grades .7 either way."""
        book = self.time_omr('mixed.omr', [('7/8', .176, .799), ('6/8', .80, .79)])
        weak, strong = audiveris_heads.load_time_signatures(book, 1)
        self.assertTrue(weak['low_confidence'])
        self.assertFalse(strong['low_confidence'])

    def test_detected_heads_never_placed_in_a_voice_are_flagged(self):
        """The failure a head count cannot see: every notehead found, none playable."""
        heads = [[[(6, i / 2, 1 + i % 2, None) for i in range(60)]]]
        placed = omr(self.path / 'placed.omr', heads)
        dropped = omr(self.path / 'dropped.omr', heads, place_voices=False)
        self.assertEqual(run.placed_head_ratio(placed, 1), (60, 60))
        self.assertEqual(run.placed_head_ratio(dropped, 1), (60, 0))
        self.assertEqual(run.find_sparse_pages(dropped, 1)[1], [1])
        self.assertEqual(run.find_sparse_pages(placed, 1)[1], [])

    def test_a_page_too_small_to_judge_is_not_reprocessed(self):
        """At 20 heads a single unplaced chord already reads as 75%; that is noise."""
        few = omr(self.path / 'few.omr', [[[(6, i / 2, 1, None) for i in range(30)]]],
                  place_voices=False)
        self.assertEqual(run.placed_head_ratio(few, 1), (30, 0))
        self.assertEqual(run.find_sparse_pages(few, 1)[1], [])

    def test_reprocessing_tries_isolation_then_tuplets_and_skips_dpi(self):
        """Normal engraving: a higher DPI is a measured no-op, so it is never queued."""
        with patch('run.staff_interline_pt', return_value=5.0):
            variants = list(run.retry_variants(self.path / 'score.pdf', 3))
        self.assertEqual([label for label, _ in variants],
                         ['the page on its own', 'inferred tuplets'])
        self.assertEqual([options for _, options in variants],
                         [{'sheets': [3]},
                          {'sheets': [3], 'switches': {'implicitTuplets': True}}])

    def test_reprocessing_keeps_a_user_selected_dpi(self):
        with patch('run.staff_interline_pt', return_value=5.0):
            variants = list(run.retry_variants(self.path / 'score.pdf', 3, base_dpi=500))
        self.assertEqual(variants, [
            ('the page on its own', {'sheets': [3], 'dpi': 500}),
            ('inferred tuplets', {'sheets': [3], 'dpi': 500,
                                  'switches': {'implicitTuplets': True}}),
        ])

    def blank_pdf(self, name, pages=2, width=595, height=842):
        path = self.path / name
        with pymupdf.open() as doc:
            for _ in range(pages):
                doc.new_page(width=width, height=height)
            doc.save(path)
        return path

    def test_recognition_time_is_estimated_from_page_area(self):
        """Fitted over 35 scores: cost tracks rasterized area and the notehead
        count falls out of the fit entirely."""
        a4 = self.blank_pdf('a4.pdf', pages=1)
        # A4 at 300 DPI is 2479x3508 = 8.7 megapixels.
        self.assertAlmostEqual(run.estimated_seconds(a4), 8.7 * run.SECONDS_PER_MEGAPIXEL, delta=.5)
        self.assertAlmostEqual(run.estimated_seconds(self.blank_pdf('two.pdf', pages=2)),
                               2 * run.estimated_seconds(a4), delta=.5)
        # Doubling the resolution quadruples the pixels, and the cost with them.
        self.assertAlmostEqual(run.estimated_seconds(a4, 600),
                               4 * run.estimated_seconds(a4), delta=.5)

    def test_a_single_page_reread_carries_its_own_setup_cost(self):
        """One page on its own pays for starting the engine and opening the
        book that a whole-book pass spreads across every page."""
        pdf = self.blank_pdf('one.pdf', pages=1)
        share = run.estimated_seconds(pdf)
        alone = run.estimated_seconds(pdf, pages=[1], single_page=True)
        self.assertAlmostEqual(alone / share, run.RETRY_PASS_OVERHEAD, places=3)

    def test_reread_estimate_is_a_range_because_the_ladder_stops_early(self):
        pdf = self.blank_pdf('sparse.pdf', pages=4)
        low, high = run.estimated_retry_seconds(pdf, [1, 2], poor_recall_pages=[1])
        self.assertLess(low, high)
        # A page short of noteheads leads with resolution, so it costs more
        # than one whose heads were found but never voiced.
        detection, = run.estimated_retry_seconds(pdf, [1], poor_recall_pages=[1])[:1]
        placement, = run.estimated_retry_seconds(pdf, [1])[:1]
        self.assertGreater(detection, placement)

    def test_reread_estimate_respects_the_page_cap(self):
        """Only the worst pages are re-read, so only those are charged for."""
        pdf = self.blank_pdf('many.pdf', pages=8)
        capped = run.estimated_retry_seconds(pdf, list(range(1, 9)))
        exactly = run.estimated_retry_seconds(pdf, list(range(1, run.MAX_RETRY_PAGES + 1)))
        self.assertEqual(capped, exactly)

    def test_durations_are_described_the_way_someone_waiting_thinks(self):
        self.assertEqual(run.describe_duration(20), 'less than a minute')
        self.assertEqual(run.describe_duration(60), 'about a minute')
        self.assertEqual(run.describe_duration(167), 'about 3 minutes')
        self.assertEqual(run.describe_duration(260, 556), '4-9 minutes')
        # A range that rounds to one number is not shown as a range.
        self.assertEqual(run.describe_duration(400, 420), 'about 7 minutes')

    def test_dense_engraving_escalates_dpi_despite_healthy_staves(self):
        """The failure the interline test cannot see: staves of an entirely
        normal size whose notes are packed too tightly to separate. A Liszt
        page printing 738 noteheads yielded 74 at 300 DPI and 715 at 600.
        """
        with patch('run.staff_interline_pt', return_value=5.0):
            healthy = list(run.retry_variants(self.path / 'score.pdf', 7, None, False))
            dense = list(run.retry_variants(self.path / 'score.pdf', 7, None, True))
        self.assertEqual(len(healthy), 2)
        self.assertEqual(len(dense), 4)
        # Resolution leads when noteheads are missing outright - the cheap
        # passes cannot recover a notehead that was never detected, and running
        # them first only delays the one attempt that can.
        self.assertTrue(all(v['dpi'] == run.RETRY_DPI for _, v in dense[:2]))
        self.assertFalse(any('dpi' in v for _, v in dense[2:]))

    def test_small_engraving_still_escalates_to_a_higher_dpi(self):
        with patch('run.staff_interline_pt', return_value=3.0):
            variants = list(run.retry_variants(self.path / 'score.pdf', 1))
        self.assertEqual(len(variants), 4)
        self.assertTrue(all(v['dpi'] == run.RETRY_DPI for _, v in variants[2:]))

    def test_a_scan_with_no_vector_staff_lines_still_escalates(self):
        with patch('run.staff_interline_pt', return_value=None):
            self.assertEqual(len(list(run.retry_variants(self.path / 'scan.pdf', 1))), 4)

    def test_a_reread_that_finds_more_heads_but_plays_fewer_is_rejected(self):
        """More detections are not more music; this is the trap being avoided."""
        before = {'count': 200, 'placed': .95, 'longest_bar': 6.0, 'quality': .8}
        noisier = {'count': 260, 'placed': .60, 'longest_bar': 6.0, 'quality': .8}
        self.assertFalse(run._recovered_more_music(noisier, before))
        recovered = {'count': 200, 'placed': .99, 'longest_bar': 6.0, 'quality': .8}
        self.assertTrue(run._recovered_more_music(recovered, before))

    def test_a_reread_that_only_adds_unverified_notes_is_rejected(self):
        """The retry must not turn missing notes into a larger amber backlog."""
        before = {'count': 297, 'placed': .81, 'longest_bar': 5.0, 'quality': .80,
                  'positioned': 226, 'unverified': 59}
        amber_only = {'count': 297, 'placed': .87, 'longest_bar': 5.5, 'quality': .82,
                      'positioned': 226, 'unverified': 76}
        self.assertFalse(run._recovered_more_music(amber_only, before))

    def test_a_reread_can_add_a_small_number_of_unverified_notes_with_positions(self):
        before = {'count': 200, 'placed': .80, 'longest_bar': 4.0, 'quality': .80,
                  'positioned': 180, 'unverified': 20}
        recovered = {'count': 200, 'placed': .90, 'longest_bar': 4.5, 'quality': .84,
                     'positioned': 188, 'unverified': 25}
        self.assertTrue(run._recovered_more_music(recovered, before))

    def test_a_retry_without_alignment_cannot_replace_an_aligned_page(self):
        before = {'count': 200, 'placed': .80, 'longest_bar': 4.0, 'quality': .80,
                  'positioned': 180, 'unverified': 20}
        unaligned = {'count': 200, 'placed': .95, 'longest_bar': 4.0, 'quality': .90}
        self.assertFalse(run._recovered_more_music(unaligned, before))

    def test_a_reread_that_loses_noteheads_is_rejected_whatever_else_improved(self):
        before = {'count': 200, 'placed': .70, 'longest_bar': 6.0, 'quality': .70}
        lossy = {'count': 150, 'placed': 1.0, 'longest_bar': 6.0, 'quality': .95}
        self.assertFalse(run._recovered_more_music(lossy, before))

    def test_a_reread_that_wrecks_the_bar_lengths_is_rejected(self):
        """Observed for real: 86% placed to 100%, with 30- and 45-beat measures
        in a score whose bars hold 6. Music adrift is worse than music missing."""
        before = {'count': 214, 'placed': .86, 'longest_bar': 6.0, 'quality': .80}
        unbarred = {'count': 214, 'placed': 1.0, 'longest_bar': 30.0, 'quality': .79}
        self.assertFalse(run._recovered_more_music(unbarred, before))
        # The same recovery with the bar lengths intact is still accepted.
        sane = {'count': 214, 'placed': 1.0, 'longest_bar': 6.5, 'quality': .80}
        self.assertTrue(run._recovered_more_music(sane, before))

    def test_a_bar_that_grows_within_reason_is_still_accepted(self):
        """A re-read reinterprets the page, so bars move; good ones reached 1.5x."""
        before = {'count': 208, 'placed': .69, 'longest_bar': 6.0, 'quality': .80}
        stretched = {'count': 208, 'placed': .91, 'longest_bar': 9.0, 'quality': .83}
        self.assertTrue(run._recovered_more_music(stretched, before))

    def test_an_isolated_page_with_no_known_meter_is_not_blocked(self):
        """A page re-read alone never sees the time signature printed on page 1,
        so the guard compares written bar lengths, which survive that loss."""
        before = {'count': 271, 'placed': .81, 'longest_bar': 6.0, 'quality': .78}
        better = {'count': 271, 'placed': .94, 'longest_bar': 6.0, 'quality': .84}
        self.assertTrue(run._recovered_more_music(better, before))

    def test_reprocessing_stops_once_the_page_is_recovered(self):
        original, work = self.path / 'score.pdf', self.path / 'stopwork'
        work.mkdir()
        retry = (self.path / 'r.mxl', self.path / 'r.omr')
        audiveris = MagicMock(return_value=retry)
        with patch('run.run_audiveris', audiveris), \
             patch('run.staff_interline_pt', return_value=5.0), \
             patch('run.placed_head_ratio', side_effect=[(208, 150), (208, 208)]), \
             patch('run.recognition_quality', side_effect=[.70, .90]):
            overrides = run.retry_sparse_pages(original, work, {1: 208}, [1])
        self.assertEqual(overrides[1]['omr'], str(retry[1]))
        # Isolation alone recovered the page, so the tuplet pass never runs.
        self.assertEqual(audiveris.call_count, 1)
        self.assertEqual(audiveris.call_args.kwargs, {'sheets': [1]})

    def tail_fixture(self):
        body = ATTR.replace('<beats>4</beats>', '<beats>7</beats>').replace('<beat-type>4', '<beat-type>8')
        body += ''.join(note(s, 5, .5, alter=-1 if s in 'BE' else 0) for s in 'FEFBFEFEF')
        body += '<backup><duration>4.5</duration></backup>' + note('C', 4, 6, staff=2)
        ns, ms = self.parse(measure(body))
        heads = []
        for i, n in enumerate([n for n in ns if n['staff'] == 1]):
            n['head_id'] = str(i)
            heads.append(dict(source_id=str(i), role=0, cx=i * 10))
        for i, d in enumerate([-7, -4, -3], 9):
            heads.append(dict(source_id=str(i), role=0, cx=i * 10, onset=None, voice=None,
                              confidence=.95, shape='NOTEHEAD_BLACK', diatonic=d,
                              alter=-1 if d != -4 else 0, pdf_octave_shift=1,
                              bbox_pt=[i * 10, 0, i * 10 + 5, 5]))
        return ns, ms[0], heads, {str(i) for i in range(9)}

    def test_missing_three_eighth_note_tail_is_recovered(self):
        ns, m, heads, used = self.tail_fixture()
        self.assertEqual(timeline._recover_measure_tail(m, ns, heads, used), 3)
        self.assertEqual([(n['midi'], n['start_beat_in_measure'], n['duration_beats']) for n in ns[-3:]],
                         [(94, 4.5, .5), (89, 5, .5), (87, 5.5, .5)])
        self.assertEqual(m['length_beats'], 6)
        self.assertTrue(m['warnings'])

    def test_tail_recovery_rejects_ambiguous_evidence(self):
        for case in ['spacing', 'confidence', 'rest', 'incomplete', 'polyphony']:
            with self.subTest(case=case):
                ns, m, heads, used = self.tail_fixture()
                if case == 'spacing': heads[-1]['cx'] += 8
                if case == 'confidence': heads[-1]['confidence'] = .4
                if case == 'rest': m['rests'] = [dict(staff=1, start=4.5, duration=1.5)]
                if case == 'incomplete': heads.pop()
                if case == 'polyphony': ns[1]['voice'] = '2'; ns[-2]['voice'] = '2'
                self.assertEqual(timeline._recover_measure_tail(m, ns, heads, used), 0)

    def test_tail_recovery_preserves_chord_onsets(self):
        ns, m, heads, used = self.tail_fixture()
        heads[-3]['chord_id'] = 'chord'
        heads.append(dict(heads[-3], source_id='lower', diatonic=0))
        self.assertEqual(timeline._recover_measure_tail(m, ns, heads, used), 4)
        self.assertEqual(sorted(n['start_beat_in_measure'] for n in ns[-4:]), [4.5, 4.5, 5, 5.5])

    def test_pdf_meter_reads_twelve_eight_and_common_time(self):
        chars = [{'c': chr(0xE081), 'origin': (10, 20)},
                 {'c': chr(0xE082), 'origin': (16, 20)},
                 {'c': chr(0xE088), 'origin': (13, 30)},
                 {'c': chr(0xE08A), 'origin': (100, 70)}]
        class Page:
            def get_text(self, kind):
                return {'blocks': [{'lines': [{'spans': [{'chars': chars}]}]}]}
        self.assertEqual(sorted(m['beats'] for m in pdf_marks.time_signatures(Page())), [4, 6])

    @staticmethod
    def _page(*spans):
        class Page:
            def get_text(self, kind):
                return {'blocks': [{'lines': [{'spans': list(spans)}]}]}
        return Page()

    def test_arpeggio_tiles_in_one_column_are_a_single_sign(self):
        """An engraver tiles one wiggle glyph down the height of the chord."""
        column = {'font': 'Leland', 'chars': [{'c': chr(0xEAA9), 'origin': (100, 200), 'bbox': (0, 0, 80, 4)}, {'c': chr(0xEAA9), 'origin': (100, 204.4), 'bbox': (0, 0, 80, 4)}, {'c': chr(0xEAA9), 'origin': (100, 208.8), 'bbox': (0, 0, 80, 4)}, {'c': chr(0xEAA9), 'origin': (100, 213.2), 'bbox': (0, 0, 80, 4)}, {'c': chr(0xEAA9), 'origin': (100, 217.6), 'bbox': (0, 0, 80, 4)}]}
        signs = pdf_marks.arpeggio_signs(self._page(column))
        self.assertEqual(len(signs), 1)
        x, top, bottom = signs[0]
        self.assertAlmostEqual(x, 100)
        self.assertAlmostEqual(top, 200)
        self.assertAlmostEqual(bottom, 217.6)

    def test_a_gap_down_the_column_separates_two_arpeggios(self):
        """Two chords rolled at the same horizontal position in different
        systems are two signs, not one enormous one."""
        column = {'font': 'Leland', 'chars': [{'c': chr(0xEAA9), 'origin': (100, 200), 'bbox': (0, 0, 80, 4)}, {'c': chr(0xEAA9), 'origin': (100, 204.4), 'bbox': (0, 0, 80, 4)}, {'c': chr(0xEAA9), 'origin': (100, 208.8), 'bbox': (0, 0, 80, 4)}, {'c': chr(0xEAA9), 'origin': (100, 500), 'bbox': (0, 0, 80, 4)}, {'c': chr(0xEAA9), 'origin': (100, 504.4), 'bbox': (0, 0, 80, 4)}, {'c': chr(0xEAA9), 'origin': (100, 508.8), 'bbox': (0, 0, 80, 4)}]}
        signs = sorted(pdf_marks.arpeggio_signs(self._page(column)))
        self.assertEqual(len(signs), 2)
        self.assertAlmostEqual(signs[0][2], 208.8)
        self.assertAlmostEqual(signs[1][1], 500)

    def test_arpeggio_position_ignores_the_rotated_bounding_box(self):
        """These glyphs are placed rotated, so a 6pt-wide mark reports an
        80pt-wide box. Only the origin says where it actually sits."""
        column = {'font': 'Leland', 'chars': [{'c': chr(0xEAA9), 'origin': (100, 200), 'bbox': (60, 196, 140, 200)}, {'c': chr(0xEAA9), 'origin': (100, 204.4), 'bbox': (60, 196, 140, 200)}, {'c': chr(0xEAA9), 'origin': (100, 208.8), 'bbox': (60, 196, 140, 200)}]}
        x, _, _ = pdf_marks.arpeggio_signs(self._page(column))[0]
        self.assertAlmostEqual(x, 100)

    def arpeggio_chord(self, arpeggiate=False):
        # A three-note chord whose noteheads sit just right of a sign at x=100
        # spanning y 200-218, laid out as real engraving does.
        return [{'part': 0, 'start_beat_in_measure': 0.0, 'arpeggiate': arpeggiate,
                 'bbox_pt': [103.0, y - 2.6, 108.3, y + 2.7]} for y in (202, 210, 217)]

    def test_one_matching_notehead_rolls_the_whole_chord(self):
        """Half a rolled chord with the rest struck on the beat is a worse
        reading than not rolling it at all."""
        chord = self.arpeggio_chord()
        # Only the lowest notehead is squarely against the sign.
        chord[2]['bbox_pt'] = [103.0, 260.0, 108.3, 265.3]
        measure = {'warnings': []}
        rolled = timeline._apply_pdf_arpeggios(chord, [(100, 200, 218)], measure)
        self.assertEqual(rolled, 1)
        self.assertTrue(all(n['arpeggiate'] for n in chord))
        self.assertTrue(any('Arpeggio read from the printed PDF' in w
                            for w in measure['warnings']))

    def test_a_chord_with_no_sign_beside_it_is_left_alone(self):
        chord = self.arpeggio_chord()
        measure = {'warnings': []}
        # Same vertical span, but the sign is a system away horizontally.
        self.assertEqual(timeline._apply_pdf_arpeggios(chord, [(400, 200, 218)], measure), 0)
        self.assertFalse(any(n['arpeggiate'] for n in chord))
        self.assertEqual(measure['warnings'], [])

    def test_an_already_recognized_arpeggio_is_not_recounted(self):
        """Recovery only ever adds; it never re-reports what OMR already had."""
        chord = self.arpeggio_chord(arpeggiate=True)
        measure = {'warnings': []}
        self.assertEqual(timeline._apply_pdf_arpeggios(chord, [(100, 200, 218)], measure), 0)
        self.assertEqual(measure['warnings'], [])

    def test_a_note_with_no_position_cannot_be_matched_to_a_sign(self):
        """Recovery is capped by note positioning: no notehead, no evidence."""
        chord = [{'part': 0, 'start_beat_in_measure': 0.0, 'arpeggiate': False, 'bbox_pt': None}]
        self.assertEqual(timeline._apply_pdf_arpeggios(chord, [(100, 200, 218)], {'warnings': []}), 0)

    def test_pdf_meter_reads_ascii_digits_only_from_a_music_font(self):
        # MuseScore's own font maps time digits to plain ASCII rather than the
        # SMuFL private-use range. A font that also draws private-use music
        # glyphs is a notation font, so its digits count; prose digits do not.
        music = {'font': 'MScore', 'chars': [
            {'c': chr(0xE12D), 'origin': (40, 60)},
            {'c': '3', 'origin': (10, 20)},
            {'c': '4', 'origin': (10, 30)}]}
        prose = {'font': 'FreeSerif', 'chars': [
            {'c': '3', 'origin': (200, 20)},
            {'c': '4', 'origin': (200, 30)}]}
        self.assertEqual([m['beats'] for m in pdf_marks.time_signatures(self._page(music, prose))], [3])

    def test_pdf_meter_rejects_stacked_fingerings(self):
        # Two fingerings on a chord stack exactly like a time signature. "5
        # over 1" is a plausible fingering and an implausible meter.
        music = {'font': 'MScore', 'chars': [
            {'c': chr(0xE12D), 'origin': (40, 60)},
            {'c': '5', 'origin': (10, 20)},
            {'c': '1', 'origin': (10, 30)}]}
        self.assertEqual(pdf_marks.time_signatures(self._page(music)), [])

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def parse(self, body):
        return musicxml.load_score_notes(mxl(self.path / 'score.mxl', body))

    def resolved(self, pages):
        pdf, source = self.path / 'input.pdf', self.path / 'score.omr'
        with pymupdf.open() as d:
            for _ in pages:
                d.new_page(width=200, height=300)
            d.save(pdf)
        omr(source, pages)
        return resolve_score_notes(pdf, source, len(pages))

    def test_accidental_carry_and_barline_reset(self):
        r = self.resolved([[[ (3, 0, 1, 'SHARP'), (3, 1, 1, None)], [(3, 0, 1, None)]]])
        labels = annotate.records_from_resolved(r, style='ascii', octave=True)
        self.assertEqual([n['labels'][0] for n in labels], ['F#4', 'F#4', 'F4'])

    def test_natural_cancellation_and_octave_separation(self):
        r = self.resolved([[[ (3, 0, 1, 'SHARP'), (-4, 1, 1, None), (3, 2, 1, 'NATURAL'), (3, 3, 1, None)]]])
        self.assertEqual([n['midi'] for n in sorted(r['notes'], key=lambda n: n['cx'])], [66, 77, 65, 65])

    def test_key_events_do_not_sum_and_preserve_cancellation(self):
        root = ET.fromstring('<sheet><key staff="1" fifths="1"><bounds x="0"/></key><key staff="1" fifths="2"><bounds x="70"/></key><key staff="1" fifths="0"><bounds x="140"/></key></sheet>')
        with patch.object(audiveris_heads, '_parse_sheet', return_value=root):
            self.assertEqual(audiveris_heads.load_key_timeline('unused', 1), {1: [(0, 1), (70, 2), (140, 0)]})

    def test_repeated_chords_suppressed_from_two_notes_up(self):
        r = self.resolved([[[ (3, 0, 1, None), (1, 0, 1, None), (3, 1, 1, None), (1, 1, 1, None)]]])
        for i, n in enumerate(r['notes']):
            n['chord_id'] = str(i // 2)
        self.assertEqual(len(annotate.records_from_resolved(r)), 1)
        self.assertEqual(len(annotate.records_from_resolved(r, suppress_repeated_chords=False)), 2)
        for n in r['notes'][2:]:
            n['diatonic'] -= 7
        self.assertEqual(len(annotate.records_from_resolved(r)), 2)

        r = self.resolved([[[
            (3, 0, 1, None), (1, 0, 1, None), (-1, 0, 1, None),
            (3, 1, 1, None), (1, 1, 1, None), (-1, 1, 1, None),
        ]]])
        for i, n in enumerate(r['notes']):
            n['chord_id'] = str(i // 3)
        self.assertEqual(len(annotate.records_from_resolved(r)), 1)
        self.assertEqual(len(annotate.records_from_resolved(r, suppress_repeated_chords=False)), 2)
        for n in r['notes'][3:]:
            n['diatonic'] -= 7
        self.assertEqual(len(annotate.records_from_resolved(r)), 2)

    def test_divisions_change_preserves_cursor(self):
        ns, ms = self.parse(measure(ATTR + note(duration=1) + '<attributes><divisions>2</divisions></attributes>' + note('D', duration=2)))
        self.assertEqual([n['start_beat_in_measure'] for n in ns], [0, 1])
        self.assertEqual(ms[0]['content_length_beats'], 2)

    def test_additive_meter(self):
        ns, ms = self.parse(measure('<attributes><time><beats>3+2</beats><beat-type>8</beat-type></time></attributes>' + note(duration=2)))
        self.assertEqual(ms[0]['nominal_length_beats'], 2.5)

    def test_backup_and_tuplet_duration(self):
        attrs = ATTR.replace('<divisions>1</divisions>', '<divisions>3</divisions>')
        ns, ms = self.parse(measure(attrs + note(duration=1) + note('D', duration=1) + '<backup><duration>2</duration></backup>' + note('E', duration=3, voice=2)))
        self.assertEqual([round(n['start_beat_in_measure'], 6) for n in ns], [0, 0, round(1/3, 6)])
        self.assertEqual(ms[0]['content_length_beats'], 1)

    def test_implicit_final_measure_is_not_padded(self):
        _, ms = self.parse(measure(ATTR + note(duration=4)) + measure(note(duration=1), 2, 'implicit="yes"'))
        self.assertEqual([m['length_beats'] for m in ms], [4, 1])

    def test_repeated_measure_numbers_keep_identity(self):
        ns, ms = self.parse(measure(ATTR + note(duration=4)) + measure(note('D', duration=4)))
        self.assertEqual([n['measure_index'] for n in ns], [0, 1])
        self.assertEqual(len(ms), 2)

    def test_ties_preserved(self):
        ns, _ = self.parse(measure(ATTR + note(duration=4, extra='<tie type="start"/>')) + measure(note(duration=4, extra='<tie type="stop"/>'), 2))
        self.assertTrue(ns[0]['tie_start'])
        self.assertTrue(ns[1]['tie_stop'])

    def test_grace_chord_uses_grace_onset(self):
        ns, _ = self.parse(measure(ATTR + note(duration=1) + note('D', duration=0, extra='<grace/>') + note('F', duration=0, extra='<grace/><chord/>') + note('E', duration=1)))
        graces = [n for n in ns if n['is_grace']]
        self.assertEqual([n['start_beat_in_measure'] for n in graces], [1, 1])

    def test_grace_sequence_precedes_main_note(self):
        ns, _ = self.parse(measure(ATTR + note('D', duration=0, extra='<grace/>') + note('E', duration=0, extra='<grace/>') + note('F', duration=1)))
        timeline._realize_graces(ns, [])
        self.assertEqual([n['start_beat_in_measure'] for n in ns], [0, .125, .25])
        self.assertEqual([n['duration_beats'] for n in ns], [.125, .125, .75])

    def test_explicit_grace_make_time(self):
        ns, _ = self.parse(measure(ATTR + note('D', duration=0, extra='<grace make-time="1"/>') + note('E', duration=1)))
        inserts = timeline._realize_graces(ns, [])
        self.assertEqual(inserts, [(0, 1)])
        self.assertEqual(ns[1]['start_beat_in_measure'], 1)

    def test_repeat_and_first_second_endings(self):
        body = measure(ATTR + '<barline location="left"><repeat direction="forward"/></barline>' + note(duration=4))
        body += measure('<barline location="left"><ending number="1" type="start"/></barline>' + note('D', duration=4) + '<barline><ending number="1" type="stop"/><repeat direction="backward"/></barline>', 2)
        body += measure('<barline location="left"><ending number="2" type="start"/></barline>' + note('E', duration=4) + '<barline><ending number="2" type="stop"/></barline>', 3)
        _, ms = self.parse(body)
        self.assertEqual(musicxml.performance_order(ms)[0], [0, 1, 0, 2])

    def test_orphan_endings_do_not_drop_music(self):
        _, ms = self.parse(measure(ATTR + '<barline><ending number="2" type="start"/></barline>' + note(duration=4)))
        order, warnings = musicxml.performance_order(ms)
        self.assertEqual(order, [0])
        self.assertTrue(warnings)

    def test_nested_repeats(self):
        ms = [{'repeat_forward': True}, {'repeat_forward': True}, {'repeat_backward': 2}, {'repeat_backward': 2}]
        self.assertEqual(musicxml.performance_order(ms)[0], [0, 1, 2, 1, 2, 3, 0, 1, 2, 1, 2, 3])

    def test_da_capo_al_fine(self):
        ms = [{}, {'navigation': {'fine': 'yes'}}, {'navigation': {'dacapo': 'yes'}}]
        self.assertEqual(musicxml.performance_order(ms)[0], [0, 1, 2, 0, 1])

    def test_dal_segno_al_coda(self):
        ms = [{'navigation': {'segno': 'a'}}, {'navigation': {'tocoda': 'b'}}, {'navigation': {'dalsegno': 'a'}}, {'navigation': {'coda': 'b'}}]
        self.assertEqual(musicxml.performance_order(ms)[0], [0, 1, 2, 0, 1, 3])

    def test_cue_notes_are_silent(self):
        ns, _ = self.parse(measure(ATTR + note(extra='<cue/>')))
        self.assertEqual(ns, [])

    def test_tempo_pedal_dynamics_articulation_and_fingering_preserved(self):
        direction = '<direction><direction-type><pedal type="start"/><dynamics><p/></dynamics><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type></direction>'
        ns, ms = self.parse(measure(ATTR + direction + note(extra='<notations><articulations><staccato/></articulations><technical><fingering>3</fingering></technical></notations>')))
        events = ms[0]['events']
        self.assertEqual(next(e['value'] for e in events if e['kind'] == 'tempo'), 90)
        self.assertTrue(any(e['kind'] == 'pedal' for e in events))
        self.assertEqual(ns[0]['articulations'], ['staccato'])
        self.assertEqual(ns[0]['fingering'], '3')

    def build(self, pages, xml, clefs=None):
        self.resolved(pages)
        mxl(self.path / 'score.mxl', xml)
        with patch.object(annotate, 'pdf_clef_timeline', return_value=clefs or {}):
            p = timeline.prepare_score(self.path / 'input.pdf', self.path / 'score.mxl', self.path / 'score.omr', len(pages))
        return p, timeline.build_timeline(None, None, None, len(pages), prepared_score=p)

    def test_corrected_pdf_clef_drives_label_and_playback(self):
        p, t = self.build([[[ (0, 0, 1, None)]]], measure(ATTR + note('B', duration=4)), {1: [(0, 'F')]})
        self.assertEqual(t['notes'][0]['midi'], 50)  # middle bass line D3
        self.assertEqual(annotate.records_from_resolved(p['resolved'], octave=True)[0]['labels'], ['D3'])
        self.assertEqual(t['stats']['pitch_corrections'], 1)

    def test_tie_sustains_once_with_both_written_segments(self):
        p, t = self.build([[[ (6, 0, 1, None)], [(6, 0, 1, None)]]],
                          measure(ATTR + note(duration=4, extra='<tie type="start"/>')) + measure(note(duration=4, extra='<tie type="stop"/>'), 2))
        self.assertEqual(len(t['notes']), 2)
        self.assertEqual(len(t['audio_notes']), 1)
        self.assertEqual(t['audio_notes'][0]['duration_beats'], 8)
        self.assertEqual([n['attack'] for n in t['notes']], [True, False])
        self.assertTrue(all(n['bbox_pt'] for n in t['notes']))

    def test_octave_shift_not_applied_twice(self):
        direction = '<direction><direction-type><octave-shift type="down" size="8"/></direction-type></direction>'
        p, t = self.build([[[ (-4, 0, 1, None)]]], measure(ATTR + direction + note('F', octave=6, duration=4)))
        self.assertEqual(t['notes'][0]['midi'], 89)
        self.assertEqual(annotate.records_from_resolved(p['resolved'], octave=True)[0]['labels'], ['F6'])

    def test_octave_shift_unison_matches_both_written_positions(self):
        common = {'staff': 1, 'voice': '1', 'start_beat_in_measure': 1.5,
                  'clef': {'sign': 'G', 'line': 2, 'octave': 0},
                  'octave_shift': 1}
        low = dict(common, step='A', octave=4)
        high = dict(common, step='A', octave=5)
        candidates = [
            {'source_id': 'low', 'role': 0, 'voice': '1', 'onset': 1.5, 'pitch': 1},
            {'source_id': 'high', 'role': 0, 'voice': '1', 'onset': 1.5, 'pitch': -6},
        ]
        used = set()
        low_head = timeline._match_head(low, candidates, used)
        used.add(low_head['source_id'])
        high_head = timeline._match_head(high, candidates, used)
        self.assertEqual((low_head['source_id'], high_head['source_id']), ('low', 'high'))

    def test_missing_page_geometry_does_not_shift_music(self):
        pages = [[[(6, 0, 1, None)]], [[(5, 0, 1, None)]]]
        resolved = self.resolved(pages)
        resolved['pages'][1]['regions'] = []
        source = mxl(self.path / 'score.mxl', measure(ATTR + note(duration=4)) + measure('<print new-page="yes"/>' + note('D', duration=4), 2))
        p = timeline.prepare_score(None, source, None, 2, resolved_notes=resolved)
        t = timeline.build_timeline(None, None, None, 2, prepared_score=p)
        self.assertEqual([m['page'] for m in t['measures']], [1, 2])
        self.assertIsNone(t['measures'][0]['bbox_pt'])
        self.assertIsNotNone(t['measures'][1]['bbox_pt'])
        self.assertEqual(t['notes'][1]['midi'], 62)

    def system_missing_one_measure(self, numbers):
        """Three printed measures in one system against a two-measure export."""
        pages = [[[(6, 0, 1, None)], [(4, 0, 1, None)], [(5, 0, 1, None)]]]
        resolved = self.resolved(pages)
        first, second = numbers
        source = mxl(self.path / 'score.mxl',
                     measure(ATTR + note(duration=4), first)
                     + measure(note('D', duration=4), second))
        p = timeline.prepare_score(None, source, None, 1, resolved_notes=resolved)
        return timeline.build_timeline(None, None, None, 1, prepared_score=p)

    def test_measure_dropped_from_the_export_keeps_the_others_playable(self):
        t = self.system_missing_one_measure((1, 3))
        self.assertEqual([m['bbox_pt'][0] for m in t['measures']], [0, 200])
        self.assertEqual(t['notes'][1]['midi'], 62)
        self.assertTrue(all(n['bbox_pt'] for n in t['notes']))

    def test_a_hole_the_measure_numbers_cannot_locate_stays_unplaced(self):
        # 1 and 2 against three regions: the export could have dropped either
        # the middle measure or the last, so nothing here can be placed safely.
        t = self.system_missing_one_measure((1, 2))
        self.assertEqual([m['bbox_pt'] for m in t['measures']], [None, None])

    def test_pedal_sustain_does_not_keep_key_held(self):
        start = '<direction><direction-type><pedal type="start"/><dynamics><p/></dynamics></direction-type></direction>'
        stop = '<forward><duration>3</duration></forward><direction><direction-type><pedal type="stop"/></direction-type></direction>'
        _, t = self.build([[[ (6, 0, 1, None)]]], measure(ATTR + start + note(extra='<notations><articulations><staccato/></articulations></notations>') + stop))
        self.assertEqual(t['notes'][0]['key_duration_beats'], .5)
        self.assertEqual(t['audio_notes'][0]['duration_beats'], 4)
        self.assertEqual(t['notes'][0]['velocity'], 52)

    def test_retry_page_replacement_does_not_consume_next_page(self):
        main = mxl(self.path / 'main.mxl', measure(ATTR + note(duration=4)) + measure('<print new-page="yes"/>' + note('D', duration=4), 2))
        retry = mxl(self.path / 'retry.mxl', measure(ATTR + note('E', duration=4)) + measure(note('F', duration=4), 2))
        printed = timeline._printed_sources(main, 2, {1: {'mxl': retry}})
        self.assertEqual([(m['page'], ns[0]['step']) for m, ns in printed], [(1, 'E'), (1, 'F'), (2, 'D')])

    def test_pdf_octave_requires_a_matching_dashed_line(self):
        from types import SimpleNamespace
        page = SimpleNamespace(get_text=lambda _: {'blocks': [{'lines': [{'spans': [
            {'text': '\ue510', 'bbox': (20, 20, 28, 30)}]}]}]},
            get_drawings=lambda: [{'dashes': '[1 1] 0', 'items': [('l', pymupdf.Point(30, 25), pymupdf.Point(180, 25))]}])
        self.assertEqual(pdf_marks.octave_intervals(page, {1: (40, 50, 60, 70, 80)}), {1: [(18, 182, 1)]})
        page.get_drawings = lambda: []
        self.assertEqual(pdf_marks.octave_intervals(page, {1: (40, 50, 60, 70, 80)}), {})

    def test_pdf_octave_label_with_embedded_dashes_is_recognized(self):
        from types import SimpleNamespace
        for label in ('8-', '8--', '8va-', '8va--'):
            line_start = 20 + len(label.rstrip('-')) * 5
            page = SimpleNamespace(get_text=lambda _, label=label: {'blocks': [{'lines': [{'spans': [
                {'text': label, 'bbox': (20, 20, 20 + len(label) * 5, 30)}]}]}]},
                get_drawings=lambda line_start=line_start: [{'dashes': '[1 1] 0', 'items': [
                    ('l', pymupdf.Point(line_start, 25), pymupdf.Point(180, 25))]}])
            self.assertEqual(pdf_marks.octave_intervals(page, {1: (40, 50, 60, 70, 80)}),
                              {1: [(18, 182, 1)]}, msg=label)

    def test_pdf_octave_continuation_inside_text_span_is_recognized(self):
        from types import SimpleNamespace
        for label in ('8-', '8--', '8va-', '8va--'):
            page = SimpleNamespace(get_text=lambda _, label=label: {'blocks': [{'lines': [{'spans': [
                {'text': label, 'bbox': (20, 20, 180, 30)}]}]}]}, get_drawings=lambda: [])
            self.assertEqual(pdf_marks.octave_intervals(page, {1: (40, 50, 60, 70, 80)}),
                              {1: [(18, 182, 1)]}, msg=label)

    def test_pdf_octave_labels_from_legacy_opus_font_are_recognized(self):
        from types import SimpleNamespace
        for label in ('”“', '“'):
            page = SimpleNamespace(get_text=lambda _, label=label: {'blocks': [{'lines': [{'spans': [
                {'text': label, 'font': 'OpusSpecialStd', 'bbox': (20, 5, 30, 30)}]}]}]},
                get_drawings=lambda: [{'dashes': '[2.5 2.1] 0', 'items': [
                    ('l', pymupdf.Point(30, 25), pymupdf.Point(180, 25))]}])
            self.assertEqual(pdf_marks.octave_intervals(page, {1: (40, 50, 60, 70, 80)}),
                              {1: [(18, 182, 1)]}, msg=label)

    def test_pdf_octave_direction_selects_the_correct_staff_between_systems(self):
        from types import SimpleNamespace
        staffs = {1: (0, 5, 10, 15, 20), 2: (50, 55, 60, 65, 70)}
        drawing = lambda: [{'dashes': '[2.5 2.1] 0', 'items': [
            ('l', pymupdf.Point(30, 32), pymupdf.Point(180, 32))]}]
        alta = SimpleNamespace(get_text=lambda _: {'blocks': [{'lines': [{'spans': [
            {'text': '8va', 'bbox': (20, 25, 30, 37)}]}]}]}, get_drawings=drawing)
        bassa = SimpleNamespace(get_text=lambda _: {'blocks': [{'lines': [{'spans': [
            {'text': '8vb', 'bbox': (20, 25, 30, 37)}]}]}]}, get_drawings=drawing)
        self.assertEqual(pdf_marks.octave_intervals(alta, staffs), {2: [(18, 182, 1)]})
        self.assertEqual(pdf_marks.octave_intervals(bassa, staffs), {1: [(18, 182, -1)]})

    def test_pdf_dotted_metronome_units(self):
        from types import SimpleNamespace
        spans = [{'text': '\ueca5', 'bbox': (20, 20, 28, 30)},
                 {'text': '\uecb7', 'bbox': (29, 20, 31, 30)},
                 {'text': ' = 68', 'bbox': (32, 20, 60, 30)}]
        page = SimpleNamespace(get_text=lambda _: {'blocks': [{'lines': [{'spans': spans}]}]})
        self.assertEqual(pdf_marks.metronome_marks(page)[0]['bpm'], 102)
        self.assertEqual(pdf_marks.metronome_marks(page)[0]['beat_unit_quarters'], 1.5)

    def test_xml_metronome_unit_survives_sound_tempo(self):
        direction = '<direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>68</per-minute></metronome></direction-type><sound tempo="102"/></direction>'
        _, ms = self.parse(measure(ATTR + direction + note()))
        events = [e for e in ms[0]['events'] if e['kind'] == 'tempo']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['value'], 102)
        self.assertEqual(events[0]['beat_unit_quarters'], 1.5)

    def test_pdf_octave_overrides_inconsistent_export(self):
        with patch('score_notes.octave_intervals', return_value={1: [(0, 200, 1)]}):
            p, t = self.build([[[(-4, 0, 1, None)]]], measure(ATTR + note('F', octave=5, duration=4)))
        self.assertEqual(t['notes'][0]['midi'], 89)
        self.assertEqual(annotate.records_from_resolved(p['resolved'], octave=True)[0]['labels'], ['F6'])

    def test_staffless_bass_part_retains_its_clef(self):
        part = ET.fromstring('<part>' + measure('<attributes><clef><sign>F</sign><line>4</line></clef></attributes><note><pitch><step>D</step><octave>3</octave></pitch><duration>1</duration></note>') + '</part>')
        ns, _ = musicxml._parse_part(part, 1, 2)
        self.assertEqual(ns[0]['staff'], 2)
        self.assertEqual(ns[0]['clef']['sign'], 'F')

    def test_repeated_notes_without_ties_restrike(self):
        _, t = self.build([[[ (6, 0, 1, None), (6, 1, 1, None)]]], measure(ATTR + note() + note()))
        self.assertEqual(len(t['audio_notes']), 2)

    def test_omr_repeat_missing_from_musicxml_is_recovered_for_playback(self):
        _, t = self.build([[[ (6, 0, 1, None), (6, 1, 1, None)]]],
                          measure(ATTR + note(duration=2)))
        self.assertEqual([(n['midi'], n['start_beat']) for n in t['notes']],
                         [(60, 0), (60, 1)])
        self.assertEqual([(n['midi'], n['start_beat']) for n in t['audio_notes']],
                         [(60, 0), (60, 1)])

    def test_playback_falls_back_to_musicxml_when_pdf_matching_fails(self):
        source = mxl(self.path / 'score.mxl', measure(ATTR + note() + note('D')))
        t = timeline.build_timeline(self.path / 'missing.pdf', source,
                                    self.path / 'missing.omr', 1)
        self.assertEqual([(n['midi'], n['start_beat']) for n in t['notes']],
                         [(60, 0), (62, 1)])
        self.assertTrue(any('MusicXML-only' in warning for warning in t['warnings']))

    def test_fermata_extends_note_and_measure(self):
        notation = '<notations><fermata/></notations>'
        _, t = self.build([[[ (6, 0, 1, None)]]], measure(ATTR + note(duration=4, extra=notation)))
        self.assertEqual(t['notes'][0]['duration_beats'], 6)
        self.assertEqual(t['measures'][0]['length_beats'], 6)
        self.assertTrue(any('Fermatas use' in w for w in t['measures'][0]['warnings']))

    def test_trill_uses_key_aware_upper_neighbor(self):
        attrs = ATTR.replace('<clef>', '<key><fifths>1</fifths></key><clef>')
        notation = '<notations><ornaments><trill-mark/></ornaments></notations>'
        _, t = self.build([[[ (6, 0, 1, None)]]], measure(attrs + note(duration=1, extra=notation)))
        self.assertEqual([a['midi'] for a in t['audio_notes'][:4]], [60, 62, 60, 62])

    def test_mordent_keeps_main_note_after_ornament(self):
        notation = '<notations><ornaments><mordent/></ornaments></notations>'
        _, t = self.build([[[ (6, 0, 1, None)]]], measure(ATTR + note(duration=1, extra=notation)))
        self.assertEqual([a['midi'] for a in t['audio_notes'][:3]], [60, 62, 60])
        self.assertAlmostEqual(sum(a['duration_beats'] for a in t['audio_notes']), .9625)

    def test_conflicting_simultaneous_accidentals_are_marked_uncertain(self):
        r = self.resolved([[[ (3, 0, 1, 'SHARP'), (3, 0, 1, 'FLAT'), (3, 1, 1, None)]]])
        # Deduplication at the same coordinates is intentional in OMR. Move the
        # second head slightly as an engraver does for a conflicting unison.
        root = audiveris_heads._parse_sheet(self.path / 'score.omr', 1)
        list(root.iter('head'))[1].find('bounds').set('x', '22')
        with zipfile.ZipFile(self.path / 'score.omr', 'w') as z:
            z.writestr('sheet#1/sheet#1.xml', ET.tostring(root))
        r = resolve_score_notes(self.path / 'input.pdf', self.path / 'score.omr', 1)
        self.assertTrue(all(n['pitch_uncertain'] for n in r['notes']))


if __name__ == '__main__':
    unittest.main()
