"""Join printed note identities to geometry and build a performed timeline."""
from collections import defaultdict
from copy import deepcopy
import pymupdf
from pdf_marks import time_signatures

import musicxml
from labels import step_of, octave_of
from score_notes import STEP, clef_reference, midi_of, resolve_score_notes

DEFAULT_TEMPO_BPM = 96


def step_octave_to_midi(step, octave, alter=0):
    return (octave + 1) * 12 + STEP[step.upper()] + alter


def diatonic_to_midi(diatonic, alter=0):
    return midi_of(diatonic, alter)


def _printed_sources(mxl_path, num_pages, overrides):
    notes, measures = musicxml.load_score_notes(mxl_path)
    by_measure = defaultdict(list)
    for n in notes:
        by_measure[n['measure_index']].append(n)
    result = []
    for page in range(1, num_pages + 1):
        override = (overrides or {}).get(page, {})
        if override.get('mxl'):
            # Replacement is by source page, independent of geometry counts.
            ns, ms = musicxml.load_score_notes(override['mxl'])
            by_id = defaultdict(list)
            for n in ns:
                by_id[n['measure_index']].append(n)
            for m in ms:
                result.append((dict(m, page=page), by_id[m['measure_index']]))
        else:
            result.extend((m, by_measure[m['measure_index']]) for m in measures if m['page'] == page)
    # Preserve music with anomalous page metadata, but never assign its geometry
    # to a different page as a fallback.
    result.extend((m, by_measure[m['measure_index']]) for m in measures if m['page'] > num_pages)
    return result


def _match_head(n, candidates, used):
    clef = n['clef']
    ref = clef_reference(clef['sign'], clef['line'])
    if ref is None:
        return None
    # Audiveris exports the pitch at the written staff position even while an
    # octave line is active. Match that position first. This matters for an
    # octave-spaced unison: shifting before matching turns both candidates
    # into the same pitch class and leaves one of them unmatched.
    written = 34 - (n['octave'] * 7 + 'CDEFGAB'.index(n['step']))
    positioned = [h for h in candidates if h['source_id'] not in used
                and h['role'] == max(0, n['staff'] - 1)
                and h.get('onset') is not None
                and abs(h['onset'] - n['start_beat_in_measure']) < 1e-6]
    written_slot = written - ref
    possible = [h for h in positioned if h['pitch'] == written_slot]
    if not possible:
        # Keep accepting MusicXML that encodes the true sounding octave, as
        # required by the format, rather than Audiveris's written octave.
        sounding_slot = written + 7 * (n['octave_shift'] + clef['octave']) - ref
        possible = [h for h in positioned if h['pitch'] == sounding_slot]
    if not possible:
        # Some exports contain dangling octave-shift directions while pitches
        # have already returned to the normal register. Sounding pitch remains
        # authoritative for the octave; a unique letter/voice/slot-time match
        # can still establish identity without trusting that dangling direction.
        possible = [h for h in positioned if (h['pitch'] - written_slot) % 7 == 0]
    voice_matches = [h for h in possible if h.get('voice') == n['voice']]
    if voice_matches:
        possible = voice_matches
    # Refuse ambiguous unisons. Count equality alone is never a match.
    return possible[0] if len(possible) == 1 else None


def _realize_graces(notes, warnings):
    """Consecutive grace groups steal time from the adjacent voice note.

    The fallback is 25% of the following note, capped at a quarter beat.
    Explicit make-time expands the whole measure through the returned inserts.
    """
    voices = defaultdict(list)
    for n in notes:
        voices[(n['part'], n['voice'])].append(n)
    inserts = []
    for voice in voices.values():
        def source_order(note):
            suffix = note['source_id'].rsplit(':', 1)[-1]
            return (int(suffix), '') if suffix.isdigit() else (float('inf'), note['source_id'])
        voice.sort(key=lambda n: (n['start_beat_in_measure'], source_order(n)))
        pending, previous = [], []
        for n in voice:
            if n['is_grace']:
                if not n['chord'] or not pending:
                    pending.append([])
                pending[-1].append(n)
                continue
            if pending:
                grace = pending[0][0]['grace']
                amount = musicxml._number(grace.get('make-time-beats'))
                previous_pct = musicxml._number(grace.get('steal-time-previous'))
                if amount:
                    start = n['start_beat_in_measure']
                    inserts.append((start, amount))
                    for group in pending:
                        for g in group:
                            g['_make_time_at'] = start
                elif previous_pct and previous:
                    amount = min(previous[0]['duration_beats'], previous[0]['duration_beats'] * previous_pct / 100)
                    start = n['start_beat_in_measure'] - amount
                    for p in previous:
                        p['duration_beats'] = max(0, p['duration_beats'] - amount)
                else:
                    pct = musicxml._number(grace.get('steal-time-following'), 25)
                    amount = min(n['duration_beats'] * pct / 100, n['duration_beats'])
                    if 'steal-time-following' not in grace:
                        amount = min(.25, amount)
                        warnings.append('Grace timing uses a short lead-in taken from the following note.')
                    start = n['start_beat_in_measure']
                    onset = n['start_beat_in_measure']
                    for main in voice:
                        if not main['is_grace'] and abs(main['start_beat_in_measure'] - onset) < 1e-7:
                            main['start_beat_in_measure'] += amount
                            main['duration_beats'] = max(0, main['duration_beats'] - amount)
                for i, group in enumerate(pending):
                    for g in group:
                        g['start_beat_in_measure'] = start + i * amount / len(pending)
                        g['duration_beats'] = amount / len(pending)
                pending = []
            if n['chord']:
                previous.append(n)
            else:
                previous = [n]
        if pending:
            warnings.append('Unattached grace notes need timing review.')
            if previous:
                amount = min(.25, previous[0]['duration_beats'] * .25)
                start = previous[0]['start_beat_in_measure'] + previous[0]['duration_beats'] - amount
                for p in previous:
                    p['duration_beats'] -= amount
                for i, group in enumerate(pending):
                    for g in group:
                        g['start_beat_in_measure'], g['duration_beats'] = start + i * amount / len(pending), amount / len(pending)
    # Explicit make-time shifts all voices/rest boundaries together. Grace
    # notes themselves occupy the inserted interval rather than being shifted.
    for at, amount in sorted(set(inserts), reverse=True):
        for n in notes:
            if n.get('_make_time_at') == at:
                continue
            if n['start_beat_in_measure'] >= at:
                n['start_beat_in_measure'] += amount
            elif n['start_beat_in_measure'] + n['duration_beats'] > at:
                n['duration_beats'] += amount
    for n in notes:
        n.pop('_make_time_at', None)
    return sorted(set(inserts))


def _recover_measure_tail(measure, notes, candidates, used):
    """Recover an unexported monophonic tail only with consistent timing evidence.

    Audiveris can retain heads but omit their voice slots after a bad meter
    recognition. Require three matched equal-duration anchors, uniform spacing,
    and exact completion of the existing measure; never extend its duration.
    """
    recovered = []
    by_id = {h['source_id']: h for h in candidates}
    for role in {h['role'] for h in candidates}:
        anchors = sorted([n for n in notes if n.get('head_id') in by_id
                          and n['staff'] - 1 == role], key=lambda n: n['start_beat_in_measure'])
        if len(anchors) < 3:
            continue
        # A chord contributes one rhythmic anchor at its mean horizontal position.
        groups = defaultdict(list)
        for n in anchors:
            groups[n['start_beat_in_measure']].append(n)
        if len(groups) < 3:
            continue
        last_groups = [groups[t] for t in sorted(groups)[-3:]]
        if any(len({(n['duration_beats'], n['voice']) for n in g}) != 1 for g in last_groups):
            continue
        anchors = [g[0] for g in last_groups]
        last = anchors[-1]
        duration = last['duration_beats']
        if duration <= 0 or any(n['is_grace'] or n['tie_start'] or n['tie_stop']
                               or n['voice'] != last['voice']
                               or abs(n['duration_beats'] - duration) > 1e-6 for n in anchors):
            continue
        if any(abs(b['start_beat_in_measure'] - a['start_beat_in_measure'] - duration) > 1e-6
               for a, b in zip(anchors, anchors[1:])):
            continue
        xs = [sum(by_id[n['head_id']]['cx'] for n in g) / len(g) for g in last_groups]
        spacing = (xs[-1] - xs[0]) / 2
        if spacing <= 0 or abs(xs[1] - xs[0] - spacing) > spacing * .15:
            continue
        tail = sorted([h for h in candidates if h['role'] == role and h['source_id'] not in used
                       and h['cx'] > xs[-1]], key=lambda h: h['cx'])
        chords = {}
        for h in tail:
            chords.setdefault(h.get('chord_id', h['source_id']), []).append(h)
        chord_groups = list(chords.values())
        end = last['start_beat_in_measure'] + duration
        if not tail or abs(end + len(chord_groups) * duration - measure['length_beats']) > 1e-6:
            continue
        if any(h.get('onset') is not None or h.get('voice') is not None
               or h.get('confidence', 0) < .8 or h.get('pitch_uncertain')
               or h['shape'] != 'NOTEHEAD_BLACK'
               or abs(h['cx'] - xs[-1] - (i + 1) * spacing) > spacing * .2
               for i, group in enumerate(chord_groups) for h in group):
            continue
        # Do not overwrite a rest or another exported voice in this staff.
        if any(n['staff'] - 1 == role and n['start_beat_in_measure'] >= end for n in notes):
            continue
        if any(r['staff'] - 1 == role and r['start'] + r['duration'] > end
               for r in measure.get('rests', [])):
            continue
        for i, h in [(i, h) for i, group in enumerate(chord_groups) for h in group]:
            shift = h.get('pdf_octave_shift', last['octave_shift']) + last['clef']['octave']
            diatonic = h['diatonic'] - shift * 7
            midi = midi_of(diatonic, h['alter']) + last['transpose']
            n = dict(last, source_id=f'recovered:{h["source_id"]}',
                     printed_id=f'recovered:{h["source_id"]}', head_id=h['source_id'],
                     start_beat_in_measure=end + i * duration, duration_beats=duration,
                     step=step_of(diatonic), octave=octave_of(diatonic), alter=h['alter'],
                     midi=midi, xml_midi=midi, bbox_pt=h['bbox_pt'], confidence=h['confidence'],
                     pitch_source='omr-recovered-tail', timing_source='inferred-uniform-tail',
                     articulations=[], ornaments=[], fermata=False, arpeggiate=False,
                     fingering=None, chord=False)
            recovered.append(n)
            used.add(h['source_id'])
        measure['warnings'].append('Recovered omitted ending notes from detected heads; timing follows the preceding uniform rhythm. Review this measure.')
    notes.extend(recovered)
    return len(recovered)


def _recover_known_onsets(measure, notes, candidates, used):
    """Keep OMR attacks that MusicXML omitted from the playback timeline.

    Annotation density is a rendering decision, so it must never determine
    which notes sound.  Audiveris occasionally retains a notehead and its
    voice/onset relation in the OMR file while leaving that attack out of the
    MusicXML export.  Reconcile the two sources by count at each staff/onset;
    existing MusicXML notes remain authoritative and only the deficit is
    restored, which avoids duplicating merely-unmatched MusicXML notes.
    """
    from collections import Counter

    recovered = []
    groups = defaultdict(list)
    for h in candidates:
        if h.get('onset') is not None:
            groups[(h['role'], float(h['onset']))].append(h)

    original = list(notes)
    for (role, onset), heads in sorted(groups.items()):
        recovered_before = len(recovered)
        existing = [n for n in original if n['staff'] - 1 == role
                    and abs(n['start_beat_in_measure'] - onset) < 1e-6]
        deficit = len(heads) - len(existing)
        if deficit <= 0:
            continue

        role_notes = [n for n in original if n['staff'] - 1 == role]
        fallback = role_notes or original
        prototype = min(fallback, key=lambda n: abs(n['start_beat_in_measure'] - onset)) if fallback else None
        transpose = prototype.get('transpose', 0) if prototype else 0

        # Pair existing pitches with detected heads first. Any surplus head is
        # the best candidate for a MusicXML omission, including a repeated
        # same-pitch attack at a later onset.
        represented = Counter(n['midi'] for n in existing)
        missing = []
        for h in sorted(heads, key=lambda item: (item['cx'], item['source_id'])):
            diatonic = h.get('label_diatonic', h['diatonic'])
            midi = midi_of(diatonic, h['alter']) + transpose
            if represented[midi] > 0:
                represented[midi] -= 1
            elif h['source_id'] not in used:
                missing.append((h, diatonic, midi))
        if len(missing) < deficit:
            selected = {h['source_id'] for h, _, _ in missing}
            for h in sorted(heads, key=lambda item: (item['cx'], item['source_id'])):
                if h['source_id'] in used or h['source_id'] in selected:
                    continue
                diatonic = h.get('label_diatonic', h['diatonic'])
                missing.append((h, diatonic, midi_of(diatonic, h['alter']) + transpose))
                if len(missing) == deficit:
                    break

        for h, diatonic, midi in missing[:deficit]:
            voice = h.get('voice') or (prototype.get('voice', '1') if prototype else '1')
            same_attack = [n for n in existing if n['voice'] == voice]
            if same_attack:
                duration = max(n['duration_beats'] for n in same_attack)
            else:
                later = [float(other['onset']) for other in candidates
                         if other['role'] == role and other.get('onset') is not None
                         and (other.get('voice') or voice) == voice
                         and float(other['onset']) > onset + 1e-6]
                duration = (min(later) if later else measure['length_beats']) - onset
            if duration <= 1e-6:
                continue

            clef_sign = h.get('clef', 'G' if role == 0 else 'F')
            clef = prototype.get('clef') if prototype else None
            if not isinstance(clef, dict):
                clef = {'sign': clef_sign, 'line': 2 if clef_sign == 'G' else 4, 'octave': 0}
            base = dict(prototype) if prototype else {}
            source_id = f'recovered:{h["source_id"]}'
            base.update(identity=(measure['identity'], source_id), label=measure['label'],
                        part=h.get('part', base.get('part', 0)), staff=role + 1, voice=voice,
                        step=step_of(diatonic), octave=octave_of(diatonic), alter=h['alter'],
                        start_beat_in_measure=onset, duration_beats=duration,
                        is_grace=False, grace={}, chord=bool(existing), tie_start=False,
                        tie_stop=False, articulations=[], ornaments=[], fermata=False,
                        arpeggiate=False, fingering=None, clef=clef, octave_shift=0,
                        key_fifths=h.get('key_fifths', base.get('key_fifths', 0)),
                        transpose=transpose, default_x=h.get('cx'), source_id=source_id,
                        printed_id=source_id, midi=midi, xml_midi=midi,
                        bbox_pt=h['bbox_pt'], confidence=h.get('confidence'),
                        head_id=h['source_id'], pitch_source='omr-recovered-onset',
                        timing_source='omr-onset')
            recovered.append(base)
            used.add(h['source_id'])
        if len(recovered) > recovered_before:
            measure['warnings'].append(
                'Recovered note attacks omitted from MusicXML using detected OMR timing.')

    notes.extend(recovered)
    return len(recovered)


def _prepare_musicxml_only(mxl_path, num_pages, page_omr_overrides=None):
    """Prepare playable notes when PDF/OMR geometry cannot be reconciled."""
    printed = _printed_sources(mxl_path, num_pages, page_omr_overrides)
    note_count = 0
    warning = 'PDF note matching failed; playback uses MusicXML-only score data.'
    for printed_index, (measure, notes) in enumerate(printed):
        measure['printed_index'] = printed_index
        measure['bbox_pt'] = None
        measure['warnings'].append(warning)
        for n in notes:
            n['printed_id'] = f'{measure["page"]}:{n["source_id"]}'
            n['xml_midi'] = step_octave_to_midi(n['step'], n['octave'], n['alter']) + n['transpose']
            n['midi'] = n['xml_midi']
            n.update(bbox_pt=None, pitch_source='musicxml-only', confidence=None, head_id=None)
            note_count += 1
    stats = {'notes_matched': 0, 'notes_unmatched': note_count, 'pitch_corrections': 0,
             'measure_count_mismatch': 0, 'pages_without_regions': num_pages,
             'measures_without_note_positions': len(printed), 'musicxml_only': 1}
    return {'resolved': {'pages': {}, 'notes': []}, 'printed': printed, 'stats': stats}


def prepare_score(pdf_path, mxl_path, omr_path, num_pages, page_omr_overrides=None, resolved_notes=None):
    resolved = resolved_notes if resolved_notes is not None else resolve_score_notes(pdf_path, omr_path, num_pages, page_omr_overrides)
    printed = _printed_sources(mxl_path, num_pages, page_omr_overrides)
    with pymupdf.open(pdf_path) as pdf:
        meters = {i + 1: time_signatures(p) for i, p in enumerate(pdf)}
    pdf_meter = None
    stats = {'notes_matched': 0, 'notes_unmatched': 0, 'pitch_corrections': 0,
             'measure_count_mismatch': 0, 'pages_without_regions': 0, 'measures_without_note_positions': 0}
    xml_counts = defaultdict(int)
    for m, _ in printed:
        xml_counts[(m['page'], m['system'])] += 1
    pending_ties, printed_beat = {}, 0.0
    for printed_index, (m, notes) in enumerate(printed):
        m['printed_index'] = printed_index
        page = resolved['pages'].get(m['page'], {'regions': [], 'notes': []})
        regions = [r for r in page['regions'] if r['system'] == m['system']]
        region = None
        if len(regions) == xml_counts[(m['page'], m['system'])]:
            region = next((r for r in regions if r['system_measure'] == m['system_measure']), None)
        else:
            stats['measure_count_mismatch'] += 1
            m['warnings'].append('Measure geometry is incomplete; positions are left unassigned.')
        m['bbox_pt'] = region['bbox_pt'] if region else None
        if region:
            x0, y0, x1, y1 = region['bbox_pt']
            values = {e['beats'] for e in meters.get(m['page'], [])
                      if x0 <= e['x'] < x1 and y0 <= e['y'] <= y1}
            if len(values) == 1:
                pdf_meter = values.pop()
        if pdf_meter is not None and not m['implicit'] and not m['label'].startswith('X'):
            if abs(m['nominal_length_beats'] - pdf_meter) > 1e-6:
                m['warnings'].append('Time signature corrected from the printed PDF.')
                m['nominal_length_beats'] = pdf_meter
                m['length_beats'] = max(pdf_meter, m['content_length_beats'])
        for event in page.get('tempo_events', []):
            if event['system'] == m['system'] and event['system_measure'] == m['system_measure']:
                m['events'] = [e for e in m['events'] if not (e['kind'] == 'tempo' and abs(e['beat'] - event['beat']) < 1e-6)]
                m['events'].append(event)
        candidates = [h for h in page['notes'] if region and h['system'] == region['system']
                      and h['system_measure'] == region['system_measure']]
        used = set()
        for n in notes:
            n['printed_id'] = f'{m["page"]}:{n["source_id"]}'
            n['xml_midi'] = step_octave_to_midi(n['step'], n['octave'], n['alter']) + n['transpose']
            n['midi'] = n['xml_midi']
            h = _match_head(n, candidates, used)
            if h:
                used.add(h['source_id'])
                # Corrected PDF clef is authoritative. Otherwise prefer the XML
                # accidental/key semantics on a positively identified head.
                if h['clef_source'] != 'pdf' or h['clef'] == h['recognized_clef']:
                    h['alter'] = n['alter']
                    h['midi'] = midi_of(h['diatonic'], h['alter'])
                source_diatonic = h['pitch'] + clef_reference(n['clef']['sign'], n['clef']['line'])
                xml_diatonic = 34 - (n['octave'] * 7 + 'CDEFGAB'.index(n['step']))
                shift = (source_diatonic - xml_diatonic) // 7
                if 'pdf_octave_shift' in h:
                    shift = h['pdf_octave_shift'] + n['clef']['octave']
                elif shift != n['octave_shift'] + n['clef']['octave']:
                    m['warnings'].append('Octave marking and encoded pitch disagree; the encoded octave is retained.')
                n['midi'] = h['midi'] + shift * 12 + n['transpose']
                h['label_diatonic'] = h['diatonic'] - shift * 7
                n['bbox_pt'] = h['bbox_pt']
                n['pitch_source'] = 'pdf-clef' if h['clef_source'] == 'pdf' else 'matched-omr'
                if 'pdf_octave_shift' in h:
                    n['pitch_source'] = 'pdf-octave'
                n['confidence'] = h['confidence']
                n['head_id'] = h['source_id']
                stats['notes_matched'] += 1
                stats['pitch_corrections'] += n['midi'] != n['xml_midi']
            else:
                n.update(bbox_pt=None, pitch_source='musicxml-unmatched', confidence=None, head_id=None)
                stats['notes_unmatched'] += 1
            tie_key = (n['part'], n['voice'], n['xml_midi'])
            previous = pending_ties.pop(tie_key, None)
            absolute = printed_beat + n['start_beat_in_measure']
            if n['tie_stop'] and previous and abs(previous[0] - absolute) < 1e-6:
                n['midi'] = previous[1]
                if h:
                    h['alter'] = previous[2]
                    h['label_diatonic'] = previous[3]
            if n['tie_start']:
                pending_ties[tie_key] = (absolute + n['duration_beats'], n['midi'],
                                         h['alter'] if h else n['alter'],
                                         h.get('label_diatonic', h['diatonic']) if h else 34 - (n['octave'] * 7 + 'CDEFGAB'.index(n['step'])))
        onset_count = _recover_known_onsets(m, notes, candidates, used)
        tail_count = _recover_measure_tail(m, notes, candidates, used)
        stats['notes_recovered'] = stats.get('notes_recovered', 0) + onset_count + tail_count
        stats['notes_recovered_from_omr_onsets'] = (
            stats.get('notes_recovered_from_omr_onsets', 0) + onset_count)
        if any(n['bbox_pt'] is None for n in notes):
            stats['measures_without_note_positions'] += 1
            m['warnings'].append('Some notes have approximate positions or unverified pitch alignment.')
        printed_beat += m['length_beats']
    stats['pages_without_regions'] = sum(not resolved['pages'].get(p, {}).get('regions') for p in range(1, num_pages + 1))
    return {'resolved': resolved, 'printed': printed, 'stats': stats}


def _audio_events(notes, events, total_beats, warnings):
    audio, pending = [], {}
    dynamic = defaultdict(lambda: 80.0)
    dynamics = sorted([e for e in events if e['kind'] == 'dynamic'], key=lambda e: e['start_beat'])
    d = 0
    for n in notes:
        while d < len(dynamics) and dynamics[d]['start_beat'] <= n['start_beat'] + 1e-8:
            e = dynamics[d]
            dynamic[(e['part'], e['staff'])] = e['value']
            d += 1
        arts = n['articulations']
        factor = .25 if 'staccatissimo' in arts else .5 if 'staccato' in arts else .85 if 'detached-legato' in arts else 1
        velocity = dynamic[(n['part'], n['staff'])] + (18 if 'strong-accent' in arts else 10 if 'accent' in arts else 0)
        n['velocity'] = min(127, max(1, velocity))
        n['key_duration_beats'] = n['duration_beats'] * (1 if n['tie_start'] else factor)
        key = (n['part'], n['voice'], n['midi'])
        previous = pending.pop(key, None)
        ornament = next((name for name in n['ornaments'] if name in {
            'trill-mark', 'mordent', 'inverted-mordent', 'turn', 'inverted-turn'}), None)
        if ornament and not n['tie_start'] and not n['tie_stop'] and n['key_duration_beats'] >= .125:
            upper = _neighbor_midi(n, 1)
            lower = _neighbor_midi(n, -1)
            if ornament == 'trill-mark':
                count = max(2, min(32, round(n['key_duration_beats'] / .125)))
                pitches = [n['midi'] if i % 2 == 0 else upper for i in range(count)]
                unit = n['key_duration_beats'] / count
            elif ornament == 'mordent':
                pitches, unit = [n['midi'], upper, n['midi']], min(.125, n['key_duration_beats'] / 3)
            elif ornament == 'inverted-mordent':
                pitches, unit = [n['midi'], lower, n['midi']], min(.125, n['key_duration_beats'] / 3)
            elif ornament == 'turn':
                pitches, unit = [upper, n['midi'], lower, n['midi']], min(.125, n['key_duration_beats'] / 4)
            else:
                pitches, unit = [lower, n['midi'], upper, n['midi']], min(.125, n['key_duration_beats'] / 4)
            ornament_length = unit * len(pitches)
            for i, pitch in enumerate(pitches):
                audio.append({'source_id': n['source_id'], 'segment_ids': [n['source_id']],
                              'midi': pitch, 'role': n['role'], 'part': n['part'],
                              'start_beat': n['start_beat'] + i * unit,
                              'duration_beats': unit * .9, 'velocity': n['velocity']})
            if ornament_length < n['key_duration_beats']:
                audio.append({'source_id': n['source_id'], 'segment_ids': [n['source_id']],
                              'midi': n['midi'], 'role': n['role'], 'part': n['part'],
                              'start_beat': n['start_beat'] + ornament_length,
                              'duration_beats': n['key_duration_beats'] - ornament_length,
                              'velocity': n['velocity']})
            n['attack'] = True
            continue
        if n['tie_stop'] and previous and abs(previous['written_end'] - n['start_beat']) < 1e-6:
            event = previous
            event['duration_beats'] = n['start_beat'] + n['key_duration_beats'] - event['start_beat']
            n['attack'] = False
            event['segment_ids'].append(n['source_id'])
        else:
            event = {'source_id': n['source_id'], 'midi': n['midi'], 'role': n['role'], 'part': n['part'],
                     'start_beat': n['start_beat'], 'duration_beats': n['key_duration_beats'], 'velocity': n['velocity'],
                     'segment_ids': [n['source_id']]}
            audio.append(event)
            n['attack'] = True
            if n['tie_stop']:
                warnings.append('A tie continuation has no adjacent start; check recognition or navigation.')
        event['written_end'] = n['start_beat'] + n['duration_beats']
        if n['tie_start']:
            pending[key] = event
    # Pedal belongs to the piano part, not only the staff where it is printed.
    pedals = defaultdict(list)
    for e in events:
        if e['kind'] == 'pedal':
            pedals[e['part']].append(e)
    for event in audio:
        end = event['start_beat'] + event['duration_beats']
        down = False
        for e in sorted(pedals[event['part']], key=lambda x: x['start_beat']):
            value, when = e['value'], e['start_beat']
            if when <= end + 1e-8:
                down = value in ('start', 'sostenuto', 'change', 'continue', 'resume')
            elif down and value in ('stop', 'change', 'discontinue'):
                end = when
                down = False
                break
        if down:
            end = total_beats
        event['duration_beats'] = max(0, min(total_beats, end) - event['start_beat'])
        event.pop('written_end', None)
    return audio


def _neighbor_midi(note, direction):
    """Diatonic ornament neighbor under the note's active key signature."""
    letters = 'CDEFGAB'
    i = letters.index(note['step']) + direction
    octave = note['octave'] + (1 if i >= 7 else -1 if i < 0 else 0)
    step = letters[i % 7]
    fifths = note.get('key_fifths', 0)
    alter = 1 if fifths > 0 and step in 'FCGDAEB'[:fifths] else -1 if fifths < 0 and step in 'BEADGCF'[:-fifths] else 0
    written = step_octave_to_midi(step, octave, alter) + note.get('transpose', 0)
    delta = written - note['xml_midi']
    return note['midi'] + delta


def _realize_fermatas(notes, measure, warnings):
    """Hold a fermata by 50%, clamped to a readable 0.5-2 quarter beats."""
    positions = defaultdict(list)
    for n in notes:
        if n['fermata']:
            positions[n['start_beat_in_measure'] + n['duration_beats']].append(n)
    added = 0.0
    for original_at, held in sorted(positions.items()):
        at = original_at + added
        amount = max(.5, min(2.0, max(n['duration_beats'] for n in held) * .5))
        for n in notes:
            if n['start_beat_in_measure'] >= at - 1e-8:
                n['start_beat_in_measure'] += amount
            elif n['start_beat_in_measure'] + n['duration_beats'] >= at - 1e-8:
                n['duration_beats'] += amount
        for e in measure['events']:
            if e['beat'] >= at - 1e-8:
                e['beat'] += amount
        measure['length_beats'] += amount
        added += amount
    if positions:
        warnings.append('Fermatas use a 50% hold; adjust the BPM or note correction for a different interpretation.')


def build_timeline(pdf_path, mxl_path, omr_path, num_pages, page_omr_overrides=None,
                   tempo_bpm=DEFAULT_TEMPO_BPM, prepared_score=None):
    fallback_warning = None
    if prepared_score is not None:
        prepared = prepared_score
    else:
        try:
            prepared = prepare_score(pdf_path, mxl_path, omr_path, num_pages, page_omr_overrides)
        except Exception:
            prepared = _prepare_musicxml_only(mxl_path, num_pages, page_omr_overrides)
            fallback_warning = 'PDF note matching failed; playback uses MusicXML-only score data.'
    printed = deepcopy(prepared['printed'])
    for m, ns in printed:
        inserts = _realize_graces(ns, m['warnings'])
        for at, amount in reversed(inserts):
            m['length_beats'] += amount
            for e in m['events']:
                if e['beat'] >= at:
                    e['beat'] += amount
        _realize_fermatas(ns, m, m['warnings'])
    order, warnings = musicxml.performance_order([m for m, _ in printed])
    if fallback_warning:
        warnings.append(fallback_warning)
    snapshots, state = [], {}
    for m, _ in printed:
        snapshots.append(deepcopy(state))
        for e in sorted(m['events'], key=lambda e: e['beat']):
            if e['kind'] in ('tempo', 'dynamic', 'pedal'):
                state[(e['kind'], e['part'], e['staff'])] = e
    notes, measures, events = [], [], []
    start, previous_index = 0.0, -1
    for occurrence, index in enumerate(order):
        m, ns = printed[index]
        if index != previous_index + 1:
            # Restore printed expression state when jumping backwards/forwards.
            events.append({'kind': 'tempo', 'value': tempo_bpm, 'part': 0, 'staff': 1, 'start_beat': start})
            for part, staff in {(n['part'], n['staff']) for _, original in printed for n in original}:
                events.append({'kind': 'dynamic', 'value': 80, 'part': part, 'staff': staff, 'start_beat': start})
            for e in snapshots[index].values():
                events.append(dict(e, start_beat=start))
            parts = {n['part'] for _, original in printed for n in original}
            for part in parts:
                events.append({'kind': 'pedal', 'value': 'stop', 'part': part, 'staff': 1, 'start_beat': start})
        previous_index = index
        for e in m['events']:
            events.append(dict(e, start_beat=start + e['beat']))
        measure_notes = []
        for n in ns:
            out = dict(n, source_id=f'{occurrence}:{n["printed_id"]}', measure_index=occurrence,
                       printed_measure_index=index, role=max(0, n['staff'] - 1), hand=None,
                       start_beat=start + n['start_beat_in_measure'])
            measure_notes.append(out)
        # A written arpeggio is staggered low-to-high, bounded by its duration.
        arps = defaultdict(list)
        for n in measure_notes:
            if n['arpeggiate']:
                arps[(n['part'], n['start_beat'])].append(n)
        for chord in arps.values():
            for i, n in enumerate(sorted(chord, key=lambda n: n['midi'])):
                offset = min(.08 * i, n['duration_beats'] * .3)
                n['start_beat'] += offset
                n['duration_beats'] -= offset
        notes.extend(measure_notes)
        measures.append({'index': occurrence, 'printed_index': index, 'label': m['label'], 'page': m['page'],
                         'system': m['system'], 'start_beat': start, 'length_beats': m['length_beats'],
                         'bbox_pt': m['bbox_pt'], 'distinct_midis': sorted({n['midi'] for n in ns}),
                         'warnings': sorted(set(m['warnings']))})
        start += m['length_beats']
    notes.sort(key=lambda n: (n['start_beat'], n['midi']))
    events.sort(key=lambda e: e['start_beat'])
    # Convert hairpins into sampled velocity changes, ending at the next explicit
    # dynamic or a modest default change. Written marks remain in events.
    open_wedges = {}
    for e in list(events):
        if e['kind'] != 'wedge':
            continue
        key = (e['part'], e['staff'], e.get('number', '1'))
        if e['value'] in ('crescendo', 'diminuendo'):
            open_wedges[key] = e
        elif e['value'] == 'stop' and key in open_wedges:
            first = open_wedges.pop(key)
            prior = [d for d in events if d['kind'] == 'dynamic' and d['part'] == e['part'] and d['staff'] == e['staff'] and d['start_beat'] <= first['start_beat']]
            value = prior[-1]['value'] if prior else 80
            target = next((d['value'] for d in events if d['kind'] == 'dynamic' and d['part'] == e['part'] and d['staff'] == e['staff'] and abs(d['start_beat'] - e['start_beat']) < 1e-6), value + (16 if first['value'] == 'crescendo' else -16))
            span = e['start_beat'] - first['start_beat']
            for n in notes:
                if n['part'] == e['part'] and n['staff'] == e['staff'] and span > 0 and first['start_beat'] <= n['start_beat'] < e['start_beat']:
                    events.append(dict(e, kind='dynamic', start_beat=n['start_beat'], value=value + (target - value) * (n['start_beat'] - first['start_beat']) / span))
    events.sort(key=lambda e: e['start_beat'])
    audio = _audio_events(notes, events, start, warnings)
    tempo_map = [{'start_beat': 0.0, 'bpm': tempo_bpm}]
    for e in events:
        if e['kind'] == 'tempo':
            item = {'start_beat': e['start_beat'], 'bpm': e['value'],
                    'beat_unit_quarters': e.get('beat_unit_quarters', 1)}
            if tempo_map[-1]['start_beat'] == item['start_beat']:
                tempo_map[-1] = item
            else:
                tempo_map.append(item)
    return {'version': 2, 'tempo_bpm_default': tempo_bpm, 'tempo_source': 'score' if any(e['kind'] == 'tempo' for e in events) else 'default',
            'tempo_map': tempo_map, 'total_beats': start, 'measures': measures, 'notes': notes,
            'audio_notes': audio, 'events': events, 'stats': prepared['stats'], 'warnings': sorted(set(warnings))}
