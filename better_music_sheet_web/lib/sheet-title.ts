// What a sheet is called. Its title is chosen when uploading - offered as
// the file's own name, or "Scan <date>" for a camera shot - and can be changed
// later (PUT /api/sheets/{id}/title); sheet_name stays the file as
// uploaded, which is what its type and download extension come from. Plain
// functions, so the rules have a test that needs no component.

/** The backend's cap (server.py TITLE_MAX_LENGTH). */
export const TITLE_MAX_LENGTH = 255;

/** A title as the backend stores it: whitespace runs, newlines included,
 * become one space, other control characters go, and the ends are trimmed.
 * Empty when nothing is left. */
export function cleanTitle(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

/** The name offered for photographed pages: ``template`` is the page
 * language's "Scan {date}", filled with the date and time to the minute, so
 * two scans on one day still have names of their own. */
export function defaultScanTitle(template: string, date: Date, tag: string): string {
  const when = new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(date);
  return template.replace("{date}", when);
}

type Named = { title?: string | null; sheet_name?: string | null };

const EXTENSION = /\.[^./\\]+$/;

/** Names that say nothing about the music: what a phone's camera calls a
 * shot it hands straight to the page ("image.jpg", "image (2).jpg", a bare
 * timestamp), and the fallback a straightened page gets ("Page"). "IMG_2041"
 * is kept - it at least finds the photo again in the camera roll. */
const GENERIC_NAME = /^(?:image|photo|picture|page|camera|capture)?[\s_-]*(?:\(\d+\)|\d+)?$/i;

/** A file's name as a title: without its extension, cleaned like a title.
 * Empty when that leaves nothing worth offering (GENERIC_NAME). */
export function titleFromFileName(name: string): string {
  const stem = cleanTitle(name.replace(EXTENSION, ""));
  return GENERIC_NAME.test(stem) ? "" : stem.slice(0, TITLE_MAX_LENGTH);
}

/** The name offered for what was chosen to upload: the first file's own
 * name (a PDF's, or the first photo's), else "Scan <date>" - see
 * defaultScanTitle for ``template``, ``date`` and ``tag``. */
export function defaultSheetName(files: { name: string }[], template: string, date: Date, tag: string): string {
  return titleFromFileName(files[0]?.name ?? "") || defaultScanTitle(template, date, tag);
}

/** What to show for a sheet. The backend always sends a title (the
 * filename's stem when none was chosen); one from before it did is called
 * the same way, by its filename without the extension. */
export function sheetTitle(job: Named): string {
  return job.title || (job.sheet_name ?? "").replace(EXTENSION, "") || job.sheet_name || "";
}

/** The extension of the file as uploaded (".jpg"), for naming a download of
 * the original after the title. Empty when it has none. */
export function uploadExtension(job: Named): string {
  return EXTENSION.exec(job.sheet_name ?? "")?.[0] ?? "";
}
