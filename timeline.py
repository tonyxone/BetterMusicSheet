"""Playback timeline: what sounds, when, and where it sits on the page.

Joins the two halves of a single Audiveris recognition pass:

  * the .omr  - notehead pixels, pitch, and measure/barline geometry (what the
                rest of this project already reads, via audiveris_heads.py)
  * the .mxl  - note durations and onsets (musicxml.py); the .omr never
                decodes rhythm at all

The result is a JSON artifact the web UI's Play page consumes: a flat note
list with absolute beat positions and MIDI numbers, plus per-measure page
regions so a click on the sheet resolves to a measure.

Kept deliberately separate from annotate.py: nothing here feeds the annotated
PDF, and a failure here must never take that pipeline down with it (see
run.py's annotate_pdf, which treats this as best-effort).

Beats are quarter-note units. There is no tempo anywhere in OMR output (see
musicxml.py), so the timeline ships a default BPM and the player scales it.
"""
import zipfile
import xml.etree.ElementTree as ET

import musicxml
from audiveris_heads import (
    get_picture_size,
    load_staff_lines,
    load_system_staff_groups,
)
from labels import octave_of, step_of

DEFAULT_TEMPO_BPM = 96

# Semitone offset of each diatonic step within its octave.
_STEP_SEMITONE = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def step_octave_to_midi(step, octave, alter=0):
    """MIDI note number from a letter name, octave and alteration (C4 = 60)."""
    return (octave + 1) * 12 + _STEP_SEMITONE[step.upper()] + alter


def diatonic_to_midi(diatonic, alter=0):
    """MIDI number from this project's diatonic convention (0 = B4, 6 = C4).

    Cross-checked against that anchor: step_of(0)='B', octave_of(0)=4, so
    (4+1)*12 + 11 = 71 = B4.
    """
    return step_octave_to_midi(step_of(diatonic), octave_of(diatonic), alter)


def _sheet_root(omr_path, sheet_index):
    with zipfile.ZipFile(omr_path) as z:
        with z.open(f"sheet#{sheet_index}/sheet#{sheet_index}.xml") as f:
            return ET.parse(f).getroot()


def load_measure_regions(omr_path, sheet_index):
    """Pixel bounding boxes for each printed measure on a page, in reading
    order (system top-to-bottom, then left-to-right within a system).

    Audiveris stores a measure's right edge as <right-barline><staff-barlines>
    holding *object ids*, not coordinates - each id resolves to a
    <staff-barline> elsewhere in the sheet whose <bounds> carries the actual
    pixels. Reading those numbers as if they were x positions yields garbage.

    A box spans the full system vertically (both hands), not one staff: a
    printed measure is a single column across the grand staff, and the click
    target should be the whole thing.
    """
    root = _sheet_root(omr_path, sheet_index)

    barline_x = {}
    for sb in root.iter('staff-barline'):
        bounds = sb.find('bounds')
        if sb.get('id') and bounds is not None:
            barline_x[sb.get('id')] = float(bounds.get('x')) + float(bounds.get('w', 0)) / 2

    staff_lines = load_staff_lines(omr_path, sheet_index)
    systems = load_system_staff_groups(omr_path, sheet_index)

    regions = []
    for sys_idx, system_el in enumerate(root.iter('system')):
        staff_ids = systems[sys_idx] if sys_idx < len(systems) else []
        ys = [y for sid in staff_ids for y in staff_lines.get(sid, ())]
        if not ys:
            continue
        # Pad beyond the staff lines so ledger-line notes above/below still
        # fall inside their measure's click target.
        pad = max(8.0, (max(ys) - min(ys)) * 0.12)
        y0, y1 = min(ys) - pad, max(ys) + pad

        staff_els = [s for s in system_el.iter('staff') if s.get('left')]
        sys_left = min((float(s.get('left')) for s in staff_els), default=None)
        sys_right = max((float(s.get('right')) for s in staff_els), default=None)
        if sys_left is None:
            continue

        left = sys_left
        for measure in system_el.iter('measure'):
            ids_el = measure.find('right-barline/staff-barlines')
            xs = []
            if ids_el is not None and ids_el.text:
                xs = [barline_x[i] for i in ids_el.text.split() if i in barline_x]
            right = max(xs) if xs else sys_right
            if right is None or right <= left:
                continue
            regions.append({
                'system': sys_idx,
                'x0': left, 'y0': y0, 'x1': right, 'y1': y1,
            })
            left = right

    return regions


def _page_sources(page, mxl_path, omr_path, page_omr_overrides):
    """The (mxl, omr) pair a given page's data must be read from - the retry
    pass for pages that were re-recognized, the main pass otherwise. Both
    halves must come from the SAME pass or the note counts disagree."""
    override = (page_omr_overrides or {}).get(page) or {}
    return override.get('mxl', mxl_path), override.get('omr', omr_path)


def build_timeline(pdf_path, mxl_path, omr_path, num_pages,
                   page_omr_overrides=None, tempo_bpm=DEFAULT_TEMPO_BPM):
    """Build the playback timeline dict (see the module docstring).

    ``page_omr_overrides``: {page: {"omr": path, "mxl": path}} from
    run.py's retry_sparse_pages.
    """
    import pymupdf

    stats = {'measure_count_mismatch': 0, 'pages_without_regions': 0}

    # --- per-page measure geometry, converted to PDF points ---
    page_regions = {}
    with pymupdf.open(pdf_path) as doc:
        for page in range(1, num_pages + 1):
            _mxl, page_omr = _page_sources(page, mxl_path, omr_path, page_omr_overrides)
            try:
                regions = load_measure_regions(page_omr, page)
                pic_w, _pic_h = get_picture_size(page_omr, page)
            except (KeyError, ValueError, ET.ParseError, zipfile.BadZipFile):
                regions = []
                pic_w = None
            if not regions or not pic_w:
                stats['pages_without_regions'] += 1
                page_regions[page] = []
                continue
            # Same px->pt derivation annotate.py uses: from the real picture
            # size vs. the PDF page, so a page re-scanned at a different DPI
            # still converts correctly.
            px_to_pt = doc[page - 1].rect.width / pic_w
            page_regions[page] = [
                [r['x0'] * px_to_pt, r['y0'] * px_to_pt,
                 r['x1'] * px_to_pt, r['y1'] * px_to_pt]
                for r in regions
            ]

    ordered_pages = list(range(1, num_pages + 1))
    omr_boxes = [(p, box) for p in ordered_pages for box in page_regions[p]]

    # --- notes + measure lengths, splicing any retried page's own export ---
    main_notes, main_measures = musicxml.load_part_notes(mxl_path)
    notes_by_measure = {}
    for n in main_notes:
        notes_by_measure.setdefault(n['measure_index'], []).append(n)

    spliced = []   # list of (measure_dict, notes_list, page)
    consumed = 0
    for page in ordered_pages:
        count = len(page_regions[page])
        override = (page_omr_overrides or {}).get(page) or {}
        if override.get('mxl'):
            # This page was re-recognized on its own; take its measures whole
            # rather than the main pass's version of the same page.
            try:
                r_notes, r_measures = musicxml.load_part_notes(override['mxl'])
                r_by_measure = {}
                for n in r_notes:
                    r_by_measure.setdefault(n['measure_index'], []).append(n)
                for m in r_measures:
                    spliced.append((m, r_by_measure.get(m['measure_index'], []), page))
                consumed += count
                continue
            except (ValueError, ET.ParseError, zipfile.BadZipFile, KeyError):
                pass  # fall through to the main pass for this page
        for m in main_measures[consumed:consumed + count]:
            spliced.append((m, notes_by_measure.get(m['measure_index'], []), page))
        consumed += count

    # Any measures the page walk didn't reach (page regions missing, or the
    # export simply has more measures than the OMR found barlines for).
    if consumed < len(main_measures):
        for m in main_measures[consumed:]:
            spliced.append((m, notes_by_measure.get(m['measure_index'], []), None))

    if len(spliced) != len(omr_boxes):
        stats['measure_count_mismatch'] = len(spliced) - len(omr_boxes)

    # --- assemble ---
    measures_out = []
    notes_out = []
    start_beat = 0.0
    for idx, (m, m_notes, page) in enumerate(spliced):
        box = omr_boxes[idx][1] if idx < len(omr_boxes) else None
        box_page = omr_boxes[idx][0] if idx < len(omr_boxes) else page

        midis = []
        for n in m_notes:
            midi = step_octave_to_midi(n['step'], n['octave'], n['alter'])
            midis.append(midi)
            notes_out.append({
                'measure_index': idx,
                'role': max(0, n['staff'] - 1),
                'midi': midi,
                'start_beat': start_beat + n['start_beat_in_measure'],
                'duration_beats': n['duration_beats'],
                'is_grace': n['is_grace'],
            })

        length = m['length_beats']
        measures_out.append({
            'index': idx,
            'label': m['label'],
            'page': box_page,
            'start_beat': start_beat,
            'length_beats': length,
            'bbox_pt': box,
            'distinct_midis': sorted(set(midis)),
        })
        start_beat += length

    # OMR found more measure boxes than the export had measures: keep them as
    # real, clickable, empty measures rather than dropping page geometry.
    for extra in range(len(spliced), len(omr_boxes)):
        page, box = omr_boxes[extra]
        measures_out.append({
            'index': extra,
            'label': '',
            'page': page,
            'start_beat': start_beat,
            'length_beats': 0.0,
            'bbox_pt': box,
            'distinct_midis': [],
        })

    notes_out.sort(key=lambda n: (n['start_beat'], n['midi']))
    return {
        'version': 1,
        'tempo_bpm_default': tempo_bpm,
        'total_beats': start_beat,
        'measures': measures_out,
        'notes': notes_out,
        'stats': stats,
    }
