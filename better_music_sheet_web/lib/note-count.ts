// What a library row says about a finished sheet's note names, in place of
// the upload date: "606/634 notes labeled" - notes the reader named, out of
// the notes the sheet prints.
//
// The printed total is only known for a vector PDF (one exported from
// notation software); a photo or scan has no count to check against, so it
// gets the named count alone rather than a made-up total. Sheets finished
// before the counts were recorded have neither, and say nothing.

export type NoteCounts = {
  status: string;
  notes_named?: number | null;
  notes_printed?: number | null;
};

export function noteCountLabel(job: NoteCounts): string | null {
  if (job.status !== "done" || job.notes_named == null) return null;
  const named = job.notes_named.toLocaleString("en-US");
  if (!job.notes_printed) return `${named} notes labeled`;
  // Never more than the page prints: an extra head the reader imagined is
  // not an extra note labeled.
  const shown = Math.min(job.notes_named, job.notes_printed).toLocaleString("en-US");
  return `${shown}/${job.notes_printed.toLocaleString("en-US")} notes labeled`;
}
