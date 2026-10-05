// Several photos, uploaded as one sheet: a score photographed page by page.
//
// The browser puts them together into a single PDF, one photo per page in the
// order the reader chose, before uploading. To everything after the upload it
// is an ordinary multi-page PDF - no new kind of upload for the backend.
//
// The pure selection rules come first (and are unit-tested); the stitching,
// which needs a canvas, is at the end.

/** Matches the backend's page limit (MAX_PAGES in config.py). */
export const MAX_PHOTOS = 50;

const PHOTO_TYPES = ["image/jpeg", "image/png"];
const PHOTO_EXTENSIONS = /\.(jpe?g|png)$/i;

export function isPhoto(file: { name: string; type: string }) {
  return PHOTO_TYPES.includes(file.type) || PHOTO_EXTENSIONS.test(file.name);
}

export function isPdf(file: { name: string; type: string }) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** What the reader has chosen so far, after they pick or drop `incoming`:
 * one PDF, or any number of photos (added after the ones already there).
 * Several photos become one sheet; a PDF is only ever uploaded on its own.
 * Mixing the two - in one pick, or across picks - is refused (owner
 * decision), rather than silently dropping either. */
export function addFiles<T extends { name: string; type: string }>(current: T[], incoming: T[]): { files: T[]; error: string | null } {
  if (!incoming.length) return { files: current, error: null };
  const pdfs = incoming.filter(isPdf);
  const photos = incoming.filter(isPhoto);
  if (pdfs.length + photos.length !== incoming.length) {
    return { files: current, error: "Only PDF, JPG and PNG files are supported." };
  }
  const havePdf = current.some(isPdf);
  const havePhotos = current.some(isPhoto);
  if ((pdfs.length && photos.length) || (pdfs.length && havePhotos) || (photos.length && havePdf)) {
    return { files: current, error: "A PDF and photos can't be uploaded together. Upload the PDF on its own, "
      + "or remove it and upload only photos." };
  }
  if (pdfs.length) {
    if (pdfs.length > 1) return { files: current, error: "Upload one PDF at a time." };
    return { files: pdfs, error: null };
  }
  const files = [...current, ...photos];
  if (files.length > MAX_PHOTOS) {
    return { files: current, error: `A sheet can have at most ${MAX_PHOTOS} pages.` };
  }
  return { files, error: null };
}

/** The list with the item at `from` moved to position `to`, the rest keeping
 * their order - what dragging a page to a new place does. Unchanged if
 * either position is off the list. */
export function moveFile<T>(files: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= files.length || to < 0 || to >= files.length) return files;
  const next = [...files];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function removeFile<T>(files: T[], index: number): T[] {
  return files.filter((_, i) => i !== index);
}

// ---- stitching (browser only) ----

// Recognition reads a PDF at 300 DPI. Sizing each page so its photo comes out
// at exactly that gives the reader of the notes the photo's own pixels, no
// more and no fewer.
const RECOGNITION_DPI = 300;
// Long side of an A4 page at 300 DPI: plenty for recognition, and it keeps a
// dozen phone photos well inside the upload limit. A second, smaller pass is
// tried if they still don't fit.
const ATTEMPTS = [{ longSide: 3508, quality: 0.85 }, { longSide: 2800, quality: 0.72 }];

async function photoToJpeg(file: File, longSide: number, quality: number) {
  // from-image: a phone photo held sideways is stored rotated, with a tag
  // saying so. Without honouring the tag the page would come out on its side.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  // A transparent PNG would otherwise turn black as a JPEG.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error(`Couldn't read ${file.name}.`);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

/** An uploaded photo as the one-page PDF the worker reads it as
 * (processor.photo_as_pdf): turned the way its orientation tag says, at full
 * resolution, sized at RECOGNITION_DPI. The viewer shows a photo whose names
 * failed through it, so marks made there land where they will on the
 * annotated sheet if a later attempt succeeds. */
export async function photoAsPdf(bytes: ArrayBuffer, type: string): Promise<ArrayBuffer> {
  const { PDFDocument } = await import("pdf-lib");
  const bitmap = await createImageBitmap(new Blob([bytes], { type }), { imageOrientation: "from-image" });
  const { width, height } = bitmap;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  // A screenshot stays lossless; a photo is already a JPEG.
  const png = type === "image/png";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, png ? "image/png" : "image/jpeg", 0.92));
  if (!blob) throw new Error("Couldn't read the photo.");
  const encoded = new Uint8Array(await blob.arrayBuffer());
  const pdf = await PDFDocument.create();
  const image = png ? await pdf.embedPng(encoded) : await pdf.embedJpg(encoded);
  const page = pdf.addPage([width * 72 / RECOGNITION_DPI, height * 72 / RECOGNITION_DPI]);
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  const saved = await pdf.save();
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
}

/** The photos as one PDF, a page each, in order - under `maxBytes` if it can
 * be done without making the pages too small to read. */
export async function combinePhotos(files: File[], maxBytes: number): Promise<File> {
  const { PDFDocument } = await import("pdf-lib");
  const stem = files[0].name.replace(/\.[^.]+$/, "") || "Photos";
  let size = 0;
  for (const { longSide, quality } of ATTEMPTS) {
    const pdf = await PDFDocument.create();
    for (const file of files) {
      const { bytes, width, height } = await photoToJpeg(file, longSide, quality);
      const image = await pdf.embedJpg(bytes);
      const page = pdf.addPage([width * 72 / RECOGNITION_DPI, height * 72 / RECOGNITION_DPI]);
      page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    }
    const bytes = await pdf.save();
    size = bytes.byteLength;
    if (size <= maxBytes) return new File([bytes as BlobPart], `${stem}.pdf`, { type: "application/pdf" });
  }
  throw new Error(`These ${files.length} photos come to ${(size / 1024 / 1024).toFixed(1)} MB together, over the `
    + `${Math.round(maxBytes / 1024 / 1024)} MB limit. Try fewer pages per upload.`);
}
