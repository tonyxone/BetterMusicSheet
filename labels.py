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


# ---- numbered notation (jianpu) and solfège --------------------------------
# Fixed-do: 1 = C, 2 = D, ... 7 = B (do re mi fa so la si) whatever the key, so
# a degree always means the same piano key. A note on a white key reads as
# that key's degree however it is spelled (E# is 4/mi); one on a black key
# keeps its printed sharp or flat (D# is #2/#re), a double one taking the
# nearest single one (Fbb is b3/bmi). Mirrors
# better_music_sheet_web/lib/notation.ts.

_STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11]
_UNICODE_ACC = {-2: DOUBLE_FLAT, -1: FLAT, 0: '', 1: SHARP, 2: DOUBLE_SHARP}
_ASCII_ACC = {-2: 'bb', -1: 'b', 0: '', 1: '#', 2: '##'}
_SOLFEGE = ['do', 're', 'mi', 'fa', 'so', 'la', 'si']


def _fixed_do_degree(diatonic, alter):
    """A diatonic pitch value + alteration as (scale degree 0..6, alter)."""
    step = _STEPS.index(step_of(diatonic))
    pc = (_STEP_SEMITONES[step] + alter) % 12
    if pc in _STEP_SEMITONES:
        return _STEP_SEMITONES.index(pc), 0
    if abs(alter) > 1:
        alter = 1 if alter > 0 else -1
        step = _STEP_SEMITONES.index((pc - alter) % 12)
        return step, alter
    return step, alter


def numbered_label(diatonic, alter, style='unicode'):
    """A diatonic pitch value + its alteration as a number: '5', '♯4', 'b7'."""
    step, alter = _fixed_do_degree(diatonic, alter)
    return (_ASCII_ACC if style == 'ascii' else _UNICODE_ACC).get(alter, '') + str(step + 1)


def solfege_label(diatonic, alter, style='unicode'):
    """A diatonic pitch value + its alteration as a fixed-do solfège syllable:
    'so', '♯fa', 'bsi'."""
    step, alter = _fixed_do_degree(diatonic, alter)
    return (_ASCII_ACC if style == 'ascii' else _UNICODE_ACC).get(alter, '') + _SOLFEGE[step]
