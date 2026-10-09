// How far along adding the note names is, for the progress bar on a sheet
// that is still being read (app/sheets/job-status.tsx).
//
// The backend reports a stage, not a number: the job's `stage` is one of the
// names processor.py publishes, with worker.py's "(page 2 of 5)" appended
// while a multi-page sheet is being read, and anything after " · " detail.
// Each stage gets a share of the bar, roughly by how long it takes; reading
// the music dominates. Inside a stage the bar creeps on towards the next one
// without ever reaching it, so it keeps moving while a page takes its time
// but never promises more than the stage it is in.

/** [stage the job's `stage` starts with, start of its share, end of it]. */
const STAGES: [string, number, number][] = [
  ["Uploading sheet", 0, 0.03],
  ["Waiting for a recognition worker", 0.03, 0.08],
  ["Retrying interrupted processing", 0.03, 0.08],
  ["Recovering interrupted processing", 0.03, 0.08],
  ["Reading sheet music", 0.08, 0.7],
  ["Re-reading unclear pages", 0.7, 0.84],
  ["Matching pitches to notes", 0.84, 0.9],
  ["Building playback timeline", 0.9, 0.95],
  ["Drawing the annotated sheet", 0.95, 0.99],
];

/** How quickly the bar creeps within a stage: after this many seconds it
 * has covered a little over half of the stage's share. */
const CREEP_SECONDS = 30;
/** The furthest the creep goes into a stage's share. */
const CREEP_LIMIT = 0.9;

const PAGE = /\(page (\d+) of (\d+)\)/;

export type NamesStage = {
  /** Identifies the stage (and page) - the creep restarts when it changes. */
  key: string;
  /** Where on the bar this stage begins and ends, 0 to 1. */
  start: number;
  end: number;
};

/** Where on the bar a job's `stage` sits. Unknown or missing stages count
 * as waiting to start. */
export function namesStage(stage: string | null | undefined): NamesStage {
  const text = (stage || "").trim();
  if (text === "Complete") return { key: "Complete", start: 1, end: 1 };
  const found = STAGES.find(([name]) => text.startsWith(name));
  if (!found) return { key: "", start: STAGES[1][1], end: STAGES[1][2] };
  const [name, start, end] = found;
  // A multi-page sheet being read: each page gets its slice of the stage.
  const page = name === "Reading sheet music" ? PAGE.exec(text) : null;
  if (page) {
    const total = Math.max(1, Number(page[2]));
    const current = Math.min(Math.max(1, Number(page[1])), total);
    const size = (end - start) / total;
    return { key: `${name} ${current}/${total}`, start: start + size * (current - 1), end: start + size * current };
  }
  return { key: name, start, end };
}

/** The bar's fill, 0 to 1, for a stage reached ``seconds`` ago. */
export function namesProgress(stage: NamesStage, seconds: number) {
  if (stage.start >= 1) return 1;
  const creep = CREEP_LIMIT * (1 - Math.exp(-Math.max(0, seconds) / CREEP_SECONDS));
  return stage.start + (stage.end - stage.start) * creep;
}
