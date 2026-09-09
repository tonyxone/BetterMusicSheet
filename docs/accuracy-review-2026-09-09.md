# Sheet annotation and playback accuracy review

Reviewed September 9, 2026, then implemented in the same working tree. The findings below preserve the original evidence and recommended fixes; the implementation status records what changed.

## Implementation status

All findings in this review have been addressed in the application. Shared resolved note identities now drive annotation and playback; accidentals and key changes retain state; vector-PDF clefs, octave lines, and metronome marks can correct inconsistent exports; ties sustain; repeat/endings and D.C./D.S./coda navigation expand into performed occurrences; missing geometry stays on its source page; and playback handles resume, long sustains, rests, tempo changes, pedal, dynamics, wedges, articulation, arpeggios, common ornaments, grace timing, and fermatas.

Recognition uncertainty is exposed instead of hidden. Ambiguous accidentals receive a `?` annotation, approximate playheads are amber, alignment statistics and musical notices appear in Review notes, and browser-saved corrections can change pitch, onset, duration, and hand for every performed occurrence of a printed note. Retry selection now considers confidence, pitch range, rhythm consistency, and cross-export note-count agreement in addition to detecting more heads.

Validation now includes 35 hand-authored ground-truth fixtures for the backend, 14 deterministic audio-clock tests for the browser player, TypeScript and targeted ESLint checks, a production Next.js build, and a crash/range/timing sweep over 38 distinct saved MusicXML exports. A regenerated five-page score matched 1,762 of 1,782 performed note segments, reported the remaining 20 as unmatched, and had no measure-count mismatch. The rendered annotation was also checked visually for placement, clipping, chord readability, octave-line handling, and tempo-mark interpretation.

The remaining limitation is inherent to OMR: a symbol that is absent or falsely recognized cannot always be reconstructed without a verified source score or a user correction. The application now reports that uncertainty and provides a correction workflow instead of silently inventing a result.

## Findings and recommended fixes

### 1. High: accidentals do not carry through the measure

Location: `annotate.py:237–243`, `audiveris_heads.py:122–140`.

Each head starts from its key-signature accidental and only checks for an accidental directly attached to that head. There is no state for a previous sharp, flat, or natural on the same pitch in the measure.

Reproduction using the real annotation function with synthetic recognition inputs: two F4 notes in C major, with a sharp attached only to the first, produce `F#4, F4`. Expected: `F#4, F#4`.

Maintain accidental state by staff and written pitch including octave, shared across voices, reset at measure boundaries. Resolve notes in musical order; handle simultaneous conflicting accidentals explicitly. Preserve tied pitch across barlines. Cover sharps, flats, naturals, octave separation, multiple voices, and barline resets with fixtures.

### 2. High: corrected annotation pitches do not reach playback

Location: `annotate.py:228–243`, `timeline.py:312–324`, `run.py:250–261`.

The annotation path corrects clefs using PDF glyphs. The playback path separately computes MIDI directly from the exported MusicXML pitch. A misrecognized clef can therefore be corrected in the printed label while remaining wrong in the sound and illuminated key. This finding follows directly from the two code paths; no new end-to-end clef mismatch rate was measured.

Create shared resolved-note records containing source IDs, written pitch, sounding pitch, accidental, clef, staff, voice, geometry, and confidence/provenance. Use these for both annotation and playback after reliable alignment to rhythm. Do not substitute pitch merely because two lists have the same length. Include octave-transposition markings in the design and validate how the exporter encodes them.

### 3. High: ties are played as separate attacks and also damage geometry matching

Location: `musicxml.py:96–122`, `timeline.py:125–145`, `timeline.py:299–311`.

The MusicXML parser retains every pitched note but discards tie information. The player consequently schedules tied segments as separate attacks. Meanwhile, the geometry loader drops tie-stop heads based on the incorrect premise that MusicXML omits those notes, creating count mismatches and lost positions.

A synthetic pair of tied whole notes becomes two independent four-beat notes with no preserved tie fields. Existing exports also contain explicit start and stop notes: one inspected file has B-flat3 tie segments in measures 23 and 24. Across 37 distinct export file hashes, 2,614 `<tie>` elements were found; distinct hashes can still represent repeated processing of the same piece.

Preserve each written segment for highlighting, and build a separate sustained audio event for a validated tie chain. Match by part, voice, pitch, time adjacency, and tie metadata, including system/page crossings. A tie should sustain; a repeated untied pitch should reattack. MusicXML explicitly distinguishes sounding `<tie>` from visual `<tied>`: [MusicXML tie reference](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/tie/).

### 4. High: key changes are collapsed into a single incorrect signature

Location: `audiveris_heads.py:101–119`, `annotate.py:237`.

All key-signature sharp and flat glyphs on a staff are counted together, without their positions or change boundaries. A synthetic staff containing a one-sharp signature followed by a two-sharp signature returns three sharps for the entire staff. Earlier and later notes can both be mislabeled.

Read signature events and their boundaries, and resolve the signature at each note. Handle cancellation naturals, key changes to C major, and inherited signatures across systems/pages. Validate any signature interpretation against MusicXML attributes rather than summing all glyphs.

### 5. High: repeat navigation is discarded

Location: `musicxml.py:75–138`, `timeline.py:280–337`.

Measures are walked once in printed order. Repeat barlines and endings are not parsed, and direction instructions are ignored. A two-measure synthetic score with a backward repeat still produces only the two printed measures and carries no repeat metadata. Existing exports contain 45 `<repeat>` elements.

Separate printed measure identity from performed measure occurrences. Expand repeat sections and endings with bounded traversal, then add supported D.C./D.S./coda navigation. Keep every occurrence linked to its original page region. MusicXML defines repeat information for sound generation: [MusicXML playback tutorial](https://www.w3.org/2021/06/musicxml40/tutorial/midi-compatible-part/).

### 6. High: missing geometry can shift music onto the wrong page

Location: `timeline.py:246–282`.

Page allocation consumes MusicXML measures according to the number of OMR regions, then assigns boxes globally by list index. If page 1 has no regions, page 2 receives the first unconsumed music from page 1.

A synthetic two-page example reproduced measure 1 assigned to page 2 and measure 2 assigned no page. Retry pages whose measure counts differ can also invalidate positional assumptions; those variants were identified by inspection, not separately reproduced.

Preserve source page and measure identity independently of recognized geometry. Missing geometry should leave a note unpositioned without moving later music. Use page/system breaks, source identifiers, pitch and rhythm constraints for alignment. Equal group counts alone are insufficient evidence of a correct match, especially with multiple voices at the same onset.

### 7. High: the player cuts sustained notes and loses notes on resume

Location: `better_music_sheet_web/app/play/playback.ts:138–148`, `:207–213`.

Three cases were reproduced by executing the current TypeScript player with a fake audio clock and synth:

- Resume at beat 2 inside a four-beat note: zero notes are scheduled, because only notes starting after the resume point are selected.
- An eight-beat bass note under a later one-beat treble note: playback stops at beat 2.3, cutting the bass. Completion uses the end of the last note by onset, rather than the latest ending event.
- A note followed by trailing rests: playback stops before the measure finishes.

Schedule events overlapping the requested window, clipping their remaining duration to the window. End at the playback window boundary and account for the latest sounding event. Verify both audio and highlight behavior on resume, seek, and speed changes.

### 8. Medium: playback omits much of the performance information already recognized

Location: `musicxml.py:75–138`, `better_music_sheet_web/lib/timeline.ts`, `better_music_sheet_web/app/play/synth.ts:46`, `better_music_sheet_web/app/play/playback.ts:123–148`.

The exported timeline has no dynamics, articulation, pedal, or tempo-map fields. The synth uses a constant peak amplitude. Grace notes share their main-note onset and get a fixed 0.12-second duration; sequences of grace notes therefore cannot be interpreted properly.

The 37 distinct exports contained 1,390 pedal elements, 624 dynamics elements, 5,710 articulations containers, 177 octave-shift elements, and one grace element. Counts demonstrate available information, not recognition correctness. No metronome elements were found in this sample.

Preserve expressive events before implementing their audible interpretation. Add dynamic velocity, articulation-aware duration, and pedal sustain; distinguish keys physically held from notes sustained by pedal. Use encoded grace timing where available and document a fallback convention. Read tempo when present and allow a clearly identified user BPM fallback when it is absent. MusicXML provides timing suggestions for grace notes: [MusicXML grace reference](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/grace/).

## Other useful improvements

- Label coverage: `annotate.py:270` suppresses repeated chords of two or more notes using their rendered labels. With octave labels disabled, different octave voicings can collide. Make repetition suppression optional and compare actual pitches. The README currently says dyads are always labeled, which disagrees with the code.
- Hand guidance: staff position is treated as hand assignment. Preserve staff and hand as separate concepts, and allow correction for cross-staff notation and hand crossings. Fingering suggestions should be identified as suggestions rather than read from staff position.
- Recognition selection: `run.py:209` accepts a retry solely because it finds more heads. More detections need not mean more correct notes. Evaluate rhythm consistency, supported pitch range, recognition confidence where available, and agreement between exports; surface unresolved cases.
- Timing edge cases: first-measure pickup inference and `max(nominal, content)` are heuristics. Preserve irregular-measure metadata and expose inconsistencies. Normalize cursor arithmetic into beat units before supporting within-measure divisions changes; the current cursor retains raw ticks while the divisor can change. Add additive-meter and grace-chord fixtures.
- Observability: backend alignment statistics are not represented in the frontend timeline type. Expose uncertain measures and permit user corrections rather than presenting interpolated positions as exact recognition.

## Original validation evidence and proposed implementation order

The initial review used source tracing, seven small executable reproductions (accidental carry, key change, combined tie/repeat metadata loss, missing page geometry, and three player cases), plus read-only inspection of existing exports. At that point, no OMR rerun, listening study, PDF layout assessment, or manually labeled accuracy benchmark had been performed, and no dedicated automated test suite was found in the tracked source. The implementation validation completed afterward is recorded in **Implementation status** above. Existing exported scores remain useful regression inputs but are not ground truth.

Recommended sequence:

1. Add focused musical fixtures and fix accidental state, key changes, ties, and player scheduling.
2. Share resolved pitches and replace global positional alignment with explicit printed-note/measure identity.
3. Add repeat navigation, then pedal, dynamics, articulation, grace timing, and tempo handling.
4. Build a manually verified benchmark spanning clean PDFs and scans, key/clef changes, ties, tuplets, multiple voices, pickups, cross-staff passages, and repeats.

Measure note detection precision/recall, exact written and sounding pitch accuracy, onset/duration accuracy, repeat order, label coverage, and source-note alignment separately. Publish uncertainty coverage as well as accuracy so rejecting uncertain matches cannot silently inflate the result.
