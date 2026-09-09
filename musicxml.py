"""MusicXML printed notes, layout and performance instructions (stdlib only).

Cursor arithmetic uses quarter-note beats, including divisions changes.
Printed notes remain separate from performed occurrences and sounding events.
"""
import re
import zipfile
import xml.etree.ElementTree as ET
from fractions import Fraction


def _score_root(mxl_path):
    with zipfile.ZipFile(mxl_path) as z:
        try:
            entry = ET.fromstring(z.read('META-INF/container.xml')).find('.//{*}rootfile')
            name = entry.get('full-path') if entry is not None else None
        except (KeyError, ET.ParseError):
            name = None
        if not name:
            names = [n for n in z.namelist() if n.lower().endswith('.xml') and not n.startswith('META-INF/')]
            if not names:
                raise ValueError(f'no score XML inside {mxl_path}')
            name = names[0]
        return ET.fromstring(z.read(name))


def _number(value, default=0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int_text(el, default=0):
    return int(_number(el.text if el is not None else None, default))


def _tag(el):
    return el.tag.split('}')[-1]


def _ending_numbers(value):
    out = set()
    for token in (value or '').replace(' ', '').split(','):
        if re.fullmatch(r'\d+-\d+', token):
            a, b = map(int, token.split('-'))
            out.update(range(a, min(b, a + 100) + 1))
        elif token.isdigit():
            out.add(int(token))
    return sorted(out)


_DYNAMICS = {'ppp': 28, 'pp': 40, 'p': 52, 'mp': 64, 'mf': 80,
             'f': 96, 'ff': 110, 'fff': 120, 'sfz': 112, 'fp': 96}
_UNITS = {'whole': 4, 'half': 2, 'quarter': 1, 'eighth': .5, '16th': .25, '32nd': .125, '64th': .0625}


def _direction(el, cursor, divisions, staff, part, shifts, meta):
    when = max(0.0, float(cursor + Fraction(el.findtext('{*}offset', '0')) / divisions))
    base = {'beat': when, 'staff': staff, 'part': part}
    events = meta['events']
    sound = el if _tag(el) == 'sound' else el.find('{*}sound')
    if sound is not None:
        for attr in ('dacapo', 'dalsegno', 'segno', 'coda', 'tocoda', 'fine', 'forward-repeat'):
            if sound.get(attr) is not None:
                meta['navigation'][attr] = sound.get(attr)
        if _number(sound.get('tempo')) > 0:
            events.append(dict(base, kind='tempo', value=_number(sound.get('tempo'))))
        if sound.get('dynamics') is not None:
            events.append(dict(base, kind='dynamic', value=max(1, min(127, _number(sound.get('dynamics')) * .9))))
        if sound.get('damper-pedal') is not None:
            value = sound.get('damper-pedal')
            events.append(dict(base, kind='pedal', value='start' if value == 'yes' or _number(value) > 0 else 'stop'))
    for dt in el.findall('{*}direction-type'):
        for mark in dt:
            kind = _tag(mark)
            if kind == 'octave-shift':
                key = (staff, mark.get('number', '1'))
                amount = (int(mark.get('size', '8')) - 1) // 7
                if mark.get('type') != 'continue':
                    shifts[key] = amount if mark.get('type') == 'down' else -amount if mark.get('type') == 'up' else 0
            elif kind == 'pedal' and (sound is None or sound.get('damper-pedal') is None):
                events.append(dict(base, kind='pedal', value=mark.get('type', 'stop')))
            elif kind == 'dynamics' and (sound is None or sound.get('dynamics') is None):
                for d in mark:
                    if _tag(d) in _DYNAMICS:
                        events.append(dict(base, kind='dynamic', value=_DYNAMICS[_tag(d)]))
            elif kind == 'metronome':
                bpm = _number(mark.findtext('{*}per-minute'))
                unit = _UNITS.get(mark.findtext('{*}beat-unit'), 1)
                dots = len(mark.findall('{*}beat-unit-dot'))
                if bpm > 0:
                    quarters = unit * (2 - .5 ** dots)
                    if sound is not None and _number(sound.get('tempo')) > 0:
                        # Sound tempo remains in quarter notes; keep the printed
                        # unit for the control even when both encodings exist.
                        for event in reversed(events):
                            if event['kind'] == 'tempo' and event['beat'] == when:
                                event['beat_unit_quarters'] = quarters
                                break
                    else:
                        events.append(dict(base, kind='tempo', value=bpm * quarters,
                                           beat_unit_quarters=quarters))
            elif kind == 'wedge':
                events.append(dict(base, kind='wedge', value=mark.get('type'), number=mark.get('number', '1')))
            elif kind in ('segno', 'coda'):
                meta['navigation'].setdefault(kind, '1')
            elif kind == 'words':
                words = ' '.join(mark.itertext()).strip()
                if words:
                    events.append(dict(base, kind='text', value=words))


def _parse_part(part, part_ordinal, default_staff):
    notes, measures = [], []
    divisions, nominal = Fraction(1), 4.0
    page, system, system_measure = 1, 0, 0
    clefs, shifts, keys, transposes = {}, {}, {}, {}
    active_endings, label_counts = [], {}
    staffless = part.find('.//{*}staff') is None
    for measure in part.findall('{*}measure'):
        label = measure.get('number') or str(len(measures) + 1)
        occurrence = label_counts.get(label, 0)
        label_counts[label] = occurrence + 1
        identity = (label, occurrence)
        pr = measure.find('{*}print')
        if pr is not None:
            if pr.get('new-page') == 'yes':
                page += 1
                system, system_measure = 0, 0
            elif pr.get('new-system') == 'yes':
                system += 1
                system_measure = 0
        cursor = high = last_start = Fraction(0)
        meta = {'label': label, 'identity': identity, 'page': page,
                'system': system, 'system_measure': system_measure,
                'implicit': measure.get('implicit') == 'yes',
                'width': _number(measure.get('width')), 'events': [],
                'warnings': [], 'rests': [], 'repeat_forward': False,
                'repeat_backward': 0, 'endings': list(active_endings), 'navigation': {}}
        system_measure += 1
        for el in measure:
            tag = _tag(el)
            if tag == 'attributes':
                div = el.findtext('{*}divisions')
                if div is not None and _number(div) > 0:
                    divisions = Fraction(div)
                time = el.find('{*}time')
                if time is not None:
                    if time.find('{*}senza-misura') is not None:
                        nominal = 0.0
                    else:
                        pairs = zip(time.findall('{*}beats'), time.findall('{*}beat-type'))
                        nominal = sum(sum(_number(b) for b in (a.text or '').split('+'))
                                      * 4 / max(1, _int_text(t, 4)) for a, t in pairs)
                for key in el.findall('{*}key'):
                    keys[int(key.get('number', '0'))] = _int_text(key.find('{*}fifths'))
                for clef in el.findall('{*}clef'):
                    clef_staff = default_staff if staffless else int(clef.get('number', '1'))
                    clefs[clef_staff] = {
                        'sign': clef.findtext('{*}sign', 'G'), 'line': _int_text(clef.find('{*}line'), 2),
                        'octave': _int_text(clef.find('{*}clef-octave-change'))}
                for tr in el.findall('{*}transpose'):
                    transposes[int(tr.get('number', '0'))] = _int_text(tr.find('{*}chromatic')) + 12 * _int_text(tr.find('{*}octave-change'))
            elif tag in ('backup', 'forward'):
                duration = Fraction(el.findtext('{*}duration', '0')) / divisions
                cursor += duration if tag == 'forward' else -duration
                if cursor < 0:
                    meta['warnings'].append('Voice backup extends before the measure.')
                    cursor = Fraction(0)
                high = max(high, cursor)
            elif tag in ('direction', 'sound'):
                _direction(el, cursor, divisions, _int_text(el.find('{*}staff'), default_staff), part_ordinal, shifts, meta)
            elif tag == 'barline':
                repeat = el.find('{*}repeat')
                if repeat is not None:
                    if repeat.get('direction') == 'forward':
                        meta['repeat_forward'] = True
                    else:
                        meta['repeat_backward'] = max(2, min(32, int(repeat.get('times', '2'))))
                ending = el.find('{*}ending')
                if ending is not None:
                    nums = _ending_numbers(ending.get('number'))
                    if ending.get('type') == 'start':
                        active_endings = nums
                        meta['endings'] = nums
                    else:
                        meta['endings'] = active_endings or nums
                        active_endings = []
            elif tag == 'note':
                chord = el.find('{*}chord') is not None
                grace_el = el.find('{*}grace')
                grace = grace_el is not None
                duration = Fraction(el.findtext('{*}duration', '0')) / divisions
                start = last_start if chord else cursor
                if not chord:
                    last_start = start  # also for grace chords
                pitch = el.find('{*}pitch')
                if el.find('{*}rest') is not None:
                    meta['rests'].append({'staff': _int_text(el.find('{*}staff'), default_staff),
                                          'start': float(start), 'duration': float(duration)})
                if pitch is not None and el.find('{*}cue') is None:
                    staff = _int_text(el.find('{*}staff'), default_staff)
                    clef = clefs.get(staff, {'sign': 'G', 'line': 2, 'octave': 0})
                    shift = sum(v for (s, _), v in shifts.items() if s == staff)
                    ties = [t.get('type') for t in el.findall('{*}tie')]
                    arts = [_tag(a) for a in el.findall('{*}notations/{*}articulations/*')]
                    ornaments = [_tag(a) for a in el.findall('{*}notations/{*}ornaments/*')]
                    unsupported = [name for name in ornaments if name not in {
                        'trill-mark', 'mordent', 'inverted-mordent', 'turn', 'inverted-turn',
                        'wavy-line', 'accidental-mark'}]
                    if unsupported:
                        meta['warnings'].append('Unsupported ornaments need review: ' + ', '.join(unsupported))
                    grace_data = dict(grace_el.attrib) if grace else {}
                    if grace and grace_el.get('make-time'):
                        grace_data['make-time-beats'] = float(Fraction(grace_el.get('make-time')) / divisions)
                    notes.append({'identity': identity, 'label': label, 'part': part_ordinal,
                                  'staff': staff, 'voice': el.findtext('{*}voice', '1'),
                                  'step': pitch.findtext('{*}step', 'C').strip(),
                                  'octave': _int_text(pitch.find('{*}octave'), 4),
                                  'alter': _number(pitch.findtext('{*}alter')),
                                  'start_beat_in_measure': float(start), 'duration_beats': 0.0 if grace else float(duration),
                                  'is_grace': grace, 'grace': grace_data,
                                  'chord': chord, 'tie_start': 'start' in ties, 'tie_stop': 'stop' in ties,
                                  'articulations': arts, 'ornaments': ornaments,
                                  'fermata': el.find('{*}notations/{*}fermata') is not None,
                                  'arpeggiate': el.find('{*}notations/{*}arpeggiate') is not None,
                                  'fingering': el.findtext('{*}notations/{*}technical/{*}fingering'),
                                  'clef': dict(clef), 'octave_shift': shift,
                                  'key_fifths': keys.get(staff, keys.get(0, 0)),
                                  'transpose': transposes.get(staff, transposes.get(0, 0)),
                                  'default_x': _number(el.get('default-x'), None),
                                  'source_id': f'{part_ordinal}:{label}:{occurrence}:{len(notes)}'})
                if not grace:
                    high = max(high, start + duration)
                    if not chord:
                        cursor += duration
        meta.update(nominal_length_beats=nominal, content_length_beats=float(high))
        measures.append(meta)
    return notes, measures


def _merge_label_order(sequences):
    sequences = [s for s in sequences if s]
    if not sequences:
        return []
    spine = list(max(sequences, key=len))
    for seq in sequences:
        pos = -1
        for label in seq:
            if label in spine:
                pos = spine.index(label)
            else:
                pos += 1
                spine.insert(pos, label)
    return spine


def load_score_notes(mxl_path):
    parts = _score_root(mxl_path).findall('{*}part')
    if not parts:
        raise ValueError(f'no part in {mxl_path}')
    parsed, staffless = [], 0
    for ordinal, part in enumerate(parts):
        default_staff = 1
        if part.find('.//{*}staff') is None:
            default_staff = 1 + staffless % 2
            staffless += 1
        parsed.append(_parse_part(part, ordinal, default_staff))
    order = _merge_label_order([[m['identity'] for m in ms] for _, ms in parsed])
    by_id, notes = {}, []
    # Longest part supplies layout; sparse invented parts must not move it.
    for part_notes, ms in sorted(parsed, key=lambda p: len(p[1]), reverse=True):
        notes.extend(part_notes)
        for m in ms:
            if m['identity'] not in by_id:
                by_id[m['identity']] = m
            else:
                old = by_id[m['identity']]
                for field in ('nominal_length_beats', 'content_length_beats'):
                    old[field] = max(old[field], m[field])
                old['events'].extend(e for e in m['events'] if e not in old['events'])
                old['rests'].extend(m['rests'])
                old['navigation'].update(m['navigation'])
                old['repeat_forward'] |= m['repeat_forward']
                old['repeat_backward'] = max(old['repeat_backward'], m['repeat_backward'])
                old['endings'] = sorted(set(old['endings'] + m['endings']))
    measures = []
    index_of = {identity: i for i, identity in enumerate(order)}
    for index, identity in enumerate(order):
        m = by_id[identity]
        nominal, content = m['nominal_length_beats'], m['content_length_beats']
        irregular = m['implicit'] or nominal == 0 or m['label'].startswith('X')
        pickup = index == 0 and 0 < content < nominal
        m['length_beats'] = content if irregular or pickup else max(nominal, content)
        m['measure_index'] = index
        if nominal and abs(content - nominal) > 1e-7 and not irregular:
            m['warnings'].append('Inferred pickup length.' if pickup else 'Recognized duration differs from the time signature.')
        measures.append(m)
    for n in notes:
        n['measure_index'] = index_of[n['identity']]
    notes.sort(key=lambda n: (n['measure_index'], n['start_beat_in_measure'], n['part'], n['voice']))
    return notes, measures


def performance_order(measures):
    """Bounded repeat/ending and D.C./D.S./coda traversal of printed measures."""
    pairs, stack = {}, []
    for i, m in enumerate(measures):
        if m.get('repeat_forward'):
            stack.append(i)
        if m.get('repeat_backward'):
            pairs[i] = stack.pop() if stack else 0
    counts, result, warnings = {}, [], []
    i, last_pass, jumped = 0, 1, False
    used_jumps = set()
    limit = max(1024, len(measures) * 64)
    steps = 0
    while 0 <= i < len(measures) and steps < limit:
        steps += 1
        m = measures[i]
        enclosing = [(end, start) for end, start in pairs.items() if start <= i <= end]
        pass_no = counts.get(min(enclosing)[0], 0) + 1 if enclosing else last_pass
        orphan_ending = bool(m.get('endings')) and not enclosing and last_pass == 1
        if orphan_ending:
            warnings.append('Ending brackets without a recognized repeat are played in printed order.')
        allowed = orphan_ending or not m.get('endings') or pass_no in m['endings']
        if allowed:
            result.append(i)
        nav = m.get('navigation', {})
        if allowed and jumped and nav.get('fine'):
            break
        if allowed and jumped and nav.get('tocoda') and ('coda', i) not in used_jumps:
            dest = next((j for j, x in enumerate(measures) if x.get('navigation', {}).get('coda') == nav['tocoda']), None)
            used_jumps.add(('coda', i))
            if dest is not None:
                i = dest
                continue
            warnings.append('Coda destination was not found.')
        if allowed and (nav.get('dacapo') == 'yes' or nav.get('dalsegno')) and ('jump', i) not in used_jumps:
            used_jumps.add(('jump', i))
            dest = 0 if nav.get('dacapo') == 'yes' else next((j for j, x in enumerate(measures)
                     if x.get('navigation', {}).get('segno') == nav.get('dalsegno')), None)
            if dest is not None:
                jumped, i = True, dest
                continue
            warnings.append('Segno destination was not found.')
        if i in pairs:
            repeat_count = counts.get(i, 0) + 1
            last_pass = repeat_count
            if not jumped and repeat_count < m['repeat_backward']:
                counts[i] = repeat_count
                for end, start in pairs.items():
                    if pairs[i] <= start and end < i:
                        counts.pop(end, None)
                i = pairs[i]
                continue
        elif not m.get('endings') and not enclosing:
            last_pass = 1
        i += 1
    if steps >= limit:
        warnings.append('Repeat traversal limit reached; check navigation marks.')
    return result, warnings
