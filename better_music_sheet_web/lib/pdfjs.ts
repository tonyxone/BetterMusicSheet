"use client";

// One place that knows how to bring pdf.js up in this app - shared by the
// sheet viewer and by the label reader for older sheets (lib/labels.ts).

export type PdfTextItem = { str: string; transform: number[]; width: number; height: number; fontName?: string };

export type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number; transform: number[] };
  view: number[];
  render: (o: Record<string, unknown>) => { promise: Promise<void>; cancel: () => void };
  getTextContent: () => Promise<{ items: (PdfTextItem | { type: string })[] }>;
};

export type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy?: () => Promise<void>;
};

export async function loadPdfjs() {
  // Must land before pdf.js: it reaches for the Uint8Array base64/hex
  // methods Safari only shipped in 18.2, and throws "toHex is not a
  // function" without them. The worker gets the same polyfill prepended
  // at build time (scripts/copy-pdf-worker.mjs).
  await import("@/lib/binary-polyfill.js");
  const pdfjs = await import("pdfjs-dist");
  // Served from the site root, copied out of node_modules at build time
  // by scripts/copy-pdf-worker.mjs. Resolving it through the bundler
  // instead (new URL(..., import.meta.url)) does not emit the asset for
  // a node_modules path, so the worker 404s.
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  return pdfjs;
}

/** pdf.js takes ownership of the buffer it is given, so it always gets a
 * copy - React mounts effects twice in dev and the second pass would
 * otherwise find the original detached. */
export async function openPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const pdfjs = await loadPdfjs();
  return (await pdfjs.getDocument({ data: data.slice(0) }).promise) as unknown as PdfDoc;
}
