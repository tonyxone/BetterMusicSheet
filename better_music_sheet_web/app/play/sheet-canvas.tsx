"use client";

// The annotated sheet, rendered to canvas so measures can be clicked.
//
// The existing results page shows the same PDF in an <iframe> using the
// browser's own viewer, which gives no access to page coordinates at all -
// hence pdf.js here, on this page only.
//
// Two passes, deliberately: open the document and lay out one <canvas> per
// page first, then rasterize into those mounted canvases. Rendering into
// detached canvases and handing them to React afterwards fights React over
// the DOM and leaves pdf.js working on an unattached element.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineMeasure, TimelineNote } from "@/lib/timeline";

const RENDER_SCALE = 2; // rasterize above CSS size so the sheet stays sharp

type PageInfo = {
  pageNumber: number;
  /** Backing-store size, in device pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** Page size in PDF points - the space timeline bboxes live in. */
  widthPt: number;
  heightPt: number;
};

type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  view: number[];
  render: (o: Record<string, unknown>) => { promise: Promise<void>; cancel: () => void };
};

type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
};

export function SheetCanvas({
  pdfData,
  measures,
  playingIndex,
  lockedFromIndex,
  notes,
  beat,
  onMeasureClick,
}: {
  pdfData: ArrayBuffer;
  measures: TimelineMeasure[];
  /** Measure sounding right now - follows the playback clock. */
  playingIndex: number | null;
  /** First measure a signed-out visitor can't play, or null when unrestricted.
   * Shown dimmed so the limit is visible before it's hit. */
  lockedFromIndex: number | null;
  /** Every note in the piece - the playhead is placed from the onsets, not
   * from whatever happens to be sounding. */
  notes: TimelineNote[];
  /** Playback position, in beats. */
  beat: number;
  onMeasureClick: (index: number) => void;
}) {
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  // A pdf.js handle, not something the UI renders - hence a ref, not state.
  const docRef = useRef<PdfDoc | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        // Served from the site root, copied out of node_modules at build time
        // by scripts/copy-pdf-worker.mjs. Resolving it through the bundler
        // instead (new URL(..., import.meta.url)) does not emit the asset for
        // a node_modules path, so the worker 404s.
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        // pdf.js takes ownership of the buffer it is given, so hand over a
        // copy - React mounts effects twice in dev and the second pass would
        // otherwise find the original detached.
        const doc = (await pdfjs.getDocument({ data: pdfData.slice(0) }).promise) as unknown as PdfDoc;
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
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
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
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
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

  // Keep the sounding measure on screen. Only reacts when the measure
  // changes, so it never fights the user mid-scroll within one measure.
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (playingIndex === null) return;
    const root = scrollerRef.current;
    const el = root?.querySelector<HTMLElement>(`[data-measure="${playingIndex}"]`);
    if (!root || !el) return;

    // The element that scrolls is an ancestor, not this one - measuring
    // against this container compares the box to the full content height,
    // which is never out of view, so nothing ever scrolled.
    let scroller: HTMLElement | null = root.parentElement;
    while (scroller) {
      const overflow = getComputedStyle(scroller).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    if (!scroller) return;

    const box = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const margin = 12;
    if (box.top < view.top + margin || box.bottom > view.bottom - margin) {
      // Centre it, so the following measures are already visible.
      const delta = box.top - view.top - (view.height - box.height) / 2;
      scroller.scrollBy({ top: delta, behavior: "smooth" });
    }
  }, [playingIndex]);

  /** Every onset in the piece, in time order, with the position the playhead
   * takes while that onset is the most recent one.
   *
   * Built from onsets rather than from what is sounding, which is what an
   * earlier version did: a held note stays in the sounding set long after it
   * was struck, so averaging over that set drags the line backwards every
   * time a shorter note in the other hand releases. An onset, once passed,
   * stays passed - so the line can only advance as the beat does.
   *
   * For notes the backend couldn't match to a notehead, the position is
   * interpolated across the measure - approximate, but it keeps the line
   * moving instead of dropping out. */
  const onsets = useMemo(() => {
    const byMeasure = new Map(measures.map((m) => [m.index, m]));
    // Keyed by start beat, so a chord - and both hands striking together -
    // give one position instead of several. Engravers offset colliding
    // noteheads horizontally, so the mean keeps the line on the group.
    const groups = new Map<number, { page: number; y0: number; y1: number; xs: number[] }>();

    for (const n of notes) {
      const m = byMeasure.get(n.measure_index);
      if (!m?.bbox_pt || m.page === null) continue;
      let x: number;
      if (n.bbox_pt) {
        x = (n.bbox_pt[0] + n.bbox_pt[2]) / 2;
      } else if (m.length_beats > 0) {
        const frac = Math.min(0.96, Math.max(0, (n.start_beat - m.start_beat) / m.length_beats));
        x = m.bbox_pt[0] + frac * (m.bbox_pt[2] - m.bbox_pt[0]);
      } else {
        continue;
      }
      const g = groups.get(n.start_beat);
      if (g) g.xs.push(x);
      else groups.set(n.start_beat, { page: m.page, y0: m.bbox_pt[1], y1: m.bbox_pt[3], xs: [x] });
    }

    return [...groups.entries()]
      .map(([b, g]) => ({
        beat: b,
        page: g.page,
        y0: g.y0,
        y1: g.y1,
        x: g.xs.reduce((a, c) => a + c, 0) / g.xs.length,
      }))
      .sort((a, b) => a.beat - b.beat);
  }, [measures, notes]);

  /** The latest onset at or before the clock. Binary search, because this
   * runs on every frame of playback. */
  const playhead = useMemo(() => {
    let lo = 0;
    let hi = onsets.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (onsets[mid].beat <= beat + 1e-9) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found < 0 ? null : onsets[found];
  }, [onsets, beat]);

  const handleClick = useCallback(
    (page: PageInfo, e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      // Derived from the element's own pixel ratio rather than pdf.js's
      // convertToPdfPoint: that returns the PDF's native bottom-up content
      // space, while the timeline's bbox_pt is top-down (PyMuPDF's
      // convention, from annotate.py). Mixing the two silently flips every
      // hit test vertically.
      const xPt = ((e.clientX - rect.left) / rect.width) * page.widthPt;
      const yPt = ((e.clientY - rect.top) / rect.height) * page.heightPt;

      const hit = measures.find(
        (m) =>
          m.page === page.pageNumber &&
          m.bbox_pt &&
          xPt >= m.bbox_pt[0] &&
          xPt <= m.bbox_pt[2] &&
          yPt >= m.bbox_pt[1] &&
          yPt <= m.bbox_pt[3],
      );
      if (hit) onMeasureClick(hit.index);
    },
    [measures, onMeasureClick],
  );

  if (error) {
    return <p className="play-error">Couldn&apos;t render the sheet ({error}).</p>;
  }
  if (!pages.length) {
    return <p className="play-hint">Loading the sheet…</p>;
  }

  return (
    <div className="sheet-pages" ref={scrollerRef}>
      {pages.map((page) => (
        <div key={page.pageNumber} className="sheet-page" onClick={(e) => handleClick(page, e)}>
          <canvas
            width={page.pixelWidth}
            height={page.pixelHeight}
            ref={(el) => {
              if (el) canvasRefs.current.set(page.pageNumber, el);
              else canvasRefs.current.delete(page.pageNumber);
            }}
          />
          {/* Overlays are positioned as percentages of the page box, so they
              stay aligned at any rendered size without re-rastering. */}
          {measures
            .filter((m) => m.page === page.pageNumber && m.bbox_pt)
            .map((m) => {
              const [x0, y0, x1, y1] = m.bbox_pt!;
              return (
                <span
                  key={m.index}
                  className={
                    "measure-box" +
                    (lockedFromIndex !== null && m.index >= lockedFromIndex ? " locked" : "") +
                    (m.index === playingIndex ? " playing" : "")
                  }
                  data-measure={m.index}
                  style={{
                    left: `${(x0 / page.widthPt) * 100}%`,
                    top: `${(y0 / page.heightPt) * 100}%`,
                    width: `${((x1 - x0) / page.widthPt) * 100}%`,
                    height: `${((y1 - y0) / page.heightPt) * 100}%`,
                  }}
                />
              );
            })}
          {playhead && playhead.page === page.pageNumber && (
            <span
              className="playhead"
              style={{
                left: `${(playhead.x / page.widthPt) * 100}%`,
                top: `${(playhead.y0 / page.heightPt) * 100}%`,
                height: `${((playhead.y1 - playhead.y0) / page.heightPt) * 100}%`,
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export default SheetCanvas;
