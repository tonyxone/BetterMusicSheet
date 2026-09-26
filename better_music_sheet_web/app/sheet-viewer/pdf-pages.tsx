"use client";

// A PDF drawn to one <canvas> per page with pdf.js, with room for overlays
// positioned in the page's own coordinates. Shared by the Play page (measure
// boxes, playhead) and the sheet preview (the editable annotation layer).
//
// The browser's built-in PDF viewer gives no access to page coordinates at
// all, which is why both render through pdf.js instead.
//
// Two passes, deliberately: open the document and lay out one <canvas> per
// page first, then rasterize into those mounted canvases. Rendering into
// detached canvases and handing them to React afterwards fights React over
// the DOM and leaves pdf.js working on an unattached element.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { isMissingBrowserFeature } from "@/lib/browser-support";
import { openPdf, type PdfDoc } from "@/lib/pdfjs";

const RENDER_SCALE = 2; // rasterize above CSS size so the sheet stays sharp

/** A failure to show, and whether the reader can do anything about it. */
type ViewerError = { unsupported: boolean };

function describe(err: unknown): ViewerError {
  // The reader gets a sentence they can act on; the console keeps the real
  // error, which is what a bug report needs and what a musician cannot use.
  console.error("Sheet viewer failed:", err);
  return { unsupported: isMissingBrowserFeature(err) };
}

export type PageInfo = {
  pageNumber: number;
  /** Backing-store size, in device pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** Page size in PDF points - the space timeline bboxes live in. */
  widthPt: number;
  heightPt: number;
};

export function PdfPages({
  pdfData,
  renderOverlay,
  onPageClick,
  containerRef,
}: {
  pdfData: ArrayBuffer;
  /** Drawn inside each page's positioning box, above the canvas. */
  renderOverlay?: (page: PageInfo) => ReactNode;
  onPageClick?: (page: PageInfo, e: React.MouseEvent<HTMLDivElement>) => void;
  containerRef?: RefObject<HTMLDivElement | null>;
}) {
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [error, setError] = useState<ViewerError | null>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  // A pdf.js handle, not something the UI renders - hence a ref, not state.
  const docRef = useRef<PdfDoc | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const doc = await openPdf(pdfData);
        if (cancelled) return;
        docRef.current = doc;

        const infos: PageInfo[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: RENDER_SCALE });
          const view = page.view; // [x0, y0, x1, y1] of the un-rotated page box
          infos.push({
            pageNumber: n,
            pixelWidth: Math.floor(viewport.width),
            pixelHeight: Math.floor(viewport.height),
            widthPt: view[2] - view[0],
            heightPt: view[3] - view[1],
          });
        }
        if (!cancelled) setPages(infos);
      } catch (err) {
        if (!cancelled) setError(describe(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfData]);

  // Second pass: the canvases exist in the DOM now, so rasterize into them.
  useEffect(() => {
    const doc = docRef.current;
    if (!pages.length || !doc) return;

    let cancelled = false;
    const tasks: { cancel: () => void }[] = [];

    (async () => {
      for (const info of pages) {
        if (cancelled) return;
        const canvas = canvasRefs.current.get(info.pageNumber);
        const ctx = canvas?.getContext("2d");
        if (!ctx) continue;
        try {
          const page = await doc.getPage(info.pageNumber);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: RENDER_SCALE });
          const task = page.render({ canvasContext: ctx, viewport });
          tasks.push(task);
          await task.promise;
        } catch (err) {
          // A cancelled render rejects on unmount; that is not a failure.
          if (!cancelled) setError(describe(err));
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
      // Abandoned renders otherwise keep working and holding the canvas.
      tasks.forEach((t) => {
        try {
          t.cancel();
        } catch {
          // already finished
        }
      });
    };
  }, [pages]);

  if (error) {
    // An old browser is worth saying out loud: it is the reader's to fix, and
    // "toHex is not a function" tells them nothing about how.
    if (error.unsupported) {
      return (
        <div className="play-error">
          <strong>This browser is too old to show the sheet.</strong>
          <p>
            The viewer needs features your browser does not have yet. Updating it
            usually fixes this — on an iPhone or iPad that means updating iOS or
            iPadOS itself, since Safari comes with the system. Recent Chrome,
            Edge and Firefox work too.
          </p>
        </div>
      );
    }
    return (
      <p className="play-error">
        Couldn&apos;t show the sheet. Reloading the page usually fixes it.
      </p>
    );
  }
  if (!pages.length) {
    return <p className="play-hint">Loading the sheet…</p>;
  }

  return (
    <div className="sheet-pages" ref={containerRef}>
      {pages.map((page) => (
        <div
          key={page.pageNumber}
          className="sheet-page"
          data-page={page.pageNumber}
          onClick={onPageClick ? (e) => onPageClick(page, e) : undefined}
        >
          <canvas
            width={page.pixelWidth}
            height={page.pixelHeight}
            ref={(el) => {
              if (el) canvasRefs.current.set(page.pageNumber, el);
              else canvasRefs.current.delete(page.pageNumber);
            }}
          />
          {renderOverlay?.(page)}
        </div>
      ))}
    </div>
  );
}
