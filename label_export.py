"""The placed note-name labels as data, for the web viewer's editable layer.

annotate.render() draws the labels into the annotated PDF, which leaves
nothing a browser can move or retype. This writes the same placements out as
JSON (served next to timeline.json), so the viewer can draw them itself over
the original PDF and apply the reader's own edits on top.

Each printed line is its own item - one per notehead - with the playback
timeline's ids of the note it names, so retyping a label can correct what
plays as well. The link is made geometrically: the label layout and the
timeline both carry each notehead's box in PDF points.
"""
from math import hypot

# How far apart two readings of the same notehead's centre may be, in points.
# Both come from the same OMR bbox in practice; the slack only absorbs rounding.
MATCH_DISTANCE_PT = 1.5


def _notes_by_page(timeline):
    pages = {}
    if not timeline:
        return pages
    measures = timeline.get('measures', [])
    for note in timeline.get('notes', []):
        box = note.get('bbox_pt')
        index = note.get('measure_index')
        if not box or index is None or index >= len(measures):
            continue
        page = measures[index].get('page')
        note_id = note.get('printed_id') or note.get('source_id')
        if page is None or not note_id:
            continue
        pages.setdefault(page, []).append(((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, note_id))
    return pages


def labels_document(placed, timeline=None, font_size=6.5, color="#000000"):
    """``placed``: [(page_number, block), ...] as returned by annotate.render()."""
    notes = _notes_by_page(timeline)
    items = []
    block_numbers = {}
    for page, block in placed:
        number = block_numbers[page] = block_numbers.get(page, -1) + 1
        group = f"{page}-{number}"
        boxes = block.get('note_boxes') or []
        for line, (text, y, offset) in enumerate(zip(block['labels'], block['ys'], block['label_x_offsets'])):
            note_ids = []
            if line < len(boxes) and boxes[line]:
                box = boxes[line]
                cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
                for nx, ny, note_id in notes.get(page, ()):
                    if hypot(nx - cx, ny - cy) <= MATCH_DISTANCE_PT and note_id not in note_ids:
                        note_ids.append(note_id)
            items.append({
                'id': f"{group}-{line}", 'group': group, 'page': page,
                # x is the text's horizontal centre, y its baseline - the same
                # anchor annotate.render() draws from.
                'x': round(block['x'] + offset, 2), 'y': round(y, 2),
                'size': round(block['fs'], 2), 'text': text, 'notes': note_ids,
            })
    return {'version': 1, 'font_size': font_size, 'color': color, 'items': items}
