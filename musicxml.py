"""Rhythm extraction from Audiveris's MusicXML export (the .mxl half of a
recognition pass).

The rest of this project reads Audiveris's own .omr file, which carries exact
notehead pixels and pitch but says nothing about *duration* - noteheads are
recognized as shapes, and their rhythmic value is never decoded. MusicXML is
where the rhythm actually lives, so playback timing comes from here.

Deliberately stdlib-only (zipfile + ElementTree) rather than music21: the
subset needed is narrow and the schema is known (Audiveris 5.11 / ProxyMusic
4.0.3 emits plain MusicXML 4.0), and music21 is a heavy import for it. An
older, now-obsolete module (omr_notes.py) took the music21 route; don't
revive it.

What Audiveris does NOT give us: any tempo. No <sound tempo> or <metronome>
element is emitted, so absolute seconds are unknowable from OMR alone -
callers supply their own BPM (see timeline.py).
"""
import zipfile
import xml.etree.ElementTree as ET

# A .mxl is a zip whose real score entry is named by META-INF/container.xml;
# it is not safe to assume any particular filename inside.
_CONTAINER = "META-INF/container.xml"


def _score_root(mxl_path):
    with zipfile.ZipFile(mxl_path) as z:
        try:
            container = ET.fromstring(z.read(_CONTAINER))
            rootfile = container.find(".//{*}rootfile")
            name = rootfile.get("full-path") if rootfile is not None else None
        except (KeyError, ET.ParseError):
            name = None
        if not name:
            # Fall back to the single non-container .xml entry.
            candidates = [n for n in z.namelist()
                          if n.lower().endswith(".xml") and not n.startswith("META-INF")]
            if not candidates:
                raise ValueError(f"no score XML found inside {mxl_path}")
            name = candidates[0]
        return ET.fromstring(z.read(name))


def _int_text(el, default=0):
    if el is None or not (el.text or "").strip():
        return default
    try:
        return int(float(el.text.strip()))
    except ValueError:
        return default


def load_part_notes(mxl_path):
    """Parse one part's notes with rhythm.

    Returns (notes, measures):

      notes    - one dict per PITCHED note (rests dropped), in document order:
                 {measure_index, staff, step, octave, alter,
                  start_beat_in_measure, duration_beats, is_grace}
      measures - one dict per measure:
                 {measure_index, label, length_beats, nominal_length_beats,
                  content_length_beats} - length_beats is the one to sequence
                 with; the other two are kept for diagnosing bad recognition

    Beats are quarter-note units throughout (MusicXML's <divisions> is ticks
    per quarter note, and it can change mid-piece, so every duration is
    converted at the point it is read rather than once globally).
    """
    root = _score_root(mxl_path)
    part = root.find("{*}part")
    if part is None:
        raise ValueError(f"no <part> in {mxl_path}")

    notes = []
    measures = []
    divisions = 1          # ticks per quarter note, until <attributes> says otherwise
    beats, beat_type = 4, 4  # time signature, until <time> says otherwise

    for m_index, measure in enumerate(part.findall("{*}measure")):
        cursor = 0          # ticks from the start of this measure
        max_cursor = 0      # high-water mark, since <backup> rewinds it
        # start tick of the last non-chord note, so <chord/> members can share it
        last_start = 0

        for el in measure:
            tag = el.tag.split("}")[-1]

            if tag == "attributes":
                div_el = el.find("{*}divisions")
                if div_el is not None:
                    divisions = _int_text(div_el, divisions) or divisions
                time_el = el.find("{*}time")
                if time_el is not None:
                    beats = _int_text(time_el.find("{*}beats"), beats) or beats
                    beat_type = _int_text(time_el.find("{*}beat-type"), beat_type) or beat_type

            elif tag == "backup":
                cursor = max(0, cursor - _int_text(el.find("{*}duration")))

            elif tag == "forward":
                cursor += _int_text(el.find("{*}duration"))
                max_cursor = max(max_cursor, cursor)

            elif tag == "note":
                is_chord = el.find("{*}chord") is not None
                is_grace = el.find("{*}grace") is not None
                is_rest = el.find("{*}rest") is not None
                dur_ticks = _int_text(el.find("{*}duration"), 0)

                start_ticks = last_start if is_chord else cursor

                if not is_rest:
                    pitch = el.find("{*}pitch")
                    if pitch is not None:
                        notes.append({
                            "measure_index": m_index,
                            "staff": _int_text(el.find("{*}staff"), 1),
                            "voice": _int_text(el.find("{*}voice"), 1),
                            "step": (pitch.findtext("{*}step") or "C").strip(),
                            "octave": _int_text(pitch.find("{*}octave"), 4),
                            "alter": _int_text(pitch.find("{*}alter"), 0),
                            "start_beat_in_measure": start_ticks / divisions,
                            "duration_beats": 0.0 if is_grace else dur_ticks / divisions,
                            "is_grace": is_grace,
                        })

                # Grace notes steal no time from the measure, and chord members
                # sound with the note they attach to - neither advances the cursor.
                if not is_grace and not is_chord:
                    last_start = cursor
                    cursor += dur_ticks
                    max_cursor = max(max_cursor, cursor)

        nominal = beats * 4.0 / beat_type
        content = max_cursor / divisions

        if m_index == 0 and 0 < content < nominal:
            # Pickup/anacrusis: MusicXML has no explicit flag for it, so a
            # first measure simply holding less than the time signature allows
            # is taken at its actual length.
            length = content
        else:
            # max(), not nominal, and not content:
            #  - content > nominal happens for real (Audiveris misreads time
            #    signatures; this very file parses as 7/8 while its measures
            #    hold 4 quarter-notes). Using nominal there would overlap every
            #    measure into the next one, compounding down the piece.
            #  - content < nominal is usually a dropped/unrecognized note, so
            #    nominal keeps the grid honest instead of letting the piece
            #    shrink measure by measure.
            length = max(nominal, content)

        measures.append({
            "measure_index": m_index,
            "label": measure.get("number") or str(m_index + 1),
            "length_beats": length,
            "nominal_length_beats": nominal,
            "content_length_beats": content,
        })

    return notes, measures
