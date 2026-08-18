"""Extract ordered beat-groups (simultaneous-note clusters) per system/staff from the
Audiveris MusicXML, using music21's own page/system layout breaks to assign each
measure to a (page, system) bucket."""
import music21


def load_score(mxl_path):
    return music21.converter.parse(mxl_path)


def get_system_boundaries(part):
    """Return list of (page_index, system_index_on_page, first_measure_number) in order,
    derived from PageLayout/SystemLayout breaks already present in the parsed score."""
    boundaries = []
    page_idx = 0
    system_idx_on_page = -1
    for m in part.getElementsByClass('Measure'):
        has_page_break = len(m.getElementsByClass('PageLayout')) > 0
        has_system_break = len(m.getElementsByClass('SystemLayout')) > 0
        if has_page_break:
            page_idx += 1
            system_idx_on_page = 0
        elif has_system_break:
            system_idx_on_page += 1
        if has_page_break or has_system_break or not boundaries:
            boundaries.append((page_idx, system_idx_on_page, m.number))
    return boundaries


def measure_to_system(boundaries, measure_number):
    """Find which (page, system) a measure belongs to."""
    result = boundaries[0][:2]
    for page_idx, sys_idx, start_m in boundaries:
        if start_m <= measure_number:
            result = (page_idx, sys_idx)
        else:
            break
    return result


def extract_beat_groups(part, boundaries):
    """Return dict: (page_idx, sys_idx) -> ordered list of beat-groups.
    Each beat-group is a list of music21.pitch.Pitch objects sounding together
    (chord notes AND same-offset notes across voices), in time order.
    Rest-only offsets are skipped.
    """
    systems = {}
    for m in part.getElementsByClass('Measure'):
        key = measure_to_system(boundaries, m.number)
        systems.setdefault(key, [])
        offset_map = {}  # offset -> list of pitches
        for el in m.recurse().notes:  # notes only, rests excluded
            pitches = el.pitches if el.isChord else [el.pitch]
            offset_map.setdefault(el.offset, []).extend(pitches)
        for off in sorted(offset_map.keys()):
            systems[key].append({
                'measure': m.number,
                'offset': off,
                'pitches': offset_map[off],
            })
    return systems


if __name__ == "__main__":
    s = load_score("output/your lie in april - Again.mxl")
    for part_idx, part in enumerate(s.parts):
        print(f"=== Part {part_idx}: {part.id} ===")
        boundaries = get_system_boundaries(part)
        print("System boundaries:", boundaries)
        systems = extract_beat_groups(part, boundaries)
        for key in sorted(systems.keys()):
            groups = systems[key]
            print(f"  System {key}: {len(groups)} beat-groups")
