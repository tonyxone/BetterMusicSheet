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
import fitz

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
                   page_omr_overrides=None):
    """Return list of label records: {page, part, anchor_x_pt, top_y_pt, bottom_y_pt, labels}.

    One record per simultaneous-note group (Audiveris's own head-chord grouping),
    for every notehead Audiveris detected.  Pitches are Audiveris's per-head
    diatonic pitches corrected for the clef the PDF actually shows.

    ``page_omr_overrides``: optional {page_number: alternate_omr_path}, for pages
    that were re-recognized separately (e.g. re-run at a higher DPI because the
    default pass badly under-detected that page) - such a page is read entirely
    from its own omr file instead of the main one.
    """
    if pdf_path is None:
        raise ValueError("build_records needs the original PDF path (for clef glyphs)")
    pdf_doc = fitz.open(pdf_path)
    try:
        records, stats = _build_records_inner(pdf_doc, omr_path, num_pages, style, octave, verbose,
                                               page_omr_overrides or {})
    finally:
        pdf_doc.close()
    return records


def _build_records_inner(pdf_doc, omr_path, num_pages, style, octave, verbose, page_omr_overrides):
    records = []
    stats = {'heads': 0, 'groups': 0, 'unpitched': 0, 'tied': 0}
    seen_in_measure = {}

    for page in range(1, num_pages + 1):
        src_omr = page_omr_overrides.get(page, omr_path)
        heads = load_sheet_heads(src_omr, page)
        if not heads:
            continue
        by_staff = group_heads_by_staff(heads)
        id_to_chord = load_chord_id_groups(src_omr, page)
        staff_lines = load_staff_lines(src_omr, page)
        barlines = load_staff_barlines(src_omr, page)
        key_fifths = load_key_signature(src_omr, page)
        alt_map = load_alter_map(src_omr, page)
        tie_stops = load_tie_stop_heads(src_omr, page)
        omr_clefs = load_omr_clefs(src_omr, page)

        # a page's dominant (median) notehead width, used to scale down labels
        # for noticeably smaller noteheads (cue/ornament-sized passages) instead
        # of drawing a full-size label over a miniature notehead. Audiveris
        # doesn't flag these explicitly, but it does report exact head geometry,
        # which is a real signal even without a "cue"/"grace" attribute to key off.
        widths = sorted(h['w'] for h in heads if h['w'] > 0)
        ref_w = widths[len(widths) // 2] if widths else 0

        # Audiveris's internal picture is a raster of the PDF page at whatever
        # DPI it was actually loaded with (normally 300, but overridable via
        # -constant org.audiveris.omr.image.ImageLoading.pdfResolution=<dpi> for
        # dense passages that need more pixels to recognize correctly) - derive
        # the px->pt scale from the real picture size vs. the PDF page size
        # instead of assuming a fixed DPI, so both cases work unmodified.
        pic_w, _pic_h = get_picture_size(src_omr, page)
        px_to_pt = pdf_doc[page - 1].rect.width / pic_w

        staff_lines_pt = {s: tuple(y * px_to_pt for y in ys) for s, ys in staff_lines.items()}
        pdf_clefs = pdf_clef_timeline(pdf_doc, page, staff_lines_pt)

        system_staff_groups = load_system_staff_groups(src_omr, page)

        for system_idx, staff_ids in enumerate(system_staff_groups):
            # every staff in the system gets annotated, however many there are -
            # not just an assumed RH/LH pair. Placement above/below still follows
            # the RH-above/others-below convention below (part_idx == 0).
            for part_idx, staff_num in enumerate(staff_ids):
                staff_heads = by_staff.get(staff_num, [])
                if not staff_heads:
                    continue
                head_groups = cluster_chords_by_relation(staff_heads, id_to_chord)

                for hg in head_groups:
                    pitches = []
                    labels = []
                    for h in hg:
                        if h['id'] in tie_stops:
                            stats['tied'] += 1
                            continue
                        if h['pitch'] is None:
                            stats['unpitched'] += 1
                            continue
                        stats['heads'] += 1
                        # Audiveris's <head pitch> is the note's diatonic SLOT:
                        # steps from the staff's middle line (0 = middle line),
                        # independent of clef.  Convert to an absolute pitch by
                        # adding the middle-line reference of the clef actually
                        # in effect at this notehead (the PDF's clef when known,
                        # else Audiveris's own clef).
                        pdf_clef = None
                        if pdf_clefs.get(staff_num):
                            pdf_clef = _clef_at(pdf_clefs[staff_num], h['cx'] * px_to_pt, None)
                        if pdf_clef is not None:
                            eff_clef = pdf_clef
                        else:
                            eff_clef = _clef_at(omr_clefs.get(staff_num, []), h['cx'], 'G')
                        diatonic = h['pitch'] + PITCH_REF.get(eff_clef, 0)

                        acc = key_accidental(diatonic, key_fifths.get(staff_num, 0))
                        shape = alt_map.get(h['id'])
                        if shape is not None:
                            acc = alter_symbol(shape, style)
                        pitches.append(diatonic)
                        labels.append(diatonic_label(
                            diatonic, acc if acc else '', style=style, octave=octave))

                    if not labels:
                        continue
                    stats['groups'] += 1

                    # render() expects labels ordered highest-pitch-first.  Our
                    # diatonic value counts steps BELOW B4 (0 = B4, 6 = C4, ...),
                    # so ascending value == highest pitch first.
                    order = sorted(range(len(pitches)), key=lambda i: pitches[i])
                    labels = [labels[i] for i in order]

                    anchor_x = sum(h['cx'] for h in hg) / len(hg)
                    top_y = min(h['cy'] for h in hg)
                    bottom_y = max(h['cy'] for h in hg)
                    group_w = sum(h['w'] for h in hg) / len(hg)
                    scale = max(0.65, min(1.0, group_w / ref_w)) if ref_w else 1.0
                    # measure index within this staff's system: count this staff's
                    # internal barlines before the group (the staff's leftmost
                    # barline is the system edge, not a measure boundary)
                    bars = barlines.get(staff_num, [])
                    if bars:
                        bars = [bx for bx in bars if bx > bars[0]]
                    measure = sum(1 for bx in bars if bx < anchor_x) + 1

                    # show a repeated 2+-note stack (dyad or bigger chord) only
                    # once per measure; single notes are always shown
                    if len(labels) > 1:
                        seen = seen_in_measure.setdefault((page, staff_num, measure), set())
                        group_key = tuple(sorted(labels))
                        if group_key in seen:
                            continue
                        seen.add(group_key)

                    records.append({
                        'page': page, 'part': part_idx, 'system': system_idx,
                        'anchor_x_pt': anchor_x * px_to_pt,
                        'top_y_pt': top_y * px_to_pt,
                        'bottom_y_pt': bottom_y * px_to_pt,
                        'labels': labels,
                        'measure': measure,
                        'scale': scale,
                        'notehead_w_pt': group_w * px_to_pt,
                    })

    if verbose:
        print(f"Matching summary: {stats['groups']} labeled beat-groups, "
              f"{stats['heads']} noteheads labeled, {stats['unpitched']} heads without pitch data, "
              f"{stats['tied']} tied-continuation heads skipped.")
    return records, stats


ARIAL_PATH = r"C:\Windows\Fonts\arialuni.ttf"  # arial.ttf lacks the U+266D flat glyph; Arial Unicode MS has it


def _layout_page_records(page_records, font_size, measure_font, margin_pt):
    """Compute each record's draw positions.

    Each multi-note stack (dyad or bigger chord) picks one of two placements:

    - "beside": vertically centered on the note, offset right by the note's
      own half-width (so it clears the physical notehead - a whole note's open
      "O" glyph is much wider than the label's own half-width, which used to
      be the only clearance applied, letting labels sit on top of the note)
      plus a visual gap. Preferred whenever there's room for it before the
      next event on the same system - tucking the stack next to the chord it
      belongs to reads better than dropping it into empty space below/above.
    - "below"/"above" (RH above, LH below): the fallback when beside doesn't
      fit - stacked directly under/over the note, growing away from the staff.

    Single notes always use below/above - there's no stack to tuck sideways,
    and a single label rarely conflicts with anything.

    Two DIFFERENT beats on the same staff landing close together (same
    placement, overlapping label footprints) still get nudged apart
    horizontally afterward, regardless of which placement each ended up with.
    """
    min_gap = 0.6  # pt
    side_gap = margin_pt  # horizontal clearance from the notehead

    blocks = []
    for rec in page_records:
        labels = rec['labels']
        n = len(labels)
        part = rec['part']
        # cue/ornament-sized noteheads (rec['scale'] < 1) get a proportionally
        # smaller label instead of a full-size one dwarfing a miniature notehead.
        fs = font_size * rec.get('scale', 1.0)
        line_h = fs * 1.05
        if part == 0:  # RH / treble -> stack ABOVE, highest pitch furthest up
            base_y = rec['top_y_pt'] - margin_pt
            below_ys = [base_y - (n - 1 - i) * line_h for i in range(n)]
        else:  # LH / bass -> stack BELOW, highest pitch closest to the staff
            base_y = rec['bottom_y_pt'] + margin_pt + fs
            below_ys = [base_y + i * line_h for i in range(n)]
        widths = [measure_font.text_length(lbl, fontsize=fs) for lbl in labels]
        half_w = max(widths) / 2.0
        note_mid_y = (rec['top_y_pt'] + rec['bottom_y_pt']) / 2.0
        notehead_half_w = rec.get('notehead_w_pt', 0.0) / 2.0
        beside_x = rec['anchor_x_pt'] + notehead_half_w + side_gap + half_w
        beside_ys = [note_mid_y - (n - 1) / 2.0 * line_h + i * line_h for i in range(n)]
        blocks.append({
            'x': rec['anchor_x_pt'], 'labels': labels, 'widths': widths, 'part': part,
            'below_ys': below_ys, 'ys': below_ys, 'mode': 'below',
            'beside_ys': beside_ys, 'beside_x': beside_x,
            'system': (rec['page'], rec['system']), 'note_mid_y': note_mid_y,
            'fs': fs, 'line_h': line_h, 'half_w': half_w,
        })

    def vertical_bbox(ys, fs):
        return min(ys) - fs * 0.85, max(ys) + fs * 0.3

    def use_beside(b):
        b['ys'] = b['beside_ys']
        b['x'] = b['beside_x']
        b['mode'] = 'beside'

    # forced beside: below/above would collide with content from a DIFFERENT
    # system/line (identified by system index, not x-distance - a neighboring
    # note in the SAME system can easily be >20pt away too, so x-distance alone
    # can't tell "next note" apart from "line above/below")
    for b in blocks:
        if len(b['labels']) < 2:
            continue
        y_top, y_bottom = vertical_bbox(b['below_ys'], b['fs'])
        for other in blocks:
            if other is b or other['system'] == b['system']:
                continue
            oy_top, oy_bottom = vertical_bbox(other['ys'], other['fs'])
            if y_top < oy_bottom and y_bottom > oy_top:
                use_beside(b)
                break

    # preferred beside: even without a collision, tuck the stack beside the
    # note whenever there's ample horizontal room before the next event on
    # THIS staff (same system AND same hand - a close note on the other
    # staff/hand doesn't share this stack's vertical band, so it's irrelevant
    # to whether beside placement would visually crowd anything)
    by_staff = {}
    for b in blocks:
        by_staff.setdefault((b['system'], b['part']), []).append(b)
    for staff_blocks in by_staff.values():
        xs = sorted(set(b['x'] for b in staff_blocks))
        for b in staff_blocks:
            if b['mode'] == 'beside' or len(b['labels']) < 2:
                continue
            later = [x for x in xs if x > b['x'] + 0.01]
            next_x = min(later) if later else None
            # a comfortable margin, not just the bare minimum that avoids
            # overlap - "plenty of room" should look plenty, and this leaves
            # slack for whatever the next event's own label ends up needing
            needed_right = b['beside_x'] + b['half_w'] + min_gap + b['half_w']
            if next_x is None or next_x >= needed_right:
                use_beside(b)

    for b in blocks:
        b['label_x_offsets'] = [0.0] * len(b['labels'])
        y_top, y_bottom = vertical_bbox(b['ys'], b['fs'])
        b['y_top'], b['y_bottom'] = y_top, y_bottom

    # greedy left-to-right sweep for same-system neighbors: each block only
    # needs to clear earlier (already-placed) blocks it vertically overlaps, and
    # only ever moves right, so a single pass is enough - it can never re-collide
    # with something already resolved to its left.
    blocks.sort(key=lambda b: b['x'])
    placed = []
    for b in blocks:
        shift = 0.0
        for p in placed:
            if b['y_top'] >= p['y_bottom'] or b['y_bottom'] <= p['y_top']:
                continue  # different vertical band - can't visually collide
            needed_x = p['x'] + p['half_w'] + min_gap + b['half_w']
            if b['x'] + shift < needed_x:
                shift = needed_x - b['x']
        b['x'] += shift
        placed.append(b)

    return placed


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
        blocks = _layout_page_records(page_records, font_size, measure_font, margin_pt)
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
