import type { Timeline } from "@/lib/timeline";

/** Display the score's beat unit while the audio clock uses quarter beats. */
export function tempoControl(timeline: Timeline, quarterBpm?: number | null) {
  const opening = timeline.tempo_map?.[0];
  const unit = opening?.beat_unit_quarters;
  const quarters = unit && Number.isFinite(unit) && unit > 0 ? unit : 1;
  const names: Record<number, string> = {
    .25: "sixteenth note", .5: "eighth note", .75: "dotted eighth note",
    1: "quarter note", 1.5: "dotted quarter note", 2: "half note",
    3: "dotted half note", 4: "whole note", 6: "dotted whole note",
  };
  return {
    bpm: Math.round((quarterBpm ?? opening?.bpm ?? timeline.tempo_bpm_default) / quarters * 1000) / 1000,
    unit: names[quarters] ?? `${quarters} quarter notes`,
    toQuarterBpm: (bpm: number) => bpm * quarters,
  };
}

/** No matter how the score's own tempo, a BPM override and the speed slider
 * combine, playback should never exceed this - the BPM field's own max (see
 * play-view.tsx) keeps a typed override under it on its own, but the speed
 * slider is a separate multiplier on top of that and was able to push the
 * real, sounding tempo well past it (BPM 300 x 2.0x speed = 600). Past this,
 * short notes round toward zero duration and dense chords start to overlap
 * into noise rather than music. */
const MAX_EFFECTIVE_BPM = 300;

/** Piecewise integration/inversion keeps audio, seek and visuals on one clock. */
export function tempoClock(timeline: Timeline, speed = 1, baseBpm?: number | null) {
  const input = [...(timeline.tempo_map?.length ? timeline.tempo_map : [{ start_beat: 0, bpm: timeline.tempo_bpm_default || 96 }])]
    .filter((t) => Number.isFinite(t.bpm) && t.bpm > 0 && Number.isFinite(t.start_beat))
    .sort((a, b) => a.start_beat - b.start_beat);
  if (!input.length || input[0].start_beat > 0) input.unshift({ start_beat: 0, bpm: timeline.tempo_bpm_default || 96 });
  const scale = baseBpm && baseBpm > 0 ? baseBpm / input[0].bpm : 1;
  // Checked against the FASTEST tempo anywhere in the piece, not just its
  // opening one - a score that speeds up partway through (a Presto section
  // after an Andante opening) would otherwise blow past the ceiling there
  // even with the opening well under it.
  //
  // The speed slider gives way here, not the BPM override: the override is
  // a number the user explicitly typed, and silently changing it out from
  // under them would be more confusing than capping the more casual "how
  // fast to play this" multiplier instead.
  const fastestScoreBpm = Math.max(...input.map((t) => t.bpm));
  const requestedRate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const rate = Math.min(requestedRate, MAX_EFFECTIVE_BPM / (fastestScoreBpm * scale));
  let seconds = 0;
  const segments = input.map((t, i) => {
    if (i) seconds += (t.start_beat - input[i - 1].start_beat) * 60 / (input[i - 1].bpm * scale * rate);
    return { beat: t.start_beat, seconds, secondsPerBeat: 60 / (t.bpm * scale * rate) };
  });
  return {
    secondsAt(beat: number) {
      let s = segments[0];
      for (const candidate of segments) {
        if (candidate.beat > beat) break;
        s = candidate;
      }
      return s.seconds + (beat - s.beat) * s.secondsPerBeat;
    },
    beatAt(seconds: number) {
      let s = segments[0];
      for (const candidate of segments) {
        if (candidate.seconds > seconds) break;
        s = candidate;
      }
      return s.beat + (seconds - s.seconds) / s.secondsPerBeat;
    },
  };
}
