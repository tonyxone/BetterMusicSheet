// Before an upload: does each page show staves recognition can read?
//
// Recognition starts by finding staff lines - five straight, evenly spaced
// rules that run across the page - and a page where it finds none fails,
// minutes later, as "no music notation was detected". The uploads that went
// that way were photos of real sheet music: one washed out by a lamp's glare,
// one dim and shot at an angle, one an app screenshot with a single note on a
// lone staff. So this looks for what recognition needs, not for something that
// merely looks musical: the same five lines, found again and again along the
// width of the page.
//
// The pure measurement comes first, so it can run on test images in Node; the
// part that needs a canvas, pdf.js and the user's files is at the end.

import { isPdf } from "./photo-pages";

/** A staff found on a page: where it sits, and the gap between its lines. */
export type Staff = { y: number; interline: number; strips: number };

export type PageStaves = {
  /** Staves found along enough of the page's width to count. */
  staves: Staff[];
  /** The median gap between staff lines, in pixels of the image measured;
   * null when there is no staff. */
  interline: number | null;
};

/** The page is cut into this many vertical strips, each read on its own, so
 * a gently tilted or curled page still shows straight lines within a strip. */
const STRIPS = 16;
/** A row is a line when this much of a strip's width is dark. Staff lines run
 * the whole strip; a row of text or beams covers far less. Read twice: the
 * loose level keeps a line found on a tilted photo, where it slants across a
 * strip's rows; the strict one keeps the lines apart in a run of sixteenths,
 * where the noteheads between them darken whole rows too. */
const LINE_FILLS = [0.5, 0.85];
/** The four gaps of one staff may differ by this ratio, largest to smallest. */
const MAX_GAP_RATIO = 1.35;
/** A line is thinner than this share of the gap between lines. */
const MAX_THICKNESS = 0.6;
/** Rules closer to a staff than this many of its gaps make it part of a
 * ruled pattern - lined paper, a table - rather than a staff. */
const MIN_CLEARANCE = 1.5;
/** A staff counts once it's found in this share of the strips: real staves
 * cross most of the page, and the first system of a piece is indented. */
const MIN_STRIP_SHARE = 0.25;
/** Staff lines further apart than this share of the page width are a few
 * notes blown up - a note-quiz app, a zoomed crop - or a chart's gridlines,
 * not a sheet. On real sheets the gap is 0.5-1% of the width. */
const MAX_INTERLINE_SHARE = 0.025;

/** Dark pixels, judged against their neighbourhood rather than one global
 * level, so a page lit unevenly - a photo by a lamp - is judged fairly
 * across it (Bradley's adaptive threshold, on an integral image). */
export function darkPixels(gray: ArrayLike<number>, width: number, height: number): Uint8Array {
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += gray[y * width + x];
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row;
    }
  }
  // Sized by the longer side: a screenshot of one staff, a few hundred
  // pixels tall, would otherwise get a window full of nothing but staff,
  // and faint lines would never stand out from it.
  const half = Math.max(8, Math.round(Math.max(width, height) / 32));
  const dark = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - half), bottom = Math.min(height, y + half + 1);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - half), right = Math.min(width, x + half + 1);
      const sum = integral[bottom * (width + 1) + right] - integral[top * (width + 1) + right]
        - integral[bottom * (width + 1) + left] + integral[top * (width + 1) + left];
      const mean = sum / ((bottom - top) * (right - left));
      // Darker than its surroundings by a margin, so paper grain is not ink.
      if (gray[y * width + x] < mean * 0.85) dark[y * width + x] = 1;
    }
  }
  return dark;
}

type Line = { y: number; thickness: number };

/** The rules running across one strip: runs of rows mostly dark. */
function stripLines(dark: Uint8Array, width: number, height: number, left: number, right: number,
  fill: number): Line[] {
  const lines: Line[] = [];
  const need = (right - left) * fill;
  let start = -1;
  for (let y = 0; y <= height; y++) {
    let filled = false;
    if (y < height) {
      let count = 0;
      for (let x = left; x < right; x++) count += dark[y * width + x];
      filled = count >= need;
    }
    if (filled && start < 0) start = y;
    if (!filled && start >= 0) {
      lines.push({ y: (start + y - 1) / 2, thickness: y - start });
      start = -1;
    }
  }
  return lines;
}

/** Groups of five evenly spaced, thin lines with clear space around them. */
function stripStaves(lines: Line[]): { y: number; interline: number }[] {
  const found: { y: number; interline: number }[] = [];
  for (let i = 0; i + 4 < lines.length; i++) {
    const five = lines.slice(i, i + 5);
    const gaps = five.slice(1).map((line, k) => line.y - five[k].y);
    const smallest = Math.min(...gaps), largest = Math.max(...gaps);
    if (smallest < 3 || largest / smallest > MAX_GAP_RATIO) continue;
    const gap = gaps.reduce((a, b) => a + b) / 4;
    if (five.some((line) => line.thickness > gap * MAX_THICKNESS)) continue;
    const before = i > 0 ? five[0].y - lines[i - 1].y : Infinity;
    const after = i + 5 < lines.length ? lines[i + 5].y - five[4].y : Infinity;
    if (before < gap * MIN_CLEARANCE || after < gap * MIN_CLEARANCE) continue;
    found.push({ y: five[2].y, interline: gap });
    i += 4;
  }
  return found;
}

/** The staves on one page, from its grayscale pixels (0 black - 255 white). */
export function findStaves(gray: ArrayLike<number>, width: number, height: number): PageStaves {
  const dark = darkPixels(gray, width, height);
  const perStrip = Array.from({ length: STRIPS }, (_, s) => {
    const left = Math.floor((s * width) / STRIPS), right = Math.floor(((s + 1) * width) / STRIPS);
    const found: { y: number; interline: number }[] = [];
    for (const fill of LINE_FILLS) {
      for (const staff of stripStaves(stripLines(dark, width, height, left, right, fill))) {
        // Both readings usually find the same staff; keep it once.
        if (!found.some((f) => Math.abs(f.y - staff.y) < f.interline)) found.push(staff);
      }
    }
    return found;
  });

  // The same staff in neighbouring strips sits at nearly the same height -
  // a tilted page moves it a little from strip to strip. Chain each one
  // across the page, stepping over a strip where a chord or the margin hid it.
  type Chain = { y: number; interline: number; strips: number; last: number };
  const chains: Chain[] = [];
  perStrip.forEach((staves, s) => {
    for (const staff of staves) {
      const chain = chains.find((c) => s - c.last <= 2 && s !== c.last
        && Math.abs(c.y - staff.y) < c.interline * 1.5
        && Math.abs(c.interline - staff.interline) < c.interline * 0.25);
      if (chain) Object.assign(chain, { y: staff.y, strips: chain.strips + 1, last: s });
      else chains.push({ ...staff, strips: 1, last: s });
    }
  });
  const staves = chains
    .filter((c) => c.strips >= STRIPS * MIN_STRIP_SHARE && c.interline <= width * MAX_INTERLINE_SHARE)
    .map(({ y, interline, strips }) => ({ y, interline, strips }))
    .sort((a, b) => a.y - b.y);
  const gaps = staves.map((s) => s.interline).sort((a, b) => a - b);
  return { staves, interline: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null };
}

// ---- In the browser: the files a reader has chosen ----

/** Pages checked per upload: enough to catch a bad photo or the wrong file
 * without making a long PDF wait. Each takes well under 0.1 s. */
const MAX_CHECKED_PAGES = 10;
/** The sizes the check was measured at against past uploads: a photo at its
 * own pixels up to this long side, a PDF page drawn to this long side. */
const PHOTO_LONG_SIDE = 2400;
const PDF_LONG_SIDE = 2000;

export type UploadCheck = {
  /** Pages checked, from the first. */
  checked: number;
  /** Of those, the ones (numbered from 1) with no staff recognition could read. */
  unreadable: number[];
};

function grayPixels(canvas: HTMLCanvasElement) {
  const { width, height } = canvas;
  const rgba = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    // Transparent pixels - a PNG's background - are paper, not ink.
    const a = rgba[i * 4 + 3] / 255;
    gray[i] = Math.round((0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) * a + 255 * (1 - a));
  }
  return { gray, width, height };
}

async function photoCanvas(file: File) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, PHOTO_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/** Which of the chosen pages show no staff recognition could read: each photo
 * is a page, or each page of the one PDF. Pages are checked one at a time,
 * yielding between them, so the form stays responsive; ``cancelled`` stops
 * it once the reader has chosen something else. */
export async function checkUpload(files: File[], cancelled: () => boolean): Promise<UploadCheck | null> {
  const pages: (() => Promise<HTMLCanvasElement>)[] = [];
  let close: (() => unknown) | undefined;
  if (files.length === 1 && isPdf(files[0])) {
    const { openPdf } = await import("./pdfjs");
    const doc = await openPdf(await files[0].arrayBuffer());
    close = () => doc.destroy?.();
    for (let n = 1; n <= Math.min(doc.numPages, MAX_CHECKED_PAGES); n++) {
      pages.push(async () => {
        const page = await doc.getPage(n);
        const [, , w, h] = page.view;
        const viewport = page.getViewport({ scale: PDF_LONG_SIDE / Math.max(Math.abs(w), Math.abs(h)) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
        return canvas;
      });
    }
  } else {
    for (const file of files.slice(0, MAX_CHECKED_PAGES)) pages.push(() => photoCanvas(file));
  }
  try {
    const unreadable: number[] = [];
    for (const [index, draw] of pages.entries()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (cancelled()) return null;
      const { gray, width, height } = grayPixels(await draw());
      if (!findStaves(gray, width, height).staves.length) unreadable.push(index + 1);
    }
    return { checked: pages.length, unreadable };
  } finally {
    await close?.();
  }
}
