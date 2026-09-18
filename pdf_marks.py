"""Conservative recovery of readable vector-PDF octave lines and metronomes.

Only explicit music glyphs/text with supporting geometry are accepted. Scans
and unsupported fonts return no evidence and keep the recognition fallback.
SMuFL references: W3C 1.4 tables/octaves.html and tables/metronome-marks.html.
"""
import re

OCTAVES = {0xE510: 1, 0xE511: 1, 0xE512: 1, 0xE513: 1,
           0xE514: 2, 0xE515: 2, 0xE516: 2,
           0xE517: 3, 0xE518: 3, 0xE519: 3,
           0xE51C: 1, 0xE51D: 2, 0xE51E: 3}
# Legacy Opus fonts predate SMuFL and expose notation glyphs through unrelated
# Unicode characters. In OpusSpecialStd, these render as 8va and 8.
LEGACY_OCTAVES = {('OpusSpecialStd', '”“'): 1,
                  ('OpusSpecialStd', '“'): 1}
METRONOMES = {0xECA2: 4, 0xECA3: 2, 0xECA4: 2, 0xECA5: 1,
              0xECA6: 1, 0xECA7: .5, 0xECA8: .5, 0xECA9: .25,
              0xECAA: .25, ord('♩'): 1, ord('♪'): .5}


# The wavy vertical line before a chord, meaning roll it rather than strike it
# together. Engravers build one sign by tiling a single wiggle glyph down the
# height of the chord, and draw it rotated, so each tile reports a wide
# unrotated bounding box and only its origin says where it actually sits.
ARPEGGIO_TILES = {0xEAA9, 0xEAAA}


def arpeggio_signs(page):
    """Arpeggio marks the engraving draws, as [(x, top, bottom)] in points.

    Tiles are grouped into one sign per column of touching glyphs: two chords
    rolled at the same horizontal position in different systems are separate
    signs, and a gap down the column is what separates them.

    Positions come from glyph origins, never bounding boxes - these glyphs are
    placed rotated, so a tile reports an 80pt-wide box for a 6pt-wide mark.
    """
    # rawdict, not text_spans: only the raw form carries per-character
    # origins, and a span's own box is useless for a rotated glyph.
    columns = {}
    for block in page.get_text('rawdict')['blocks']:
        for line in block.get('lines', []):
            for span in line.get('spans', []):
                for char in span.get('chars', []):
                    if ord(char['c']) in ARPEGGIO_TILES:
                        x, y = char['origin']
                        columns.setdefault(round(x / 2), []).append((x, y))
    signs = []
    for tiles in columns.values():
        tiles.sort(key=lambda t: t[1])
        run = [tiles[0]]
        for tile in tiles[1:]:
            # Tiles of one sign abut; anything looser is a different chord.
            if tile[1] - run[-1][1] <= 8:
                run.append(tile)
            else:
                signs.append(run)
                run = [tile]
        signs.append(run)
    return [(sum(t[0] for t in run) / len(run), run[0][1], run[-1][1]) for run in signs]


def text_spans(page):
    return [s for b in page.get_text('dict')['blocks'] for line in b.get('lines', []) for s in line['spans']]


def time_signatures(page):
    """Read stacked time digits using baselines, not font bounding boxes.

    Two encodings occur in practice. SMuFL fonts put the digits in the
    private-use range (U+E080-E089), which is unambiguous. MuseScore's own
    font instead maps them to plain ASCII digits, and those cannot be trusted
    on sight - a page number, a rehearsal mark and a fingering are all ASCII
    digits too. A font that draws private-use music glyphs somewhere on this
    page is a notation font, so its digits are notation digits; that is what
    separates the two cases without hard-coding font names.
    """
    chars = [(ord(c['c']), c['origin'], span.get('font', ''))
             for block in page.get_text('rawdict')['blocks']
             for line in block.get('lines', [])
             for span in line['spans']
             for c in span.get('chars', [])]
    music_fonts = {font for code, _, font in chars if 0xE000 <= code <= 0xF8FF}

    rows, marks = {}, []
    for code, (x, y), font in chars:
        if code in (0xE08A, 0xE08B):
            marks.append(dict(x=x, y=y, beats=4.0))
            continue
        if 0xE080 <= code <= 0xE089:
            digit, ascii_source = str(code - 0xE080), False
        elif 0x30 <= code <= 0x39 and font in music_fonts:
            digit, ascii_source = chr(code), True
        else:
            continue
        rows.setdefault(round(y, 1), []).append((x, digit, ascii_source))
    groups = []
    for y, digits in rows.items():
        for x, digit, ascii_source in sorted(digits):
            if groups and groups[-1]['y'] == y and x - groups[-1]['right'] < 12:
                groups[-1]['text'] += digit
                groups[-1]['right'] = x
            else:
                groups.append(dict(x=x, right=x, y=y, text=digit, ascii=ascii_source))
    for upper in groups:
        lower = [g for g in groups if 4 < g['y'] - upper['y'] < 20
                 and abs((g['x'] + g['right'] - upper['x'] - upper['right']) / 2) < 5]
        if len(lower) == 1:
            num, den = int(upper['text']), int(lower[0]['text'])
            # A stacked pair of ASCII digits is far weaker evidence than a
            # private-use one - two fingerings on a chord stack the same way -
            # so only conventional lower numerals are accepted there. "5 over
            # 1" is a plausible fingering and an implausible meter.
            denominators = (2, 4, 8, 16) if upper['ascii'] else (1, 2, 4, 8, 16, 32)
            if 1 <= num <= 32 and den in denominators:
                marks.append(dict(x=upper['x'], y=(upper['y'] + lower[0]['y']) / 2,
                                  beats=num * 4 / den))
    return marks


def octave_intervals(page, staff_lines):
    dashed = []
    for drawing in page.get_drawings():
        if not drawing.get('dashes') or drawing['dashes'].startswith('[]'):
            continue
        for item in drawing['items']:
            if item[0] == 'l':
                a, b = item[1:3]
                if abs(a.y - b.y) < 1 and abs(a.x - b.x) > 20:
                    dashed.append((min(a.x, b.x), max(a.x, b.x), (a.y + b.y) / 2))
    intervals = {}
    for span in text_spans(page):
        text = span['text'].strip()
        amount = LEGACY_OCTAVES.get((span.get('font'), text))
        direction = 1 if amount is not None else None
        if amount is None:
            amount = OCTAVES.get(ord(text)) if len(text) == 1 else None
        suffix = ''
        label = text
        if amount is None:
            match = re.fullmatch(r'(8(?:va|vb)?|15(?:ma)?|22)([-–—]*)', text, re.IGNORECASE)
            if match:
                label, suffix = match.groups()
                amount = {'8': 1, '8va': 1, '8vb': 1,
                          '15': 2, '15ma': 2, '22': 3}.get(label.lower())
                if label.lower() in ('8va', '15ma'):
                    direction = 1
                elif label.lower() == '8vb':
                    direction = -1
        if amount is None:
            continue
        x0, y0, x1, y1 = span['bbox']
        # A suffix belongs to the continuation, not the label. Match vector
        # lines against the end of the label portion so an overlapping line is
        # not rejected merely because its first dashes share this text span.
        label_right = x1
        if suffix:
            label_right = x0 + (x1 - x0) * len(label) / len(text)
        lines = [(a, b, y) for a, b, y in dashed
                 if -3 <= a - label_right <= 20 and y0 - 2 <= y <= y1 + 2]
        # Some exporters encode the complete continuation as horizontally
        # stretched hyphens in the label span and emit no vector line at all.
        if not lines and suffix and x1 - label_right > 20:
            lines = [(label_right, x1, (y0 + y1) / 2)]
        if len(lines) != 1:
            continue
        _, right, y = lines[0]
        candidates = []
        for staff, ys in staff_lines.items():
            if direction != -1 and y < min(ys):
                candidates.append((min(ys) - y, staff, 1))
            elif direction != 1 and y > max(ys):
                candidates.append((y - max(ys), staff, -1))
        if not candidates:
            continue
        candidates.sort()
        distance, staff, sign = candidates[0]
        if distance > 65 or len(candidates) > 1 and candidates[1][0] - distance < 3:
            continue
        intervals.setdefault(staff, []).append((x0 - 2, right + 2, sign * amount))
    return intervals


def metronome_marks(page):
    spans = text_spans(page)
    marks = []
    for span in spans:
        text = span['text'].strip()
        if not text or ord(text[0]) not in METRONOMES:
            continue
        x0, y0, x1, y1 = span['bbox']
        near = [s for s in spans if s['bbox'][0] >= x0 - 1 and s['bbox'][0] < x1 + 65
                and abs((s['bbox'][1] + s['bbox'][3] - y0 - y1) / 2) < 5
                and s['bbox'][3] - s['bbox'][1] <= (y1 - y0) * 1.5]
        joined = ''.join(s['text'] for s in sorted(near, key=lambda s: s['bbox'][0]))
        match = re.match(r'^.\s*([\uECB7.·]*)\s*=\s*(\d+(?:\.\d+)?)\b', joined)
        if match:
            unit = METRONOMES[ord(text[0])]
            dots = len(match.group(1))
            bpm = float(match.group(2)) * unit * (2 - .5 ** dots)
            if 10 <= bpm <= 600:
                marks.append({'x': x0, 'y': (y0 + y1) / 2, 'bpm': bpm,
                              'beat_unit_quarters': unit * (2 - .5 ** dots)})
    return marks
