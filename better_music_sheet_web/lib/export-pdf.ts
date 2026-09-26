"use client";

// The "Customized" download: the sheet with the reader's version of the
// note names and their own marks, built in the browser from the same data
// the page draws. pdf-lib is loaded only when someone asks for this.

import type { LabelSet } from "./labels";
import { resolveLabel, type SheetEdits } from "./edits";
import { strokePath } from "./ink";

const LABEL_FONT_URL = "/fonts/DejaVuSans-labels.ttf";

function rgbOf(hex: string) {
  const v = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** The bundled label font has ♭ ♮ ♯ but not the double accidentals, which
 * are written as two glyphs instead. */
function printable(text: string) {
  return text.replace(/𝄫/gu, "♭♭").replace(/𝄪/gu, "×");
}

/** A text note in a script the label font lacks (Chinese, emoji...) is
 * drawn to an image instead, at print resolution, in the same place. */
function rasterizeText(text: string, sizePt: number, color: string) {
  const scale = 6;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = `${sizePt * scale}px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.font = font;
  const lines = text.split("\n");
  const lineH = sizePt * 1.2 * scale;
  const width = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  canvas.width = Math.ceil(width + 4);
  canvas.height = Math.ceil(lineH * lines.length + 4);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  lines.forEach((l, i) => ctx.fillText(l, 2, 2 + sizePt * scale + i * lineH));
  return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width / scale, height: canvas.height / scale, margin: 2 / scale };
}

export async function exportCustomizedPdf({ base, labels, edits }: {
  /** The original upload when the labels are drawn from data; otherwise the
   * annotated copy, whose printed names then stay as they are. */
  base: ArrayBuffer;
  labels: LabelSet | null;
  edits: SheetEdits;
}): Promise<Blob> {
  const [{ PDFDocument, rgb, pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode,
    setLineWidth, setStrokingRgbColor, LineCapStyle, BlendMode }, fontkit] = await Promise.all([
    import("pdf-lib"), import("@pdf-lib/fontkit").then((m) => m.default),
  ]);
  const pdf = await PDFDocument.load(base.slice(0));
  pdf.registerFontkit(fontkit);
  const fontBytes = await fetch(LABEL_FONT_URL).then((r) => {
    if (!r.ok) throw new Error(`label font missing (${r.status})`);
    return r.arrayBuffer();
  });
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const glyphs = new Set(font.getCharacterSet());
  const fits = (text: string) => [...text].every((ch) => ch === "\n" || glyphs.has(ch.codePointAt(0)!));
  const pages = pdf.getPages();

  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    const box = page.getCropBox();
    const X = (x: number) => box.x + x;
    const Y = (y: number) => box.y + box.height - y;

    for (const stroke of edits.strokes.filter((s) => s.page === pageNumber && s.tool === "highlighter")) {
      const [r, g, b] = rgbOf(stroke.color);
      page.drawSvgPath(strokePath(stroke.points), {
        x: box.x, y: box.y + box.height, borderColor: rgb(r, g, b), borderWidth: stroke.width,
        borderOpacity: 0.4, borderLineCap: LineCapStyle.Round, blendMode: BlendMode.Multiply,
      });
    }

    if (labels) {
      const [r, g, b] = rgbOf(labels.color);
      for (const item of labels.items) {
        if (item.page !== pageNumber) continue;
        const label = resolveLabel(item, edits);
        if (!label || !label.text.trim()) continue;
        const text = printable(label.text);
        if (!fits(text)) continue;
        const width = font.widthOfTextAtSize(text, label.size);
        const at = { x: X(label.x - width / 2), y: Y(label.y), size: label.size, font };
        // White outline under the fill, as annotate.py prints them: it keeps
        // a name readable where it crosses a staff line.
        page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Outline),
          setLineWidth(label.size * 0.16), setStrokingRgbColor(1, 1, 1));
        page.drawText(text, { ...at, color: rgb(1, 1, 1) });
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill), popGraphicsState());
        page.drawText(text, { ...at, color: rgb(r, g, b) });
      }
    }

    for (const stroke of edits.strokes.filter((s) => s.page === pageNumber && s.tool === "pen")) {
      const [r, g, b] = rgbOf(stroke.color);
      page.drawSvgPath(strokePath(stroke.points), {
        x: box.x, y: box.y + box.height, borderColor: rgb(r, g, b), borderWidth: stroke.width,
        borderLineCap: LineCapStyle.Round,
      });
    }
  });

  // Text notes that need an image are embedded after the page loop, since
  // embedding is asynchronous.
  for (const note of edits.texts) {
    const page = pages[note.page - 1];
    if (!page || !note.text.trim()) continue;
    const box = page.getCropBox();
    const [r, g, b] = rgbOf(note.color);
    if (fits(note.text)) {
      note.text.split("\n").forEach((line, i) => {
        page.drawText(line, { x: box.x + note.x, y: box.y + box.height - note.y - i * note.size * 1.2,
          size: note.size, font, color: rgb(r, g, b) });
      });
    } else {
      const image = rasterizeText(note.text, note.size, note.color);
      const png = await pdf.embedPng(image.dataUrl);
      // The image's first baseline sits one font size (plus its 2px margin)
      // below its top edge; line that baseline up with the note's.
      const top = note.y - note.size - image.margin;
      page.drawImage(png, { x: box.x + note.x - image.margin, y: box.y + box.height - top - image.height,
        width: image.width, height: image.height });
    }
  }

  const bytes = await pdf.save();
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}
