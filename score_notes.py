"""Shared resolved noteheads for annotation and playback.

Audiveris measure/voice/slot relations establish identity; PDF clefs correct
written pitch. Confidence grades are recognition scores, not probabilities.
"""
from collections import defaultdict
from fractions import Fraction

import pymupdf
from audiveris_heads import (
    _parse_sheet, load_sheet_heads, load_chord_id_groups, load_staff_lines,
    load_omr_clefs, load_key_timeline, load_alter_map, get_picture_size,
)
from labels import PITCH_REF, step_of, octave_of
from pdf_marks import octave_intervals, metronome_marks
from scan import is_scanned, ottava_intervals

STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
ALTER = {'SHARP': 1, 'FLAT': -1, 'NATURAL': 0, 'DOUBLE_SHARP': 2, 'DOUBLE_FLAT': -2}
PDF_BLACK_NOTEHEAD = 0xE0A4
# The standard SMuFL noteheads a vector PDF draws as text, with the shape name
# Audiveris gives the same head. Audiveris finds most heads through their
# stems, so a whole note - which has none - is the one it misses most.
PDF_NOTEHEADS = {0xE0A2: 'WHOLE_NOTE', 0xE0A3: 'NOTEHEAD_VOID', PDF_BLACK_NOTEHEAD: 'NOTEHEAD_BLACK'}
# How far from its staff's middle line a head may sit, in staff spaces: four
# and a quarter is two ledger lines. Further out - high runs under an 8va -
# it is taken only up to MAX_LEDGER_SPACES, and only when every other staff is
# LEDGER_CLEARANCE times further away, so a note between two staves is never
# given to the wrong one.
# The accidental printed just left of a head, read the same way, for a head
# Audiveris missed and so never linked one to.
PDF_ACCIDENTALS = {0xE260: 'FLAT', 0xE261: 'NATURAL', 0xE262: 'SHARP',
                   0xE263: 'DOUBLE_SHARP', 0xE264: 'DOUBLE_FLAT'}
NEAR_STAFF_SPACES = 4.25
MAX_LEDGER_SPACES = 7.0
LEDGER_CLEARANCE = 1.5


def _smufl_glyphs(page, table):
    glyphs = []
    for block in page.get_text('rawdict')['blocks']:
        for line in block.get('lines', []):
            for span in line.get('spans', []):
                for char in span.get('chars', []):
                    shape = table.get(ord(char['c']))
                    if shape:
                        x, y = map(float, char['origin'])
                        glyphs.append((shape, x, y, char.get('bbox', (x, y, x, y))))
    return glyphs


def pdf_notehead_glyphs(page):
    """The standard noteheads a vector PDF page draws: (shape, origin x,
    origin y, bbox). Empty for a scan, or a PDF whose music font isn't SMuFL."""
    return _smufl_glyphs(page, PDF_NOTEHEADS)


def _printed_accidental(head, heads, accidentals, interline):
    """The accidental drawn for ``head``: on its staff position, left of it,
    and nearer than any other head on that position - one belonging to an
    earlier note on the same line is that note's."""
    _, x, y, bbox = head
    left = float(bbox[0])
    earlier = [float(b[2]) for _, hx, hy, b in heads
               if abs(hy - y) <= interline * .3 and float(b[2]) <= left and (hx, hy) != (x, y)]
    floor = max(earlier, default=left - 4 * interline)
    near = [(float(b[0]), shape) for shape, _, ay, b in accidentals
            if abs(ay - y) <= interline * .3 and floor <= float(b[0]) and float(b[2]) <= left + interline * .2]
    return max(near)[1] if near else None


def midi_of(diatonic, alter=0):
    return (octave_of(diatonic) + 1) * 12 + STEP[step_of(diatonic)] + alter


def clef_reference(sign, line=None):
    # Reference pitch at the middle staff line, 0 = B4.
    defaults = {'G': (2, 0), 'F': (4, 12), 'C': (3, 6)}
    if sign not in defaults:
        return None
    normal_line, reference = defaults[sign]
    return reference + 2 * ((line or normal_line) - normal_line)


def _key_alter(diatonic, fifths):
    step = step_of(diatonic)
    return 1 if fifths > 0 and step in 'FCGDAEB'[:fifths] else -1 if fifths < 0 and step in 'BEADGCF'[:-fifths] else 0


def _at(events, x, default):
    for left, value in events:
        if left > x:
            break
        default = value
    return default


def vector_pdf_noteheads(page, staff_lines):
    """Read noteheads from a vector PDF using OMR staff geometry.

    MuseScore-compatible PDFs retain the standard SMuFL notehead glyphs
    (whole, half and black) even when Audiveris misses the note.  Staff geometry is still
    supplied by Audiveris, so this is deliberately a gap filler rather than a
    second score-recognition engine.  Scans and PDFs with outlined glyphs
    simply return no candidates.
    """
    geometry = []
    for staff, ys in staff_lines.items():
        if len(ys) != 5:
            continue
        ys = tuple(sorted(float(y) for y in ys))
        gaps = sorted(b - a for a, b in zip(ys, ys[1:]))
        interline = (gaps[1] + gaps[2]) / 2
        if interline > 0:
            geometry.append((staff, ys[2], interline))
    if not geometry:
        return []

    result = []
    heads = pdf_notehead_glyphs(page)
    accidentals = _smufl_glyphs(page, PDF_ACCIDENTALS)
    for shape, x, y, bbox in heads:
        width = max(1.0, float(bbox[2]) - float(bbox[0]))
        ranked = sorted((abs(y - middle) / interline, staff, middle, interline)
                        for staff, middle, interline in geometry)
        distance, staff, middle, interline = ranked[0]
        if distance > NEAR_STAFF_SPACES:
            others = [d for d, *_ in ranked[1:]]
            if distance > MAX_LEDGER_SPACES or (others and others[0] < distance * LEDGER_CLEARANCE):
                continue
        pitch = round((y - middle) / (interline / 2))
        expected_y = middle + pitch * interline / 2
        if abs(y - expected_y) > interline * .24:
            continue
        result.append({'staff': staff, 'shape': shape,
                       'accidental': _printed_accidental((shape, x, y, bbox), heads, accidentals, interline),
                       'pitch': pitch, 'confidence': 1.0,
                       'x_pt': float(bbox[0]), 'y_pt': y - interline / 2,
                       'w_pt': width, 'h_pt': interline,
                       'cx_pt': float(bbox[0]) + width / 2, 'cy_pt': y,
                       'vector_pdf': True})
    return result


def merge_vector_pdf_noteheads(page, heads, staff_lines, sx, sy, page_number):
    """Append only vector-PDF heads that have no matching OMR head."""
    lines_pt = {staff: tuple(y * sy for y in ys) for staff, ys in staff_lines.items()}
    added = 0
    for index, candidate in enumerate(vector_pdf_noteheads(page, lines_pt)):
        nearby = any(
            head['staff'] == candidate['staff']
            and abs(head['cx'] * sx - candidate['cx_pt']) <= max(2.0, candidate['w_pt'] * .55)
            and abs(head['cy'] * sy - candidate['cy_pt']) <= candidate['h_pt'] * .55
            for head in heads
        )
        if nearby:
            continue
        heads.append({
            'staff': candidate['staff'], 'shape': candidate['shape'],
            'id': f'pdf-head-{page_number}-{index}', 'pitch': candidate['pitch'],
            'confidence': candidate['confidence'],
            'x': candidate['x_pt'] / sx, 'y': candidate['y_pt'] / sy,
            'w': candidate['w_pt'] / sx, 'h': candidate['h_pt'] / sy,
            'cx': candidate['cx_pt'] / sx, 'cy': candidate['cy_pt'] / sy,
            'vector_pdf': True, 'pdf_accidental': candidate['accidental'],
        })
        added += 1
    return added


def page_structure(root, staff_lines):
    """One printed region per system stack, not one per part measure."""
    regions, chord_meta = [], {}
    for system_index, system in enumerate(root.findall('.//system')):
        staves = [s for p in system.findall('part') for s in p.findall('staff')]
        ids = [int(s.get('id')) for s in staves]
        ys = [y for sid in ids for y in staff_lines.get(sid, ())]
        stacks = system.findall('stack')
        for local, stack in enumerate(stacks):
            pad = max(8, (max(ys) - min(ys)) * .12) if ys else 0
            bbox = [float(stack.get('left')), min(ys) - pad,
                    float(stack.get('right')), max(ys) + pad] if ys else None
            region = {'system': system_index, 'system_measure': local,
                      'label': stack.get('id'), 'bbox_px': bbox, 'staff_ids': ids}
            regions.append(region)
            slots = {s.get('id'): float(Fraction(s.get('time-offset'))) * 4
                     for s in stack.findall('slot') if s.get('time-offset') is not None}
            for part_index, part in enumerate(system.findall('part')):
                measures = part.findall('measure')
                measure = next((m for m in measures if m.get('id') == stack.get('id')), None)
                if measure is None:
                    continue
                defaults = {'system': system_index, 'system_measure': local,
                            'measure_label': stack.get('id'), 'part': part_index,
                            'onset': None, 'voice': None}
                for cid in measure.findtext('head-chords', '').split():
                    chord_meta[cid] = dict(defaults)
                for voice in measure.findall('voice'):
                    for entry in voice.findall('slots/entry'):
                        value = entry.find('value')
                        if value is None or value.get('status') != 'BEGIN':
                            continue
                        cid = value.get('chord')
                        chord_meta[cid] = dict(defaults, voice=voice.get('id'), onset=slots.get(entry.findtext('key')))
    return regions, chord_meta


def resolve_score_notes(pdf_path, omr_path, num_pages, page_omr_overrides=None):
    from annotate import pdf_clef_timeline
    pages, all_notes = {}, []
    inherited_keys, inherited_clefs = {}, {}
    # An octave line still running at the foot of a scanned page, for the next.
    carried_octaves = None
    with pymupdf.open(pdf_path) as doc:
        for page in range(1, num_pages + 1):
            src = (page_omr_overrides or {}).get(page, {}).get('omr', omr_path)
            root = _parse_sheet(src, page)
            heads = load_sheet_heads(src, page)
            chords = load_chord_id_groups(src, page)
            staff_lines = load_staff_lines(src, page)
            pic_w, pic_h = get_picture_size(src, page)
            sx, sy = doc[page - 1].rect.width / pic_w, doc[page - 1].rect.height / pic_h
            merge_vector_pdf_noteheads(doc[page - 1], heads, staff_lines, sx, sy, page)
            regions, chord_meta = page_structure(root, staff_lines)
            for r in regions:
                box = r['bbox_px']
                r['bbox_pt'] = [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy] if box else None
            pdf_clefs = pdf_clef_timeline(doc, page, {s: tuple(y * sy for y in ys) for s, ys in staff_lines.items()})
            pdf_octaves = octave_intervals(doc[page - 1], {s: tuple(y * sy for y in ys) for s, ys in staff_lines.items()})
            if is_scanned(doc[page - 1]):
                # A scan has no vector marks to read; find the lines in the
                # picture recognition itself worked from.
                found, carried_octaves = ottava_intervals(src, page, carried_octaves)
                pdf_octaves = {staff: [(left * sx, right * sx, amount) for left, right, amount in spans]
                               for staff, spans in found.items()}
            else:
                carried_octaves = None
            pdf_tempos = metronome_marks(doc[page - 1])
            omr_clefs = load_omr_clefs(src, page)
            keys, alters = load_key_timeline(src, page), load_alter_map(src, page)
            # A head only the PDF had carries the accidental the PDF drew for it.
            alters.update({h['id']: h['pdf_accidental'] for h in heads if h.get('pdf_accidental')})
            roles = {}
            for r in regions:
                for role, sid in enumerate(r['staff_ids']):
                    roles[sid] = (r['system'], role)
            ties, tie_sources = {}, {}
            tie_ids = {s.get('id') for s in root.iter('slur') if s.get('tie') == 'true'}
            for rel in root.iter('relation'):
                link = rel.find('slur-head')
                if link is not None and rel.get('source') in tie_ids:
                    ties.setdefault(rel.get('source'), {})[link.get('side')] = rel.get('target')
            for pair in ties.values():
                if pair.get('LEFT') and pair.get('RIGHT'):
                    tie_sources[pair['RIGHT']] = pair['LEFT']
            by_staff = defaultdict(list)
            for h in heads:
                by_staff[h['staff']].append(h)
            resolved = {}
            for staff, staff_heads in sorted(by_staff.items(), key=lambda item: roles.get(item[0], (0, item[0]))):
                system, role = roles.get(staff, (0, 0))
                default_key = inherited_keys.get(role, 0)
                default_clef = inherited_clefs.get(role, 'G' if role == 0 else 'F')
                states, uncertain_states = {}, set()
                # Read left-to-right; simultaneous heads are resolved as a batch
                # so conflicting voice accidentals cannot depend on XML order.
                batches = defaultdict(list)
                for h in staff_heads:
                    meta = chord_meta.get(chords.get(h['id']), {})
                    local = meta.get('system_measure')
                    region = None
                    if local is None:
                        region = next((r for r in regions if r['system'] == system and r['bbox_px']
                                       and r['bbox_px'][0] <= h['cx'] < r['bbox_px'][2]), None)
                        local = region['system_measure'] if region else None
                    defaults = {'measure_label': region['label'] if region else None,
                                'part': 0, 'onset': None, 'voice': None}
                    h['_meta'] = {**defaults, **meta, 'system': system,
                                  'system_measure': local}
                    time = meta.get('onset')
                    batches[(local if local is not None else -1, time if time is not None else h['cx'])].append(h)
                for _, batch in sorted(batches.items()):
                    updates = defaultdict(set)
                    for h in batch:
                        if h['pitch'] is None:
                            continue
                        meta = h['_meta']
                        omr_clef = _at(omr_clefs.get(staff, []), h['cx'], default_clef)
                        pdf_clef = _at(pdf_clefs.get(staff, []), h['cx'] * sx, None)
                        clef = pdf_clef or omr_clef
                        ref = clef_reference(clef)
                        if ref is None:
                            continue  # unsupported clef is not silently treble
                        diatonic = h['pitch'] + ref
                        fifths = _at(keys.get(staff, []), h['cx'], default_key)
                        key_position = _at([(x, x) for x, _ in keys.get(staff, [])], h['cx'], None)
                        state_key = (meta['system_measure'], key_position, diatonic)
                        acc = states.get(state_key, _key_alter(diatonic, fifths))
                        shape = alters.get(h['id'])
                        if shape in ALTER:
                            acc = ALTER[shape]
                            updates[state_key].add(acc)
                        tied = resolved.get(tie_sources.get(h['id']))
                        if tied is not None:
                            diatonic, acc = tied['diatonic'], tied['alter']
                        note = {k: v for k, v in h.items() if not k.startswith('_')}
                        note.update(meta, page=page, role=role, hand=None,
                                    source_id=f'{page}:{h["id"]}', chord_id=chords.get(h['id'], h['id']),
                                    diatonic=diatonic, alter=acc, midi=midi_of(diatonic, acc),
                                    clef=clef, clef_source='pdf' if pdf_clef else 'omr',
                                    recognized_clef=omr_clef, key_fifths=fifths,
                                    bbox_pt=[h['x'] * sx, h['y'] * sy, (h['x'] + h['w']) * sx, (h['y'] + h['h']) * sy],
                                    pitch_uncertain=state_key in uncertain_states)
                        note['_state_key'] = state_key
                        if staff in pdf_octaves:
                            note['pdf_octave_shift'] = sum(amount for left, right, amount in pdf_octaves[staff] if left <= h['cx'] * sx <= right)
                            note['label_diatonic'] = diatonic - note['pdf_octave_shift'] * 7
                        resolved[h['id']] = note
                    for key, values in updates.items():
                        if len(values) == 1:
                            states[key] = next(iter(values))
                            uncertain_states.discard(key)
                            for h in batch:
                                n = resolved.get(h['id'])
                                if n and n['_state_key'] == key:
                                    n['pitch_uncertain'] = False
                                    if alters.get(h['id']) not in ALTER and h['id'] not in tie_sources:
                                        n['alter'] = states[key]
                                        n['midi'] = midi_of(n['diatonic'], n['alter'])
                        else:
                            states.pop(key, None)
                            uncertain_states.add(key)
                            for h in batch:
                                if h['id'] in resolved:
                                    resolved[h['id']]['pitch_uncertain'] = True
                inherited_keys[role] = keys.get(staff, [(0, default_key)])[-1][1]
                inherited_clefs[role] = _at(omr_clefs.get(staff, []), float('inf'), default_clef)
            page_notes = list(resolved.values())
            for n in page_notes:
                n.pop('_state_key', None)
            tempo_events = []
            for mark in pdf_tempos:
                above = [(min(staff_lines[sid]) * sy - mark['y'], r) for r in regions
                         for sid in r['staff_ids'][:1] if min(staff_lines.get(sid, [0])) * sy > mark['y']]
                if not above:
                    continue
                distance, first = min(above, key=lambda pair: pair[0])
                if distance > 100:
                    continue
                system_regions = [r for r in regions if r['system'] == first['system'] and r['bbox_pt']]
                region = next((r for r in system_regions if r['bbox_pt'][2] >= mark['x']), None)
                if region:
                    following = [n for n in page_notes if n['system'] == region['system'] and n['system_measure'] == region['system_measure']
                                 and n['bbox_pt'][0] >= mark['x'] - 3 and n.get('onset') is not None]
                    onset = min((n['onset'] for n in following), default=0)
                    tempo_events.append({'system': region['system'], 'system_measure': region['system_measure'],
                                         'beat': onset, 'kind': 'tempo', 'value': mark['bpm'],
                                         'beat_unit_quarters': mark['beat_unit_quarters'],
                                         'part': 0, 'staff': 1, 'source': 'pdf'})
            pages[page] = {'regions': regions, 'notes': page_notes, 'tempo_events': tempo_events,
                           'staff_lines_pt': {s: [y * sy for y in ys] for s, ys in staff_lines.items()}}
            all_notes.extend(page_notes)
    return {'pages': pages, 'notes': all_notes}
