"""Pitch -> label text formatting."""

FLAT = '♭'
SHARP = '♯'
DOUBLE_FLAT = '\U0001D12B'
DOUBLE_SHARP = '\U0001D12A'

_STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B']

# Diatonic pitch convention used across this project: 0 = B4, 1 = A4, 2 = G4, ...,
# i.e. the number of diatonic steps BELOW B4 (matches Audiveris's <head pitch> and
# the treble staff's middle line).  The middle line of a bass staff (D3) is 12 steps
# below B4.
PITCH_REF = {'G': 0, 'F': 12}  # diatonic pitch of the staff middle line per clef

_SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
_FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F']


def step_of(diatonic):
    """Letter (C..B) of a diatonic pitch value (0 = B4, 6 = C4, 7 = B3, ...)."""
    return _STEPS[(6 - diatonic) % 7]


def octave_of(diatonic):
    """Octave number of a diatonic pitch value (0 = B4, -1 = C5, 7 = B3, ...)."""
    return 4 - (diatonic // 7)


def key_accidental(diatonic, fifths):
    """Key-signature accidental (None if natural) for a diatonic pitch value."""
    step = step_of(diatonic)
    if fifths > 0:
        return SHARP if step in _SHARP_ORDER[:fifths] else None
    if fifths < 0:
        return FLAT if step in _FLAT_ORDER[:-fifths] else None
    return None


_ALTER_SHAPE = {
    'SHARP': SHARP,
    'FLAT': FLAT,
    'NATURAL': '',
    'DOUBLE_SHARP': DOUBLE_SHARP,
    'DOUBLE_FLAT': DOUBLE_FLAT,
}


def pitch_label(pitch, style='unicode', octave=False):
    """music21 pitch -> display label, e.g. B-4 -> 'B♭' (unicode) or 'Bb' (ascii)."""
    step = pitch.step
    alter = int(pitch.alter)
    if style == 'unicode':
        acc = {-2: DOUBLE_FLAT, -1: FLAT, 0: '', 1: SHARP, 2: DOUBLE_SHARP}.get(alter, '')
    else:
        acc = {-2: 'bb', -1: 'b', 0: '', 1: '#', 2: 'x'}.get(alter, '')
    label = f"{step}{acc}"
    if octave:
        label += str(pitch.octave)
    return label


def diatonic_label(diatonic, accidental=None, style='unicode', octave=False):
    """Format a label from a diatonic pitch value + explicit accidental symbol.

    accidental is a display symbol ('♯', '♭', '𝄪', '𝄫', '') overriding the key
    signature; pass None to apply the key-signature accidental via key_accidental.
    """
    if accidental is None:
        accidental = ''
    if style == 'ascii':
        acc = {'♯': '#', '♭': 'b', '𝄪': 'x', '𝄫': 'bb', '': ''}.get(accidental, accidental)
    else:
        acc = accidental
    label = f"{step_of(diatonic)}{acc}"
    if octave:
        label += str(octave_of(diatonic))
    return label


def alter_symbol(shape, style='unicode'):
    """Map an Audiveris alter shape to a display accidental symbol."""
    sym = _ALTER_SHAPE.get(shape, '')
    if style == 'ascii':
        return {'♯': '#', '♭': 'b', '𝄪': 'x', '𝄫': 'bb', '': ''}.get(sym, sym)
    return sym


# ---- numbered notation (jianpu) --------------------------------------------
# Scale degrees of the key instead of letters. "1" is always the major tonic
# of the key signature (1 = C with no sharps or flats), so a piece in A minor
# reads 6 7 1 ..., as printed jianpu does. A note gets a sharp or flat only
# where it differs from the key; one that would need a double sharp or flat
# reads as the degree it sounds as. Mirrors better_music_sheet_web/lib/notation.ts.

_STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11]
_UNICODE_ACC = {-2: DOUBLE_FLAT, -1: FLAT, 0: '', 1: SHARP, 2: DOUBLE_SHARP}
_ASCII_ACC = {-2: 'bb', -1: 'b', 0: '', 1: '#', 2: '##'}


def _tonic(fifths):
    """(letter index with C = 0, pitch class) of a key signature's major tonic."""
    return (4 * fifths) % 7, (7 * fifths) % 12


def key_name(fifths, style='unicode'):
    """'G', 'E♭', 'F♯' - the name after '1=' for a key signature."""
    step, pc = _tonic(fifths)
    alter = (pc - _STEP_SEMITONES[step] + 6) % 12 - 6
    return _STEPS[step] + (_ASCII_ACC if style == 'ascii' else _UNICODE_ACC)[alter]


def numbered_label(diatonic, alter, fifths, style='unicode'):
    """A diatonic pitch value + its alteration as a scale degree: '5', '♯4', 'b7'."""
    step = _STEPS.index(step_of(diatonic))
    tonic_step, tonic_pc = _tonic(fifths)
    degree = (step - tonic_step) % 7
    expected = (tonic_pc + _STEP_SEMITONES[degree]) % 12
    actual = (_STEP_SEMITONES[step] + alter) % 12
    shift = (actual - expected + 6) % 12 - 6
    if abs(shift) > 1:
        # By sound instead: the degree itself, or the one a semitone away in
        # the direction the note was altered.
        offset = (actual - tonic_pc) % 12
        if offset in _STEP_SEMITONES:
            degree, shift = _STEP_SEMITONES.index(offset), 0
        else:
            shift = 1 if shift > 0 else -1
            degree = _STEP_SEMITONES.index((offset - shift) % 12)
    return (_ASCII_ACC if style == 'ascii' else _UNICODE_ACC).get(shift, '') + str(degree + 1)


def key_marks(timeline, size=7.0, style='unicode'):
    """Where '1=G' goes, as [(page, x, y, text)] in the timeline's points:
    above the start of the first measure on each page and of any measure where
    the key changes. A measure's key is the one most of its notes are in."""
    if not timeline:
        return []
    measures = timeline.get('measures', [])
    counts = {}
    for n in timeline.get('notes', []):
        fifths = n.get('key_fifths')
        index = n.get('measure_index')
        if fifths is None or index is None or index >= len(measures):
            continue
        m = measures[index]
        by_key = counts.setdefault(m.get('printed_index', m.get('index')), {})
        by_key[fifths] = by_key.get(fifths, 0) + 1
    if not counts:
        return []
    # Each printed measure once, in reading order - repeats replay measures.
    printed = {}
    for m in measures:
        printed.setdefault(m.get('printed_index', m.get('index')), m)
    marks, last_key, last_page = [], None, None
    for index in sorted(printed):
        m = printed[index]
        by_key = counts.get(index)
        key = max(by_key.items(), key=lambda kv: kv[1])[0] if by_key else last_key
        if key is None:
            continue
        if m.get('page') and m.get('bbox_pt') and (key != last_key or m['page'] != last_page):
            x0, y0 = m['bbox_pt'][0], m['bbox_pt'][1]
            # Above the top staff line, clear of a treble clef's curl.
            marks.append((m['page'], x0, y0 - size * 1.3, f"1={key_name(key, style)}"))
        last_key = key
        if m.get('page'):
            last_page = m['page']
    return marks
