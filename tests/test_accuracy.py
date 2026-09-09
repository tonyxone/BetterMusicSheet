"""Hand-authored musical ground truth; no OMR engine or network required."""
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

import pymupdf
import annotate
import audiveris_heads
import musicxml
import timeline
import pdf_marks
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


def omr(path, pages):
    """Two staves per page, one system, with explicit voice/slot identities.

    Each page contains measures of heads: (pitch slot, onset, staff, alter).
    Optional key events are injected by the tests as actual OMR objects.
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
                    if staff not in voice_els:
                        voice_els[staff] = ET.SubElement(ET.SubElement(m, 'voice', id=str(staff)), 'slots')
                    entry = ET.SubElement(voice_els[staff], 'entry')
                    ET.SubElement(entry, 'key').text = slot
                    ET.SubElement(entry, 'value', chord=cid, status='BEGIN')
                ET.SubElement(m, 'head-chords').text = ' '.join(ids)
            z.writestr(f'sheet#{page_number}/sheet#{page_number}.xml', ET.tostring(root))
    return path


class AccuracyTests(unittest.TestCase):
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

    def test_repeated_chords_default_full_coverage_and_octave_identity(self):
        r = self.resolved([[[ (3, 0, 1, None), (1, 0, 1, None), (3, 1, 1, None), (1, 1, 1, None)]]])
        for i, n in enumerate(r['notes']):
            n['chord_id'] = str(i // 2)
        self.assertEqual(len(annotate.records_from_resolved(r)), 2)
        self.assertEqual(len(annotate.records_from_resolved(r, suppress_repeated_chords=True)), 1)
        for n in r['notes'][2:]:
            n['diatonic'] -= 7
        self.assertEqual(len(annotate.records_from_resolved(r, suppress_repeated_chords=True)), 2)

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
