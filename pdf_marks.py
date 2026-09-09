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
METRONOMES = {0xECA2: 4, 0xECA3: 2, 0xECA4: 2, 0xECA5: 1,
              0xECA6: 1, 0xECA7: .5, 0xECA8: .5, 0xECA9: .25,
              0xECAA: .25, ord('♩'): 1, ord('♪'): .5}


def text_spans(page):
    return [s for b in page.get_text('dict')['blocks'] for line in b.get('lines', []) for s in line['spans']]


def time_signatures(page):
    """Read stacked SMuFL time digits using baselines, not font bounding boxes."""
    rows, marks = {}, []
    for block in page.get_text('rawdict')['blocks']:
        for line in block.get('lines', []):
            for span in line['spans']:
                for char in span['chars']:
                    code = ord(char['c'])
                    if code in (0xE08A, 0xE08B):
                        x, y = char['origin']
                        marks.append(dict(x=x, y=y, beats=4.0))
                    if 0xE080 <= code <= 0xE089:
                        x, y = char['origin']
                        rows.setdefault(round(y, 1), []).append((x, str(code - 0xE080)))
    groups = []
    for y, digits in rows.items():
        for x, digit in sorted(digits):
            if groups and groups[-1]['y'] == y and x - groups[-1]['right'] < 12:
                groups[-1]['text'] += digit
                groups[-1]['right'] = x
            else:
                groups.append(dict(x=x, right=x, y=y, text=digit))
    for upper in groups:
        lower = [g for g in groups if 4 < g['y'] - upper['y'] < 20
                 and abs((g['x'] + g['right'] - upper['x'] - upper['right']) / 2) < 5]
        if len(lower) == 1:
            num, den = int(upper['text']), int(lower[0]['text'])
            if 1 <= num <= 32 and den in (1, 2, 4, 8, 16, 32):
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
        amount = OCTAVES.get(ord(text)) if len(text) == 1 else None
        if amount is None:
            amount = {'8': 1, '8va': 1, '8vb': 1, '15': 2, '15ma': 2, '22': 3}.get(text)
        if amount is None:
            continue
        x0, y0, x1, y1 = span['bbox']
        lines = [(a, b, y) for a, b, y in dashed if -3 <= a - x1 <= 20 and y0 - 2 <= y <= y1 + 2]
        if len(lines) != 1:
            continue
        _, right, y = lines[0]
        candidates = []
        for staff, ys in staff_lines.items():
            if y < min(ys):
                candidates.append((min(ys) - y, staff, 1))
            elif y > max(ys):
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
