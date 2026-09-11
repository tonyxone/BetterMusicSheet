"""Music-sheet note-name annotator.

Pipeline: Audiveris OMR (notehead positions + slots) + the PDF's own clef
glyphs -> per-head labels -> label layout (hand-aware placement, vertical
stacking for chords) -> PyMuPDF overlay onto the ORIGINAL vector PDF.

Pitches come from Audiveris's per-notehead ``pitch`` attribute — the note's
diatonic slot, i.e. steps from the staff's middle line (0 = the middle line).
That is converted to an absolute pitch via the clef actually in effect at each
notehead.  The clef timeline is read from the PDF's own clef glyphs, because
Audiveris sometimes misreads a mid-piece clef change (e.g. the left hand
switching to bass clef), which would otherwise silently transpose every pitch
it exports for that passage.  The notehead geometry itself stays exact.
"""
import argparse
import os
import sys

import pymupdf as fitz

from label_layout import layout_page_records as _layout_page_records

from audiveris_heads import (
    load_sheet_heads, group_heads_by_staff, load_chord_id_groups,
    cluster_chords_by_relation, load_staff_lines, load_staff_barlines,
    load_omr_clefs, load_key_signature, load_alter_map, load_tie_stop_heads,
    load_system_staff_groups, get_picture_size,
)
from labels import (
    PITCH_REF, key_accidental, alter_symbol, diatonic_label,
)


def _decode_map(doc, page, font_name):
    """ToUnicode char-code -> original-codepoint map for one embedded font ({} if none)."""
    for f in page.get_fonts():
        xref, ext, stype, basefont, name, encoding = f
        if basefont.lower() != font_name.lower():
            continue
        key = doc.xref_get_key(xref, 'ToUnicode')
        obj = key[1]
        m = str(obj)
        import re
        mm = re.match(r'(\d+) 0 R', m)
        if not mm:
            return {}
        try:
            stream = doc.xref_stream(int(mm.group(1)))
        except Exception:
            return {}
        if not stream:
            return {}
        txt = stream.decode('latin-1', errors='replace')
        pairs = re.findall(r'<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4,8})>', txt)
        return {int(g, 16): int(u, 16) for g, u in pairs}
    return {}


def pdf_clef_timeline(pdf_doc, page_number, staff_lines_pt):
    """Return {staff_id: [(x_pt, kind)]} — clef changes read from the PDF's own glyphs.

    ``staff_lines_pt`` maps omr staff ids to their 5 line y positions in page
    points.  Each clef glyph is assigned to the staff it vertically overlaps the
    most.  An empty dict for a staff means "no PDF clef info — fall back to the
    omr's clefs".

    Only the raw text-layer character codes are matched (G-clef U+E050, F-clef
    U+E062): those are stable across MuseScore 3.5 subsets and MuseScore 4's
    SMuFL font.  Re-encoded subsets are handled via the font's ToUnicode map,
    but only for the G-clef codepoints — the MS3 subset re-encodes noteheads to
    U+E062 as well, so treating a decoded U+E062 as a clef would flag every
    notehead as a bass clef.
    """
    page = pdf_doc[page_number - 1]
    decode_cache = {}
    candidates = []
    d = page.get_text('dict')
    for block in d['blocks']:
        for line in block.get('lines', []):
            for span in line['spans']:
                font = span['font']
                if not any(k in font.lower() for k in ('mscore', 'bravura', 'leland')):
                    continue
                txt = span['text']
                if len(txt) != 1:
                    continue
                cp = ord(txt)
                kind = None
                if cp == 0xE050:
                    kind = 'G'
                elif cp == 0xE062:
                    kind = 'F'
                else:
                    # possibly a re-encoded subset: recover the original codepoint
                    # (only accept G-clef originals; see docstring re: U+E062)
                    fname = font
                    if fname not in decode_cache:
                        decode_cache[fname] = _decode_map(pdf_doc, page, fname)
                    dec = decode_cache[fname].get(cp)
                    if dec is not None and dec != cp and dec in (0xE050, 0xE084):
                        kind = 'G'
                if kind is None:
                    continue
                candidates.append((span['bbox'], kind))

    staff_ranges = {s: (min(ys), max(ys)) for s, ys in staff_lines_pt.items()}
    timeline = {}
    for (x0, y0, x1, y1), kind in candidates:
        best = None
        best_overlap = 0.0
        for staff, (top, bottom) in staff_ranges.items():
            overlap = max(0.0, min(y1, bottom) - max(y0, top))
            if overlap > best_overlap:
                best_overlap = overlap
                best = staff
        if best is None or best_overlap < 3.0:
            continue  # not clearly on any known staff
        timeline.setdefault(best, []).append((x0, kind))
    for xs in timeline.values():
        xs.sort()
    return timeline


def _clef_at(timeline, x, default=None):
    kind = default
    for cx, k in timeline:
        if cx <= x:
            kind = k
        else:
            break
    return kind


def build_records(pdf_path, omr_path, num_pages, style='unicode', octave=False, verbose=True,
                   page_omr_overrides=None, resolved_notes=None, suppress_repeated_chords=True):
    """Return list of label records: {page, part, anchor_x_pt, top_y_pt, bottom_y_pt, labels}.

    One record per simultaneous-note group (Audiveris's own head-chord grouping),
    for every notehead Audiveris detected.  Pitches are Audiveris's per-head
    diatonic pitches corrected for the clef the PDF actually shows.

    ``page_omr_overrides``: optional {page_number: {"omr": path, "mxl": path}},
    for pages that were re-recognized separately (e.g. re-run at a higher DPI
    because the default pass badly under-detected that page) - such a page is
    read entirely from its own omr file instead of the main one. Only the
    "omr" half is used here; timeline.py uses the "mxl" half of the same
    entry so both read the same recognition pass.
    """
    if pdf_path is None:
        raise ValueError("build_records needs the original PDF path (for clef glyphs)")
    from score_notes import resolve_score_notes
    resolved = resolved_notes if resolved_notes is not None else resolve_score_notes(
        pdf_path, omr_path, num_pages, page_omr_overrides)
    records = records_from_resolved(resolved, style, octave, suppress_repeated_chords)
    if verbose:
        print(f"Resolved {len(resolved['notes'])} noteheads into {len(records)} label groups.")
    return records


def records_from_resolved(resolved, style='unicode', octave=False, suppress_repeated_chords=True):
    """Render every recognized written note, including tied continuations.

    Optional compact labeling compares full pitches, never display strings.
    """
    from collections import defaultdict
    from labels import diatonic_label
    groups = defaultdict(list)
    widths = defaultdict(list)
    for n in resolved['notes']:
        groups[(n['page'], n['staff'], n['chord_id'])].append(n)
        widths[n['page']].append(n['w'])
    medians = {p: sorted(ws)[len(ws) // 2] for p, ws in widths.items()}
    seen, records = {}, []
    symbols = {-2: '𝄫', -1: '♭', 0: '', 1: '♯', 2: '𝄪'}
    for group in sorted(groups.values(), key=lambda g: (g[0]['page'], g[0]['system'], g[0]['staff'], min(n['cx'] for n in g))):
        group.sort(key=lambda n: (n.get('label_diatonic', n['diatonic']), -n['alter']))
        first = group[0]
        pitches = tuple((n.get('label_diatonic', n['diatonic']), n['alter']) for n in group)
        key = (first['page'], first['staff'], first['system_measure'])
        if suppress_repeated_chords and len(group) > 1:
            old = seen.setdefault(key, set())
            if pitches in old:
                continue
            old.add(pitches)
        labels = [diatonic_label(n.get('label_diatonic', n['diatonic']), symbols.get(n['alter'], ''), style=style, octave=octave)
                  + ('?' if n.get('pitch_uncertain') else '') for n in group]
        boxes = [n['bbox_pt'] for n in group]
        width = sum(n['w'] for n in group) / len(group)
        staff_lines = resolved.get('pages', {}).get(first['page'], {}).get('staff_lines_pt', {})
        staff_ys = staff_lines.get(first['staff'], [])
        staff_top = min(staff_ys) if staff_ys else min(b[1] for b in boxes)
        staff_bottom = max(staff_ys) if staff_ys else max(b[3] for b in boxes)
        records.append({
            'page': first['page'], 'part': first['role'], 'system': first['system'],
            'anchor_x_pt': sum((b[0] + b[2]) / 2 for b in boxes) / len(boxes),
            'top_y_pt': min((b[1] + b[3]) / 2 for b in boxes),
            'bottom_y_pt': max((b[1] + b[3]) / 2 for b in boxes),
            'labels': labels, 'measure': (first['system_measure'] or 0) + 1,
            'scale': max(.65, min(1, width / medians[first['page']])) if medians[first['page']] else 1,
            'notehead_w_pt': sum(b[2] - b[0] for b in boxes) / len(boxes),
            'note_boxes_pt': boxes, 'staff_lines_pt': staff_ys,
            'staff_top_pt': staff_top, 'staff_bottom_pt': staff_bottom,
            'space_top_pt': max((max(ys) for ys in staff_lines.values() if max(ys) < staff_top), default=0),
            'space_bottom_pt': min((min(ys) for ys in staff_lines.values() if min(ys) > staff_bottom), default=float('inf')),
        })
    return records


_DEFAULT_FONT_PATH = (
    r"C:\Windows\Fonts\arialuni.ttf" if sys.platform == "win32"
    else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
)
ARIAL_PATH = os.environ.get("LABEL_FONT_PATH", _DEFAULT_FONT_PATH)


def render(input_pdf, output_pdf, records, font_size=6.5, margin_pt=3.2):
    # margin_pt must clear the notehead's own radius (~2.2pt at 300dpi) plus a
    # visible gap - anything smaller guarantees the label overlaps the notehead
    doc = fitz.open(input_pdf)
    fontname = "arial-notenames"
    measure_font = fitz.Font(fontfile=ARIAL_PATH)
    for page in doc:
        page.insert_font(fontname=fontname, fontfile=ARIAL_PATH)
    # One Shape per page, committed once at the end: Page.insert_text() creates and
    # commits a fresh Shape on every call, which dominates render time at ~900 calls.
    shapes = {page.number: page.new_shape() for page in doc}

    by_page = {}
    for rec in records:
        by_page.setdefault(rec['page'], []).append(rec)

    for page_num, page_records in by_page.items():
        shape = shapes[page_num - 1]
        blocks = _layout_page_records(page_records, font_size, measure_font, margin_pt, doc[page_num - 1])
        for b in blocks:
            fs = b['fs']
            for label, y, x_off, w in zip(b['labels'], b['ys'], b['label_x_offsets'], b['widths']):
                tx = b['x'] + x_off - w / 2.0
                # halo first (stroke-only, underneath), then fully-solid black fill
                # on top - combining fill+stroke in one render_mode=2 pass dilutes
                # the black at small font sizes, which read as faded/light
                shape.insert_text((tx, y), label, fontname=fontname, fontsize=fs,
                                   render_mode=1, color=(1, 1, 1), border_width=0.25)
                shape.insert_text((tx, y), label, fontname=fontname, fontsize=fs,
                                   render_mode=0, fill=(0, 0, 0))

    for shape in shapes.values():
        shape.commit()

    doc.subset_fonts()
    doc.save(output_pdf, garbage=4, deflate=True)
    doc.close()


def main():
    ap = argparse.ArgumentParser(description="Overlay note-name labels onto a piano sheet-music PDF.")
    ap.add_argument("input_pdf")
    ap.add_argument("-o", "--output", default="annotated.pdf")
    ap.add_argument("--omr", required=True, help="Audiveris .omr book file")
    ap.add_argument("--style", choices=["unicode", "ascii"], default="unicode")
    ap.add_argument("--octave", action="store_true")
    ap.add_argument("--font-size", type=float, default=6.5)
    args = ap.parse_args()

    import pymupdf
    with pymupdf.open(args.input_pdf) as doc:
        num_pages = doc.page_count

    records = build_records(args.input_pdf, args.omr, num_pages, style=args.style, octave=args.octave)
    render(args.input_pdf, args.output, records, font_size=args.font_size)
    print(f"Wrote {args.output} ({len(records)} labeled beat-groups)")


if __name__ == "__main__":
    main()
