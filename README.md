# Music-Sheet Note-Name Annotator

Takes a **piano sheet-music PDF**, reads the notes with optical music recognition
(OMR), and produces a copy of the **original** PDF with the letter name of every
note printed on top of it — `B♭`, `C♯`, `D♭`, `G♭`, … — stacked vertically when
several notes sound together in one beat (chords). The original sheet music is
left untouched; only the labels are overlaid.

```
input.pdf  ──►  input (annotated).pdf
```

## The concept

Learning to read music is hard partly because a note's position on the staff must
be mentally converted into a pitch name. This app automates that conversion and
prints the answer right where you need it:

- one label per note, directly **above** the notehead for the right-hand /
  treble staff and **below** it for the left-hand / bass staff;
- simultaneous notes (chords, and same-beat notes across voices) are **stacked
  vertically**, highest pitch furthest from the staff;
- labels use Unicode accidentals by default (`B♭`, `C♯`, `D♭`) or ASCII
  (`Bb`, `C#`, `Db`), optionally with the octave number appended (`B♭4`).

The result is the same sheet you already have — same engraving, same layout —
with training wheels added.

## How it works

The pipeline has three stages:

```
PDF input
   │
   │  (1) Audiveris OMR  —  Audiveris.exe -batch -export
   ▼
book.mxl   MusicXML  (kept for reference; not used for the labels)
book.omr   Audiveris's own recognition data — a zip of per-page XML containing,
           for every recognized notehead: the EXACT pixel bounding box, the staff
           it belongs to, and Audiveris's own diatonic pitch
   │
   │  (2) Labeling — per notehead: correct pitch = Audiveris pitch, converted
   │      through the ACTUAL clef at that position (read from the PDF's own clef
   │      glyphs) + the key signature + any explicit accidentals
   ▼
per-note (x, y) positions in the PDF's own pixel space, plus the label text
   │
   │  (3) Rendering — PyMuPDF overlay onto the untouched original vector PDF
   ▼
output.pdf
```

### 1. Optical music recognition (Audiveris)

`run.py` invokes the bundled Audiveris 5.11 in batch mode:

```
Audiveris.exe -batch -export -output <dir> <pdf>
```

This produces two files per input:

- **`<book>.mxl`** — MusicXML: Audiveris's exported interpretation.
- **`<book>.omr`** — Audiveris's internal book file (a zip archive with one
  `sheet#N.xml` per page). The key insight of this project is that this "cache"
  is not just an opaque blob: it contains the full recognition graph with a
  `<bounds x y w h>` on every `<head>` element — i.e. Audiveris's own
  pixel-accurate notehead positions, already in the same 300 dpi space as a
  straightforward rasterization of the source PDF. That removes the need for any
  custom computer-vision notehead detection. Each `<head>` also carries a
  `pitch` attribute (its diatonic position on the staff) and is linked to the
  `<head-chord>` that groups simultaneous notes.

### 2. Labeling each notehead

`annotate.py` derives every label from the notehead itself, never from the
exported `.mxl`:

- `audiveris_heads.py` reads `<head>` elements out of the `.omr` zip (de-duplicating
  noteheads Audiveris recorded twice at the same position), groups them by staff,
  and clusters simultaneous notes into chord-groups using Audiveris's own
  `<head-chord>` containment relations.
- The **clef in effect at each notehead** is read from the PDF's own clef glyphs
  (the G-clef and F-clef symbols in the PDF's text layer, per staff, with any
  mid-piece clef changes). This matters because Audiveris can *misread a clef
  change* — e.g. the left hand switching to bass clef mid-piece — which would
  otherwise silently transpose every pitch it exports for that passage.
- The note's diatonic pitch (Audiveris's `pitch`, relative to the middle line of
  the staff in the clef Audiveris used) is converted through that actual clef,
  then the key-signature accidental (from Audiveris's key alters) and any
  explicit accidentals (Audiveris's `<alter>` → `<head>` links) are applied to
  form the label text.

Every notehead Audiveris detected gets a label; chords are stacked vertically.

### 3. Rendering the labels

The labels are drawn with **PyMuPDF** onto a copy of the original vector PDF —
no re-engraving, so the sheet keeps its exact original appearance. Layout rules:

- above the staff for the right-hand/treble part, below for the left-hand/bass;
- multi-note beat-groups stacked vertically, highest pitch furthest from the staff;
- a white halo behind each label keeps it readable over staff lines;
- the font is **Arial Unicode MS** (`C:\Windows\Fonts\arialuni.ttf`), because
  regular Arial is missing the `♭` glyph; the font is subsetted and embedded on
  save to keep the output file small.

Crowding is handled in two ways: neighboring beats on the same staff are nudged
apart horizontally, and a stack that would collide with a different system is
repositioned to sit *beside* its note (still a vertical stack) instead of
growing into the neighboring line.

## Requirements

- **Windows** (the Audiveris build and the font path are Windows-specific).
- **Python 3.12** with a virtual environment.
- **Audiveris 5.11** (Windows build), already bundled at
  `tools/Audiveris/Audiveris/Audiveris.exe` — its runtime/JRE is included, so
  no separate Java installation is needed.
- **Arial Unicode MS** (`C:\Windows\Fonts\arialuni.ttf`), present by default on
  Windows.

## Setup

```powershell
# 1. Create the virtual environment (once)
python -m venv .venv

# 2. Install dependencies
.venv\Scripts\python.exe -m pip install music21 pymupdf
```

The project's `.venv` also contains numpy/opencv-python-headless from an earlier
revision of the plan, but the shipped pipeline only needs **PyMuPDF** at runtime
(music21 is no longer used).

> Note: keep these packages inside `.venv` — do not install them into a shared
> base environment (an earlier misstep forced a numpy downgrade there).

## Usage

```powershell
.venv\Scripts\python.exe run.py <input.pdf> [options]
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `-o, --output` | `<input stem> (annotated).pdf` | Output PDF path |
| `--style unicode\|ascii` | `unicode` | `B♭`/`C♯` vs `Bb`/`C#` |
| `--octave` | off | Append the octave number (`B♭4`) |
| `--font-size N` | `6.5` | Label font size in points |
| `--work-dir DIR` | `output` | Where intermediate Audiveris files go |

Example:

```powershell
.venv\Scripts\python.exe run.py "your lie in april - Again.pdf"
# -> "your lie in april - Again (annotated).pdf"  (+ output/*.mxl, *.omr)
```

Intermediate Audiveris output (`.mxl`, `.omr`, and Audiveris's own log) lands in
`output/`. Rerunning overwrites it.

If Audiveris has already been run and you only want to re-do the labeling and
rendering, `annotate.py` can run standalone:

```powershell
.venv\Scripts\python.exe annotate.py input.pdf --omr output\book.omr
```

## Project layout

```
run.py             End-to-end driver: PDF -> Audiveris OMR -> annotated PDF
annotate.py        Per-notehead labeling (omr pitch x actual clef x key sig)
                   + label layout + rendering
audiveris_heads.py Parse <head> positions, pitches, chord relations, key
                   signature, accidentals and staff lines out of the .omr zip
labels.py          Diatonic pitch + accidental -> label text (unicode/ascii, octave)
omr_notes.py       (obsolete) old music21/.mxl parsing — kept for reference only
server.py          REST API (upload a PDF, poll job status, download the result)
tools/Audiveris/   Bundled Audiveris 5.11 OMR engine (not committed — see Setup)
output/            Intermediate .mxl / .omr files and logs
```

## Known limitations

- Labels come from the noteheads Audiveris detects. A notehead Audiveris fails to
  detect at all (rare — roughly 1% of notes on the reference pieces) simply has
  no label; there is no fallback detector.
- Audiveris occasionally misreads a *clef change* (e.g. the left hand switching
  to bass clef mid-piece). The pipeline compensates by reading the clef from the
  PDF's own clef glyphs; for PDFs with no readable text layer (scanned sheets),
  it falls back to Audiveris's clef reading and such passages can be wrong.
- Repeated 3+-note chords within the same measure are labeled once (a deliberate
  de-duplication); single notes and two-note dyads are always labeled.
- The pipeline assumes a standard two-part piano layout (two staves per system:
  right hand above, left hand below), regardless of which clefs the parts use.

## License

This project is licensed under the [GNU AGPL v3.0](LICENSE).

That choice isn't arbitrary: [PyMuPDF](https://pypi.org/project/PyMuPDF/) (used
directly in `annotate.py`/`server.py`) is dual-licensed under AGPL-3.0 or a paid
commercial license from Artifex, and this code links it as a library rather than
shelling out to it — so this project inherits that copyleft. If you deploy this
(including as a network service, e.g. `server.py`), AGPL §13 requires that users
be able to get this project's complete corresponding source.

[Audiveris](https://github.com/Audiveris/audiveris) (also AGPL-3.0, not committed
to this repo — see Setup) is invoked as an external subprocess, not linked, so it
doesn't independently impose requirements on this project's own license choice.

Sample sheet-music PDFs are intentionally **not** included in this repo (see
`.gitignore`) — they're copyrighted third-party material, not project code.
