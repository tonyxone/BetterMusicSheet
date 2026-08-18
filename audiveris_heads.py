"""Parse notehead positions directly out of Audiveris's .omr book file (SIG data),
avoiding custom CV notehead detection entirely."""
import zipfile
import xml.etree.ElementTree as ET


def _parse_sheet(omr_path, sheet_index):
    with zipfile.ZipFile(omr_path) as z:
        with z.open(f"sheet#{sheet_index}/sheet#{sheet_index}.xml") as f:
            tree = ET.parse(f)
    return tree.getroot()


def load_sheet_heads(omr_path, sheet_index):
    """Return list of dicts: {staff, x, y, w, h, cx, cy, shape, id, pitch} for one sheet (1-based).

    Heads are de-duplicated by (staff, x, y): Audiveris's SIG occasionally contains two
    <head> elements with different ids at the *identical* position (a re-detection of the
    same notehead).  Labeling both would draw two overlapping identical labels.
    """
    root = _parse_sheet(omr_path, sheet_index)
    heads = []
    seen = set()
    for head in root.iter('head'):
        bounds = head.find('bounds')
        if bounds is None:
            continue
        x = float(bounds.get('x'))
        y = float(bounds.get('y'))
        w = float(bounds.get('w'))
        h = float(bounds.get('h'))
        key = (int(head.get('staff')), round(x, 1), round(y, 1))
        if key in seen:
            continue
        seen.add(key)
        pitch = head.get('pitch')
        heads.append({
            'staff': int(head.get('staff')),
            'shape': head.get('shape'),
            'id': head.get('id'),
            'pitch': int(pitch) if pitch is not None else None,
            'x': x, 'y': y, 'w': w, 'h': h,
            'cx': x + w / 2.0,
            'cy': y + h / 2.0,
        })
    return heads


def load_staff_lines(omr_path, sheet_index):
    """Return {staff_id: (y1,...,y5)} — the y pixel positions of the 5 staff lines."""
    root = _parse_sheet(omr_path, sheet_index)
    result = {}
    for staff in root.iter('staff'):
        sid = int(staff.get('id'))
        for lines in staff.iter('lines'):
            ys = [float(line.find('point').get('y')) for line in lines.iter('line')]
            if len(ys) == 5:
                result[sid] = tuple(sorted(ys))
    return result


def load_staff_barlines(omr_path, sheet_index):
    """Return {staff_id: [x_px, ...]} — barline x positions, sorted."""
    root = _parse_sheet(omr_path, sheet_index)
    result = {}
    for sb in root.iter('staff-barline'):
        staff = sb.get('staff')
        if staff is None:
            continue
        bounds = sb.find('bounds')
        if bounds is None:
            continue
        result.setdefault(int(staff), []).append(float(bounds.get('x')))
    for xs in result.values():
        xs.sort()
    return result


def load_omr_clefs(omr_path, sheet_index):
    """Return {staff_id: [(x_px, kind)]} from Audiveris's own <clef> elements.

    kind is 'G' (treble) or 'F' (bass).  These can be *wrong* when Audiveris
    misread a clef change, so they are only a fallback for the clef timeline
    (the PDF's own clef glyphs are the ground truth).
    """
    root = _parse_sheet(omr_path, sheet_index)
    result = {}
    for clef in root.iter('clef'):
        kind = clef.get('kind')
        staff = clef.get('staff')
        bounds = clef.find('bounds')
        if kind is None or staff is None or bounds is None:
            continue
        kind = 'G' if kind == 'TREBLE' else 'F' if kind == 'BASS' else kind
        result.setdefault(int(staff), []).append((float(bounds.get('x')), kind))
    for xs in result.values():
        xs.sort()
    return result


def load_key_signature(omr_path, sheet_index):
    """Return {staff_id: fifths} derived from Audiveris's key-signature alters.

    fifths > 0 -> that many sharps; fifths < 0 -> that many flats; 0 = C major.
    """
    root = _parse_sheet(omr_path, sheet_index)
    counts = {}
    for ka in root.iter('key-alter'):
        staff = ka.get('staff')
        shape = ka.get('shape')
        if staff is None or shape is None:
            continue
        counts.setdefault(int(staff), {'SHARP': 0, 'FLAT': 0})
        if shape in counts[int(staff)]:
            counts[int(staff)][shape] += 1
    result = {}
    for staff, c in counts.items():
        result[staff] = c['SHARP'] - c['FLAT']
    return result


def load_alter_map(omr_path, sheet_index):
    """Return {head_id: accidental_shape} — explicit accidentals attached to heads.

    Audiveris links each explicit accidental (<alter> element) to the notehead it
    modifies via a <relation><alter-head/></relation> edge: source = alter id,
    target = head id.  The alter's shape (SHARP/NATURAL/FLAT/DOUBLE_SHARP/
    DOUBLE_FLAT) overrides the key-signature accidental for that head.
    """
    root = _parse_sheet(omr_path, sheet_index)
    alters = {a.get('id'): a.get('shape') for a in root.iter('alter')}
    result = {}
    for rel in root.iter('relation'):
        if rel.find('alter-head') is None:
            continue
        src = rel.get('source')
        tgt = rel.get('target')
        if src in alters and tgt:
            result[tgt] = alters[src]
    return result


def load_system_staff_groups(omr_path, sheet_index):
    """Return a list of staff-id lists, one per <system>, in document order
    (top-to-bottom on the page) and top-to-bottom staff order within each system.

    This reads Audiveris's own <system><part><staff id=...> nesting instead of
    assuming staff ids are dense and start at 1 - that assumption breaks
    whenever a system's staves got zero recognized noteheads (a real OMR miss),
    since the ids are still consumed but would be invisible to any scheme based
    on staff ids observed in the head list.
    """
    root = _parse_sheet(omr_path, sheet_index)
    groups = []
    for system in root.findall('.//system'):
        staff_ids = [int(s.get('id')) for s in system.findall('.//staff') if s.get('id') is not None]
        if staff_ids:
            groups.append(staff_ids)
    return groups


def load_tie_stop_heads(omr_path, sheet_index):
    """Return the set of head ids that are the TARGET (later note) of a tie.

    Audiveris represents a tie as a <slur tie="true"> curve linked to its two
    noteheads via <relation><slur-head side="LEFT|RIGHT"/></relation> edges
    (source = slur id, target = head id): LEFT is the earlier note, RIGHT is
    the note it ties into. A tie that crosses a system/page break is split
    into two curve fragments (linked via left-/right-extension), but each
    fragment still tags its one visible head with the correct LEFT/RIGHT side,
    so collecting every RIGHT-side target below already handles that case too.
    """
    root = _parse_sheet(omr_path, sheet_index)
    tie_ids = {s.get('id') for s in root.iter('slur') if s.get('tie') == 'true'}
    stops = set()
    for rel in root.iter('relation'):
        sh = rel.find('slur-head')
        if sh is None or sh.get('side') != 'RIGHT':
            continue
        if rel.get('source') in tie_ids:
            stops.add(rel.get('target'))
    return stops


def get_picture_size(omr_path, sheet_index):
    with zipfile.ZipFile(omr_path) as z:
        with z.open(f"sheet#{sheet_index}/sheet#{sheet_index}.xml") as f:
            tree = ET.parse(f)
    pic = tree.getroot().find('picture')
    return int(pic.get('width')), int(pic.get('height'))


def group_heads_by_staff(heads):
    by_staff = {}
    for h in heads:
        by_staff.setdefault(h['staff'], []).append(h)
    for staff in by_staff:
        by_staff[staff].sort(key=lambda h: h['cx'])
    return by_staff


def load_chord_id_groups(omr_path, sheet_index):
    """Return a head-id -> owning-head-chord-id mapping using Audiveris's OWN
    authoritative chord structure, instead of an x-distance heuristic.

    Audiveris's SIG has explicit <head-chord id="..."> elements (one per rhythmic
    time-event) that own their constituent <head> elements via
    <relation source="<head-chord id>" target="<head id>"><containment/></relation>
    edges - the very same grouping Audiveris itself uses to build its MusicXML
    chords. This is what music21's beat-groups are ultimately derived from too, so
    reading it directly sidesteps the failure mode of geometric clustering: a chord
    note a 2nd apart is engraved with one notehead offset sideways to avoid
    overlapping its neighbor, which a pure x-distance clusterer misreads as a
    separate time-event, misaligning every beat-group that follows it on that staff.
    """
    with zipfile.ZipFile(omr_path) as z:
        with z.open(f"sheet#{sheet_index}/sheet#{sheet_index}.xml") as f:
            tree = ET.parse(f)
    root = tree.getroot()

    chord_ids = {hc.get('id') for hc in root.iter('head-chord')}
    head_to_chord = {}
    for relation in root.iter('relation'):
        if relation.find('containment') is None:
            continue
        source = relation.get('source')
        if source in chord_ids:
            head_to_chord[relation.get('target')] = source

    return head_to_chord


def cluster_chords_by_relation(staff_heads, id_to_root):
    """Group one staff's heads into simultaneous-note groups using Audiveris's own
    chord relations (see load_chord_id_groups). Heads with no relation entry are
    singleton groups (an unaccompanied single note). Groups are returned sorted by
    x (time order)."""
    groups_by_root = {}
    singletons = []
    for h in staff_heads:
        root = id_to_root.get(h['id'])
        if root is None:
            singletons.append([h])
        else:
            groups_by_root.setdefault(root, []).append(h)
    all_groups = list(groups_by_root.values()) + singletons
    all_groups.sort(key=lambda g: sum(h['cx'] for h in g) / len(g))
    return all_groups


def cluster_chords(staff_heads, x_merge_dist):
    """Fallback x-distance clustering (kept for reference/comparison only - misreads
    chords with a sideways-offset notehead as two separate time-events). Prefer
    cluster_chords_by_relation."""
    if not staff_heads:
        return []
    groups = [[staff_heads[0]]]
    for h in staff_heads[1:]:
        if h['cx'] - groups[-1][-1]['cx'] <= x_merge_dist:
            groups[-1].append(h)
        else:
            groups.append([h])
    return groups


if __name__ == "__main__":
    omr_path = "output/your lie in april - Again.omr"
    heads = load_sheet_heads(omr_path, 1)
    print(f"Page 1: {len(heads)} heads total, picture size {get_picture_size(omr_path, 1)}")
    by_staff = group_heads_by_staff(heads)
    for staff in sorted(by_staff):
        hs = by_staff[staff]
        mean_w = sum(h['w'] for h in hs) / len(hs)
        groups = cluster_chords(hs, x_merge_dist=mean_w * 0.7)
        print(f"  staff {staff}: {len(hs)} heads -> {len(groups)} chord-groups (mean_w={mean_w:.1f})")
