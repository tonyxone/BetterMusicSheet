"use client";

import { useState } from "react";
import type { Timeline } from "@/lib/timeline";
import type { Corrections, NoteCorrection } from "@/lib/corrections";

function pitchName(midi: number) {
  return ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"][midi % 12] + (Math.floor(midi / 12) - 1);
}

export default function NoteCorrections({ timeline, measureIndex, corrections, onSave, onReset }: {
  timeline: Timeline; measureIndex: number | null; corrections: Corrections;
  onSave: (id: string, correction: NoteCorrection) => void; onReset: (id: string) => void;
}) {
  const [selected, setSelected] = useState("");
  const m = timeline.measures[measureIndex ?? 0];
  const notes = timeline.notes.filter((n) => n.measure_index === m?.index);
  const note = notes.find((n) => (n.printed_id ?? n.source_id) === selected) ?? notes[0];
  const id = note?.printed_id ?? note?.source_id;
  const issues = [...new Set([...(timeline.warnings ?? []), ...(m?.warnings ?? [])])];
  return <details className="play-review">
    <summary>Review notes{issues.length ? ` · ${issues.length} notices` : ""}</summary>
    <p>Colors initially follow the upper and lower staves. Hand choices can differ. Corrections are saved in this browser for playback; the downloaded PDF retains its generated labels.</p>
    {issues.length > 0 && <ul>{issues.map((w) => <li key={w}>{w}</li>)}</ul>}
    {timeline.stats && <p>{timeline.stats.notes_matched ?? 0} notes aligned; {timeline.stats.notes_unmatched ?? 0} need alignment review. Positions without a match are shown approximately.</p>}
    {!!timeline.stats?.notes_recovered && <p>{timeline.stats.notes_recovered} omitted notes recovered from detected noteheads. Review their inferred timing.</p>}
    {note && id && m ? <>
      <label>Note in measure {m.label}
        <select value={id} onChange={(e) => setSelected(e.target.value)}>
          {notes.map((n) => <option key={n.source_id} value={n.printed_id ?? n.source_id}>
            {pitchName(n.midi)} · beat {(n.start_beat - m.start_beat + 1).toFixed(2)} · staff {n.staff ?? n.role + 1}
          </option>)}
        </select>
      </label>
      <form key={`${id}:${JSON.stringify(corrections[id])}`} onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const hand = data.get("hand");
        onSave(id, { midi: Number(data.get("pitch")), hand: hand === "left" || hand === "right" ? hand : null,
          offset: Number(data.get("beat")) - 1, duration: Number(data.get("duration")) });
      }}>
        <label>Pitch <select name="pitch" defaultValue={note.midi}>{Array.from({ length: 88 }, (_, i) => i + 21).map((midi) => <option key={midi} value={midi}>{pitchName(midi)}</option>)}</select></label>
        <label>Hand <select name="hand" defaultValue={note.hand ?? "unknown"}><option value="unknown">Use staff color</option><option value="right">Right</option><option value="left">Left</option></select></label>
        <label>Beat <input name="beat" type="number" min={1} max={m.length_beats + .999} step="any" defaultValue={note.start_beat - m.start_beat + 1} required /></label>
        <label>Duration (quarter notes) <input name="duration" type="number" min={.001} max={128} step="any" defaultValue={note.duration_beats || .125} required /></label>
        <button type="submit" title="Save this note correction in this browser">Save correction</button>
        <button type="button" title="Remove the saved correction for this note" disabled={!corrections[id]} onClick={() => onReset(id)}>Reset note</button>
      </form>
      {note.fingering && <p>Printed fingering: {note.fingering}</p>}
    </> : <p>Choose a measure containing notes to review it.</p>}
  </details>;
}
