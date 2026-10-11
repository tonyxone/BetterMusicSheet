"use client";

// The sheet preview, with the reader's own changes on top and the tools to
// make them: move or retype note names (retyping one fixes what plays too),
// draw, highlight, add text notes - one item at a time or a selected group.
// Changes save as they are made (see lib/edits.ts) and come back on the
// next visit.
//
// The note names are drawn from data over the ORIGINAL upload, rather than
// shown baked into the annotated PDF, which is what makes them editable.
// When a sheet can't be shown that way - no stored original, or a photo
// upload - the annotated PDF is shown instead, and only marks and notes can
// be added on top of it.
//
// The Original view shows the same upload without the names; the reader's
// own marks and notes stay, and can be edited there too.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import { fetchSheetAssets, fetchSheetFile } from "@/lib/sheet-files";
import { photoAsPdf } from "@/lib/photo-pages";
import { loadLabels, stillUnnamed, type LabelItem, type LabelSet } from "@/lib/labels";
import { correctionsForRetype, EMPTY_EDITS, isEmptyEdits, resolveLabel, useSheetEdits, type LabelEdit, type SaveState, type SheetEdits } from "@/lib/edits";
import { fromNumbered, fromSolfege, useNotation } from "@/lib/notation";
import { usePreference, type Preferences } from "@/lib/preferences";
import type { Timeline } from "@/lib/timeline";
import type { SheetVariant } from "../sheet-toggle";
import { NotationToggle } from "../notation-toggle";
import { PdfPages, type PageInfo } from "./pdf-pages";
import { AnnotationLayer, itemKey, moveItems, unnamedKey, type EditorHooks, type InlineTarget, type SelectedItem, type Tool } from "./annotation-layer";
import { useI18n } from "@/lib/i18n/client";
import { fmt, plural, rich } from "@/lib/i18n/format";

const PEN_COLORS = ["#2e2117", "#c0392b", "#1f5fbf", "#2f7d32"];
const HIGHLIGHT_COLORS = ["#ffd84d", "#8ee07a", "#ff9ec7", "#7cc8ff"];

// 100% fits the page to the preview's width (up to 900px, as before).
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const ZOOM_KEY = "bms_sheet_zoom";

/** Builds the Customized PDF from what the preview shows right now. */
export type CustomizedExport = () => Promise<Blob>;

type Loaded = {
  original: ArrayBuffer | null;
  annotated: ArrayBuffer | null;
  timeline: Timeline | null;
  labels: LabelSet | null;
};

async function fetchBytes(jobId: string, kind: "pdf" | "original") {
  const res = await fetchSheetFile(jobId, kind);
  if (!res.ok) throw new Error(`${kind} request failed (${res.status})`);
  return res.arrayBuffer();
}

function isPdf(buffer: ArrayBuffer) {
  return new TextDecoder().decode(new Uint8Array(buffer.slice(0, 5))) === "%PDF-";
}

function withLabelEdit(labels: Record<string, LabelEdit>, id: string, edit: LabelEdit) {
  const next = { ...labels };
  if (Object.keys(edit).length) next[id] = edit;
  else delete next[id];
  return next;
}

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Show ``el`` dragged ``mx`` sideways - only a little past the first and
 * last page - and return how far it moved. */
function dragPage(el: HTMLElement | null, mx: number, atFirst: boolean, atLast: boolean) {
  const dx = (mx > 0 && atFirst) || (mx < 0 && atLast) ? mx / 4 : mx;
  if (el) {
    el.style.transition = "none";
    el.style.transform = `translateX(${dx}px)`;
  }
  return dx;
}

/** Spring a dragged page back to where it was. */
function settlePage(el: HTMLElement | null) {
  if (!el || !el.style.transform) return;
  el.style.transition = "transform 0.2s ease-out";
  el.style.transform = "";
  el.addEventListener("transitionend", () => { el.style.transition = ""; }, { once: true });
}

/** Turn from a page shown dragged: it snaps home as the next one comes. */
function turnFrom(el: HTMLElement | null, turn: () => void) {
  if (el) {
    el.style.transition = "";
    el.style.transform = "";
  }
  turn();
}

/** Let go of a page dragged ``dx`` over ``ms``: a quick flick or a pull
 * across a good part of the ``width`` turns to page ``target``, if there is
 * one; anything less springs back. */
function releaseDrag(el: HTMLElement | null, dx: number, ms: number, width: number,
  target: number, count: number, goTo: (page: number) => void) {
  const fast = Math.abs(dx) / Math.max(1, ms) > 0.3 && Math.abs(dx) > 25;
  if (target >= 1 && target <= count && (fast || Math.abs(dx) > width * 0.18)) turnFrom(el, () => goTo(target));
  else settlePage(el);
}

function savedZoom() {
  try {
    const z = Number(localStorage.getItem(ZOOM_KEY));
    return z >= MIN_ZOOM && z <= MAX_ZOOM ? z : 1;
  } catch {
    return 1;
  }
}

export function SheetEditor({ jobId, variant, exportRef, variantToggle, fullWindow = false, onFullWindow }: {
  jobId: string;
  variant: SheetVariant;
  /** Filled in once the sheet has loaded, for the page's Download menu. */
  exportRef?: MutableRefObject<CustomizedExport | null>;
  /** The page's Annotated/Original switch, shown beside the Letter/簡 one:
   * both choose how this sheet is drawn. */
  variantToggle?: ReactNode;
  /** The preview fills the window (the page around it owns that state). */
  fullWindow?: boolean;
  onFullWindow?: (on: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { m, locale } = useI18n();
  const t = m.editor;
  const edits = useSheetEdits(jobId, t);
  const saveText: Record<SaveState, string> = {
    saved: t.save.saved, saving: t.save.saving, unsaved: t.save.saving, offline: t.save.offline, error: t.save.error,
  };
  const { doc, update, undo, redo, current } = edits;

  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [penColor, setPenColor] = useState(PEN_COLORS[1]);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [selection, setSelection] = useState<SelectedItem[]>([]);
  const [inline, setInline] = useState<InlineTarget | null>(null);
  // Mirrors `inline`, so the box closing twice (Enter, then the blur its
  // removal can cause) only applies once.
  const inlineRef = useRef<InlineTarget | null>(null);
  const inlineBefore = useRef<SheetEdits | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  // On a narrow box the view controls fold into a "..." menu (globals.css).
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // A reset can wipe a lot at once, so it offers its own undo, in or out of
  // edit mode.
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  // Only the pages scroll and zoom; the toolbar above them stays put.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(savedZoom);
  const zoomRef = useRef(zoom);
  // The page is re-rasterized for a new zoom only once zooming pauses; until
  // then the current pixels are stretched, which is cheap.
  const [renderZoom, setRenderZoom] = useState(zoom);
  const zoomAnchor = useRef<{ cx: number; cy: number; left: number; top: number; ratio: number } | null>(null);
  // Dragging the sheet around with the mouse, like a hand tool. Outside edit
  // mode a plain drag pans; in edit mode a drag draws or selects, so there
  // it takes the space bar held down, or the middle button.
  // In swipe mode a mostly sideways drag drags the page instead ("page"),
  // decided once the pointer has moved a little ("undecided").
  const panStart = useRef<{
    x: number; y: number; left: number; top: number; t: number;
    mode: "pan" | "undecided" | "page"; dx: number;
  } | null>(null);
  const [panning, setPanning] = useState(false);
  // Scroll down through every page, or show one at a time and swipe across:
  // the reader's setting, kept with their account (lib/preferences.ts).
  const [pageMode, setPageMode] = usePreference("page_mode", "scroll");
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  // Which way the last page turn went, for the slide-in; 0 for none.
  const turnDir = useRef(0);
  const [spaceHeld, setSpaceHeld] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const assets = await fetchSheetAssets(jobId).catch(() => null);
        const originalIsPdf = !!assets?.original && (!assets.original_type || assets.original_type === "application/pdf");
        // No annotated copy yet (names still being added, or that failed):
        // the API says so with a null, and asking anyway only logs a 404.
        const noNames = !!assets && assets.pdf === null;
        // A photo whose names aren't there - still being added, or that failed
        // - is shown as the page the worker reads it as, so it can still be
        // read, marked up and downloaded like any other sheet.
        const photo = noNames && !!assets?.original && !!assets.original_type?.startsWith("image/");
        const [annotated, original, timeline] = await Promise.all([
          noNames ? Promise.resolve(null) : fetchBytes(jobId, "pdf").catch((err) => { console.error(err); return null; }),
          originalIsPdf ? fetchBytes(jobId, "original").then((b) => (isPdf(b) ? b : null)).catch(() => null)
            : photo ? fetchBytes(jobId, "original").then((b) => photoAsPdf(b, assets!.original_type!))
              .catch((err) => { console.error(err); return null; })
            : Promise.resolve(null),
          fetchSheetFile(jobId, "timeline").then((r) => (r.ok ? r.json() as Promise<Timeline> : null)).catch(() => null),
        ]);
        if (!annotated && !original) throw new Error("no PDF to show");
        // Without the original there is nothing clean to draw the names over.
        const labels = original ? await loadLabels(jobId, annotated, timeline) : null;
        if (!cancelled) setLoaded({ original, annotated, timeline, labels });
      } catch (err) {
        console.error("Loading the sheet preview failed:", err);
        if (!cancelled) setLoadError(t.previewFailed);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the message is read once, when loading fails
  }, [jobId]);

  const labelsLive = !!loaded?.labels && !!loaded.original;
  const showNames = labelsLive && variant === "annotated";
  const base = variant === "original"
    ? loaded?.original ?? null
    : labelsLive ? loaded!.original : loaded?.annotated ?? null;

  const labelsByPage = useMemo(() => {
    const map = new Map<number, LabelItem[]>();
    for (const item of loaded?.labels?.items ?? []) {
      const list = map.get(item.page) ?? [];
      list.push(item);
      map.set(item.page, list);
    }
    return map;
  }, [loaded]);
  const labelsById = useMemo(() => new Map((loaded?.labels?.items ?? []).map((l) => [l.id, l])), [loaded]);
  const [notation, setNotation] = useNotation(loaded?.labels?.notation);

  // Printed notes recognition missed, so they have no name (unnamed_notes.py),
  // less those the reader has named since - in page order, top to bottom.
  const unnamed = useMemo(() => stillUnnamed(showNames ? loaded?.labels?.unnamed ?? [] : [], doc?.texts ?? [])
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x), [showNames, loaded, doc]);
  const [focusedUnnamed, setFocusedUnnamed] = useState<string | null>(null);
  // Set by "Show next" and cleared once that note is scrolled to: one page
  // at a time, its page has to be showing first.
  const unnamedJump = useRef<string | null>(null);
  const showNextUnnamed = useCallback(() => {
    if (!unnamed.length) return;
    const at = unnamed.findIndex((u) => unnamedKey(u) === focusedUnnamed);
    const target = unnamed[(at + 1) % unnamed.length];
    const next = unnamedKey(target);
    unnamedJump.current = next;
    setFocusedUnnamed(next);
    setPage(target.page);
  }, [unnamed, focusedUnnamed]);

  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = loaded ? async () => {
      const { exportCustomizedPdf } = await import("@/lib/export-pdf");
      // What the preview shows: the names over the original, the original
      // alone, or the annotated copy when the names can't be drawn.
      const exportBase = variant === "original" || labelsLive ? loaded.original! : loaded.annotated ?? loaded.original!;
      return exportCustomizedPdf({ base: exportBase, labels: showNames ? loaded.labels : null, edits: current() ?? EMPTY_EDITS,
        notation });
    } : null;
    return () => { exportRef.current = null; };
  }, [exportRef, loaded, labelsLive, showNames, variant, current, notation]);

  function stopEditing() {
    setEditing(false);
    setSelection([]);
    setInline(null);
    inlineRef.current = null;
  }

  // Names aren't on the Original view, so they can't stay selected there.
  const visibleSelection = useMemo(
    () => (showNames ? selection : selection.filter((s) => s.kind !== "label")),
    [selection, showNames],
  );

  // ---- zoom ------------------------------------------------------------------

  /** Zoom to ``next``, keeping the point under ``at`` (a client position,
   * default the middle of the preview) where it is on screen. */
  const zoomTo = useCallback((next: number, at?: { x: number; y: number }) => {
    const z = clampZoom(Math.round(next * 100) / 100);
    const old = zoomRef.current;
    if (z === old) return;
    const scroller = scrollRef.current;
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      zoomAnchor.current = {
        cx: at ? at.x - r.left : scroller.clientWidth / 2,
        cy: at ? at.y - r.top : scroller.clientHeight / 2,
        left: scroller.scrollLeft, top: scroller.scrollTop, ratio: z / old,
      };
    }
    zoomRef.current = z;
    setZoom(z);
    try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* optional */ }
  }, []);

  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const scroller = scrollRef.current;
    zoomAnchor.current = null;
    if (!anchor || !scroller) return;
    scroller.scrollLeft = (anchor.left + anchor.cx) * anchor.ratio - anchor.cx;
    scroller.scrollTop = (anchor.top + anchor.cy) * anchor.ratio - anchor.cy;
  }, [zoom]);

  useEffect(() => {
    const t = setTimeout(() => setRenderZoom(zoom), 250);
    return () => clearTimeout(t);
  }, [zoom]);

  // Whether the scrolling area is on the page - it waits for the sheet and
  // the reader's edits both.
  const sheetShown = !!(loaded && doc && base);

  // Ctrl + wheel (and a trackpad pinch, which browsers report the same way)
  // zooms the sheet around the pointer instead of the whole page.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
    }
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [sheetShown, zoomTo]);

  function onPanStart(e: React.PointerEvent<HTMLDivElement>) {
    // Touch and pens already scroll natively (outside edit mode) and draw
    // inside it; this is for the mouse.
    if (e.pointerType !== "mouse") return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, button")) return;
    const wanted = e.button === 1 || (e.button === 0 && (!editing || spaceHeld));
    if (!wanted) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    // Captured before the annotation layer sees it, so a space-drag in edit
    // mode pans instead of drawing or selecting.
    e.preventDefault();
    e.stopPropagation();
    panStart.current = {
      x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, t: e.timeStamp,
      mode: swiping && e.button === 0 && !editing ? "undecided" : "pan", dx: 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setPanning(true);
  }

  function onPanMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = panStart.current;
    const scroller = start && scrollRef.current;
    if (!start || !scroller) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (start.mode === "undecided") {
      if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
      const room = sidewaysRoom(scroller);
      const canPan = room > 1 && (mx > 0 ? start.left > 1 : start.left < room - 1);
      start.mode = Math.abs(mx) >= Math.abs(my) && !canPan ? "page" : "pan";
    }
    if (start.mode === "page") {
      start.dx = dragShownPage(mx);
      return;
    }
    scroller.scrollLeft = start.left - mx;
    scroller.scrollTop = start.top - my;
  }

  function onPanEnd(e: React.PointerEvent<HTMLDivElement>) {
    const start = panStart.current;
    if (!start) return;
    panStart.current = null;
    setPanning(false);
    if (start.mode !== "page") return;
    if (e.type === "pointercancel") settleShownPage();
    else releasePage(start.dx, e.timeStamp - start.t);
  }

  // Space held while editing turns the pointer into a hand for as long as it
  // is down - and doesn't scroll the page the way a space press would.
  useEffect(() => {
    if (!editing) return;
    function typing(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    }
    function down(e: KeyboardEvent) {
      if (e.code !== "Space" || typing(e)) return;
      e.preventDefault();
      setSpaceHeld(true);
    }
    function up(e: KeyboardEvent) {
      if (e.code === "Space") setSpaceHeld(false);
    }
    const release = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, [editing]);

  // ---- pages -----------------------------------------------------------------

  const swiping = pageMode === "swipe" && pageCount > 1;
  const shownPage = Math.min(Math.max(1, page), Math.max(1, pageCount));
  const pageRef = useRef(shownPage);
  const countRef = useRef(pageCount);
  useEffect(() => {
    pageRef.current = shownPage;
    countRef.current = pageCount;
  }, [shownPage, pageCount]);

  /** How far the sheet pans sideways. Only a zoomed-in page counts: names
   * drawn just past a page's edge widen the box a little too, and that must
   * not stop a swipe from turning the page. */
  const sidewaysRoom = (box: HTMLElement) => (zoomRef.current > 1 ? box.scrollWidth - box.clientWidth : 0);

  const goToPage = useCallback((n: number) => {
    const next = Math.min(Math.max(1, n), countRef.current);
    if (next === pageRef.current) return;
    turnDir.current = next > pageRef.current ? 1 : -1;
    setPage(next);
  }, []);

  // Dragging the page sideways, by finger or mouse: it follows the drag and
  // turns once let go far or fast enough (see dragPage, below).
  const shownPageEl = () =>
    scrollRef.current?.querySelector<HTMLElement>(`.sheet-page[data-page="${pageRef.current}"]`) ?? null;
  const dragShownPage = (mx: number) =>
    dragPage(shownPageEl(), mx, pageRef.current <= 1, pageRef.current >= countRef.current);
  const settleShownPage = () => settlePage(shownPageEl());
  const releasePage = (dx: number, ms: number) => releaseDrag(shownPageEl(), dx, ms,
    scrollRef.current?.clientWidth ?? 0, pageRef.current + (dx < 0 ? 1 : -1), countRef.current, goToPage);

  function changePageMode(next: Preferences["page_mode"]) {
    if (next === pageMode) return;
    const scroller = scrollRef.current;
    if (next === "swipe" && scroller) {
      // Open on the page that was being read: the first one still showing
      // below the top third of the box.
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      const pages = [...scroller.querySelectorAll<HTMLElement>(".sheet-page")];
      const reading = pages.find((el) => el.getBoundingClientRect().bottom > line);
      if (reading) setPage(Number(reading.dataset.page));
    }
    turnDir.current = 0;
    setPageMode(next);
    setMoreOpen(false);
  }

  // A new page starts at its top, sliding in from the side it was swiped
  // from; back to scrolling, the box lands on the page that was showing.
  const wasSwiping = useRef(swiping);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const el = scroller?.querySelector<HTMLElement>(`.sheet-page[data-page="${shownPage}"]`);
    const modeChanged = wasSwiping.current !== swiping;
    wasSwiping.current = swiping;
    if (!scroller || !el) return;
    if (swiping) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      const dir = turnDir.current;
      turnDir.current = 0;
      if (dir && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        el.animate([{ transform: `translateX(${dir * 30}%)`, opacity: 0.2 }, { transform: "none", opacity: 1 }],
          { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
      }
    } else if (modeChanged) {
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
    }
  }, [shownPage, swiping]);

  // "Show next": centred in the sheet's own box, once its page is showing.
  // scrollIntoView would scroll the page too, tucking the toolbar under the
  // site header.
  useEffect(() => {
    const key = unnamedJump.current;
    const box = scrollRef.current;
    if (!key || !box) return;
    unnamedJump.current = null;
    const ring = box.querySelector(`[data-unnamed="${CSS.escape(key)}"]`);
    if (!ring) return;
    const r = ring.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    box.scrollTo({
      top: box.scrollTop + r.top + r.height / 2 - (b.top + b.height / 2),
      left: box.scrollLeft + r.left + r.width / 2 - (b.left + b.width / 2),
      behavior: "smooth",
    });
  }, [focusedUnnamed, shownPage]);

  // The arrow keys turn pages, unless they are moving a selection or a
  // caret.
  useEffect(() => {
    if (!swiping) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (editing && visibleSelection.length) return;
      e.preventDefault();
      goToPage(pageRef.current + (e.key === "ArrowRight" ? 1 : -1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [swiping, editing, visibleSelection, goToPage]);

  // Made for a quick flick at the piano: a finger swiped sideways drags the
  // page (see dragPage), and a rough flick the browser first took for a
  // scroll still turns it. Zoomed in, the sheet
  // pans sideways itself until it reaches an edge. In edit mode a finger
  // draws, so the pager turns pages.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !swiping || editing) return;
    const box = scroller;
    let start: { x: number; y: number; t: number } | null = null;
    // "drag": the page follows the finger; "pass": the browser scrolls, and
    // only the whole gesture is judged once it ends.
    let mode: "undecided" | "drag" | "pass" = "undecided";
    let dx = 0;
    const el = () => box.querySelector<HTMLElement>(`.sheet-page[data-page="${pageRef.current}"]`);
    function onStart(e: TouchEvent) {
      if (e.touches.length !== 1) {
        start = null;
        settlePage(el());
        return;
      }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp };
      mode = "undecided";
      dx = 0;
    }
    function onMove(e: TouchEvent) {
      if (!start) return;
      if (e.touches.length !== 1) {
        start = null;
        settlePage(el());
        return;
      }
      const mx = e.touches[0].clientX - start.x;
      const my = e.touches[0].clientY - start.y;
      if (mode === "undecided") {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        const room = sidewaysRoom(box);
        const canPan = room > 1 && (mx > 0 ? box.scrollLeft > 1 : box.scrollLeft < room - 1);
        mode = Math.abs(mx) >= Math.abs(my) && !canPan ? "drag" : "pass";
      }
      if (mode !== "drag") return;
      if (e.cancelable) e.preventDefault();
      dx = dragPage(el(), mx, pageRef.current <= 1, pageRef.current >= countRef.current);
    }
    function onEnd(e: TouchEvent) {
      if (!start) return;
      const from = start;
      start = null;
      const touch = e.changedTouches[0];
      const mx = touch ? touch.clientX - from.x : dx;
      const my = touch ? touch.clientY - from.y : 0;
      const ms = Math.max(1, e.timeStamp - from.t);
      const target = pageRef.current + (mx < 0 ? 1 : -1);
      if (mode === "drag") {
        releaseDrag(el(), dx, ms, box.clientWidth, pageRef.current + (dx < 0 ? 1 : -1), countRef.current, goToPage);
      } else if (mode === "pass" && target >= 1 && target <= countRef.current && sidewaysRoom(box) <= 1
        && ms < 400 && Math.abs(mx) > 50 && Math.abs(mx) > Math.abs(my) * 1.5) {
        turnFrom(el(), () => goToPage(target));
      }
    }
    function onCancel() {
      start = null;
      settlePage(el());
    }
    box.addEventListener("touchstart", onStart, { passive: true });
    box.addEventListener("touchmove", onMove, { passive: false });
    box.addEventListener("touchend", onEnd);
    box.addEventListener("touchcancel", onCancel);
    return () => {
      box.removeEventListener("touchstart", onStart);
      box.removeEventListener("touchmove", onMove);
      box.removeEventListener("touchend", onEnd);
      box.removeEventListener("touchcancel", onCancel);
    };
  }, [swiping, editing, goToPage, sheetShown]);

  // A trackpad's two-finger swipe turns the page too, once per gesture: the
  // momentum that follows doesn't turn it again.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !swiping) return;
    const box = scroller;
    let sum = 0;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let spent = false;
    function onWheel(e: WheelEvent) {
      if (e.ctrlKey || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      const room = sidewaysRoom(box);
      if (room > 1 && (e.deltaX > 0 ? box.scrollLeft < room - 1 : box.scrollLeft > 1)) return;
      e.preventDefault();
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { sum = 0; spent = false; }, 250);
      if (spent) return;
      sum += e.deltaX;
      if (Math.abs(sum) > 60) {
        spent = true;
        goToPage(pageRef.current + (sum > 0 ? 1 : -1));
      }
    }
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      box.removeEventListener("wheel", onWheel);
      clearTimeout(quietTimer);
    };
  }, [swiping, goToPage, sheetShown]);

  const stepZoom = (direction: 1 | -1) => {
    const z = zoomRef.current;
    const next = direction > 0
      ? ZOOM_STEPS.find((s) => s > z + 0.001) ?? MAX_ZOOM
      : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? MIN_ZOOM;
    zoomTo(next);
  };

  // ---- edits that need more than one field ---------------------------------

  const retypeLabel = useCallback((id: string, raw: string) => {
    const item = labelsById.get(id);
    const now = current();
    if (!item || !now) return;
    // A number or solfège syllable typed while names read that way is stored
    // as the letter it means, like every other name.
    const typed = raw.trim();
    const reparsed = notation === "numbers" ? fromNumbered(typed, item.text)
      : notation === "solfege" ? fromSolfege(typed, item.text) : null;
    const text = reparsed ?? typed;
    const edit: LabelEdit = { ...(now.labels[id] ?? {}) };
    if (!text) {
      update((d) => ({ ...d, labels: withLabelEdit(d.labels, id, { ...edit, hidden: true }) }));
      edits.setNotice(t.nameHidden);
      return;
    }
    if (text === (edit.text ?? item.text)) return;
    if (text === item.text) delete edit.text;
    else edit.text = text;
    let corrections = now.corrections;
    let message: string;
    if (!loaded?.timeline) {
      message = t.noPlayback;
    } else {
      const result = correctionsForRetype(item, text, loaded.timeline, now.corrections);
      if (result === null) message = fmt(t.notANoteName, { text });
      else if (!result.linked) message = t.notLinked;
      else {
        corrections = result.corrections;
        message = text === item.text
          ? t.restored
          : fmt(result.changed > 1 ? t.nowPlaysMany : t.nowPlays, { text: typed, count: result.changed });
      }
    }
    update((d) => ({ ...d, labels: withLabelEdit(d.labels, id, edit), corrections }));
    edits.setNotice(message);
  }, [labelsById, current, update, loaded, edits, notation, t]);

  /** Names back where and as they were printed, with their playback. */
  const resetLabels = useCallback((ids: string[]) => {
    const now = current();
    if (!now) return;
    let corrections = now.corrections;
    for (const id of ids) {
      const item = labelsById.get(id);
      if (item && loaded?.timeline) {
        corrections = correctionsForRetype(item, item.text, loaded.timeline, corrections)?.corrections ?? corrections;
      }
    }
    update((d) => {
      let labels = d.labels;
      for (const id of ids) labels = withLabelEdit(labels, id, {});
      return { ...d, labels, corrections };
    });
  }, [labelsById, current, update, loaded]);

  const deleteSelection = useCallback(() => {
    if (!visibleSelection.length) return;
    const keys = new Set(visibleSelection.map(itemKey));
    update((d) => {
      let labels = d.labels;
      for (const s of visibleSelection) {
        if (s.kind === "label") labels = withLabelEdit(labels, s.id, { ...(labels[s.id] ?? {}), hidden: true });
      }
      return {
        ...d, labels,
        texts: d.texts.filter((t) => !keys.has(`text:${t.id}`)),
        strokes: d.strokes.filter((s) => !keys.has(`stroke:${s.id}`)),
      };
    });
    setSelection([]);
  }, [visibleSelection, update]);

  const nudge = useCallback((dx: number, dy: number) => {
    if (!visibleSelection.length) return;
    update((d) => moveItems(d, visibleSelection, dx, dy));
  }, [visibleSelection, update]);

  const pxPerPtOf = (pageNumber: number) => {
    const svg = document.querySelector<SVGSVGElement>(`.sheet-page[data-page="${pageNumber}"] svg.annotation-layer`);
    return svg ? svg.getBoundingClientRect().width / svg.viewBox.baseVal.width : null;
  };

  const openInline = useCallback((target: InlineTarget) => {
    // A new text note exists only transiently until it has text; remember
    // the document without it, so keeping it records one undo step.
    const now = current();
    inlineBefore.current = target.isNew && now
      ? { ...now, texts: now.texts.filter((t) => t.id !== target.id) } : null;
    inlineRef.current = target;
    setInline(target);
  }, [current]);

  const openInlineFor = useCallback((item: SelectedItem) => {
    if (item.kind === "stroke") return;
    const page = item.kind === "label" ? labelsById.get(item.id)?.page : current()?.texts.find((t) => t.id === item.id)?.page;
    const pxPerPt = page ? pxPerPtOf(page) : null;
    if (page && pxPerPt) openInline({ kind: item.kind, id: item.id, page, pxPerPt });
  }, [labelsById, current, openInline]);

  const closeInline = useCallback((value: string | null) => {
    const target = inlineRef.current;
    inlineRef.current = null;
    setInline(null);
    if (!target) return;
    if (target.kind === "label") {
      if (value !== null) retypeLabel(target.id, value);
      return;
    }
    const before = inlineBefore.current;
    inlineBefore.current = null;
    const text = value?.replace(/\s+$/, "") ?? null;
    if (target.isNew) {
      if (!text) {
        update((d) => ({ ...d, texts: d.texts.filter((t) => t.id !== target.id) }), { transient: true });
        setSelection([]);
      } else {
        update((d) => ({ ...d, texts: d.texts.map((t) => t.id === target.id ? { ...t, text } : t) }), before ? { before } : {});
      }
      return;
    }
    if (text === null) return;
    if (!text) update((d) => ({ ...d, texts: d.texts.filter((t) => t.id !== target.id) }));
    else update((d) => ({ ...d, texts: d.texts.map((t) => t.id === target.id ? { ...t, text } : t) }));
  }, [retypeLabel, update]);

  const reset = useCallback((scope: "names" | "all") => {
    setResetOpen(false);
    update((d) => (scope === "all" ? EMPTY_EDITS : { ...d, labels: {}, corrections: {} }));
    setSelection([]);
    const message = scope === "all" ? t.resetAll : t.resetNames;
    setResetNotice(message);
    edits.setNotice(message);
  }, [update, edits, t]);

  // ---- keyboard --------------------------------------------------------------

  useEffect(() => {
    if (!editing) return;
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (!visibleSelection.length) {
        if (e.key === "Escape") setTool("select");
        return;
      }
      const step = e.shiftKey ? 2 : 0.5;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      if (moves[e.key]) {
        e.preventDefault();
        nudge(...moves[e.key]);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === "Escape") {
        setSelection([]);
      } else if (e.key === "Enter" && visibleSelection.length === 1) {
        e.preventDefault();
        openInlineFor(visibleSelection[0]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, visibleSelection, undo, redo, nudge, deleteSelection, openInlineFor]);

  useEffect(() => {
    if (!moreOpen) return;
    function onDown(e: PointerEvent) {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  // Esc leaves the full window, unless something smaller is open to close
  // first, or edit mode is using Esc itself.
  useEffect(() => {
    if (!fullWindow || !onFullWindow || editing || moreOpen || resetOpen || inline) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onFullWindow!(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullWindow, onFullWindow, editing, moreOpen, resetOpen, inline]);

  // ---- rendering -------------------------------------------------------------

  if (loadError) {
    return <p style={{ color: "var(--danger)", textAlign: "center", padding: 24 }}>{loadError}</p>;
  }
  if (!loaded || !doc) {
    if (edits.loadError) return <p style={{ color: "var(--danger)", textAlign: "center", padding: 24 }}>{edits.loadError}</p>;
    return <p className="play-hint" style={{ padding: 24 }}>{m.common.loadingSheet}</p>;
  }
  if (!base) {
    // The switch stays, so the reader can go back to the copy that works.
    return (
      <div style={{ textAlign: "center", padding: 24 }}>
        {variantToggle}
        <p style={{ color: "var(--danger)", marginTop: 12 }}>{t.uploadFailed}</p>
      </div>
    );
  }

  const hooks: EditorHooks | undefined = editing ? {
    tool, penColor, highlightColor, textColor: penColor, selection: visibleSelection, select: setSelection,
    update, current, inline, openInline,
  } : undefined;
  const labelColor = loaded.labels?.color ?? "#000000";
  const nameSize = loaded.labels?.items[0]?.size ?? 6.5;
  const single = visibleSelection.length === 1 ? visibleSelection[0] : null;
  const selectedLabel = single?.kind === "label" ? labelsById.get(single.id) : undefined;
  const selectedResolved = selectedLabel ? resolveLabel(selectedLabel, doc, notation) : null;
  const chord = selectedLabel ? labelsByPage.get(selectedLabel.page)?.filter((l) => l.group === selectedLabel.group) ?? [] : [];
  const selectedLabelIds = visibleSelection.filter((s) => s.kind === "label").map((s) => s.id);
  const hasNameChanges = Object.keys(doc.labels).length > 0 || Object.keys(doc.corrections).length > 0;
  const hasMarks = doc.texts.length > 0 || doc.strokes.length > 0;

  function renderInline(page: PageInfo) {
    if (!inline || inline.page !== page.pageNumber || !doc) return null;
    if (inline.kind === "label") {
      const item = labelsById.get(inline.id);
      const l = item && resolveLabel(item, doc, notation);
      if (!l) return null;
      const fontPx = Math.max(14, l.size * inline.pxPerPt);
      return (
        <input
          key={inline.id}
          className="sheet-inline-input"
          defaultValue={l.text}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          aria-label={t.noteName}
          style={{
            left: `${(l.x / page.widthPt) * 100}%`, top: `${(l.y / page.heightPt) * 100}%`,
            fontSize: fontPx, transform: "translate(-50%, -85%)", width: `${Math.max(4, l.text.length + 2)}em`,
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") closeInline(e.currentTarget.value);
            else if (e.key === "Escape") closeInline(null);
          }}
          onBlur={(e) => closeInline(e.currentTarget.value)}
        />
      );
    }
    const note = doc.texts.find((t) => t.id === inline.id);
    if (!note) return null;
    const fontPx = Math.max(13, note.size * inline.pxPerPt);
    return (
      <textarea
        key={inline.id}
        className="sheet-inline-input"
        defaultValue={note.text}
        autoFocus
        rows={Math.max(1, note.text.split("\n").length)}
        placeholder={t.typeANote}
        aria-label={t.textNote}
        style={{
          left: `${(note.x / page.widthPt) * 100}%`, top: `${((note.y - note.size) / page.heightPt) * 100}%`,
          fontSize: fontPx, color: note.color, minWidth: "10em",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            closeInline(e.currentTarget.value);
          } else if (e.key === "Escape") {
            closeInline(note.text ? null : "");
          }
        }}
        onInput={(e) => { e.currentTarget.rows = Math.max(1, e.currentTarget.value.split("\n").length); }}
        onBlur={(e) => closeInline(e.currentTarget.value)}
      />
    );
  }

  const tools: { id: Tool; label: string; title: string; icon: React.ReactNode }[] = [
    { id: "select", label: t.tools.select, title: t.tools.selectTitle, icon: <path d="M5 3l14 8-6 1.5L10 19z" /> },
    { id: "pen", label: t.tools.pen, title: t.tools.penTitle, icon: <path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3" /> },
    { id: "highlighter", label: t.tools.highlighter, title: t.tools.highlighterTitle, icon: <path d="M4 20h6M7 17l-2-2 9-9 4 4-9 9zM12 8l4 4" /> },
    { id: "text", label: t.tools.text, title: t.tools.textTitle, icon: <path d="M5 5h14M12 5v14M9 19h6" /> },
    { id: "eraser", label: t.tools.eraser, title: t.tools.eraserTitle, icon: <path d="M8 20h12M5 15l8-9 6 6-7 8H9z" /> },
  ];

  const zoomControls = (
    <div className="zoom-controls" role="group" aria-label={t.zoom}>
      <button type="button" className="editor-btn icon" onClick={() => stepZoom(-1)} disabled={zoom <= MIN_ZOOM}
        title={t.zoomOutTitle} aria-label={t.zoomOut}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
      <button type="button" className="editor-btn zoom-level" onClick={() => zoomTo(1)}
        title={fullWindow ? t.fitPage : t.fitWidth}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className="editor-btn icon" onClick={() => stepZoom(1)} disabled={zoom >= MAX_ZOOM}
        title={t.zoomInTitle} aria-label={t.zoomIn}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14" /></svg>
      </button>
    </div>
  );

  const resetControl = (
    <div className="reset-menu">
      <button type="button" className="editor-btn" disabled={isEmptyEdits(doc)} aria-haspopup="menu" aria-expanded={resetOpen}
        title={t.resetTitle} onClick={() => setResetOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v6h6M4.5 10A8 8 0 1 1 6 17" /></svg>
        <span>{t.reset}</span>
      </button>
      {resetOpen && (
        <div className="download-menu-list reset-menu-list" role="menu">
          <button type="button" role="menuitem" disabled={!hasNameChanges} onClick={() => reset("names")}>
            {t.resetNamesOnly}
            <small>{t.resetNamesOnlyDetail}</small>
          </button>
          <button type="button" role="menuitem" onClick={() => reset("all")}>
            {t.resetEverything}
            <small>{hasMarks ? t.resetEverythingDetailMarks : t.resetEverythingDetail}</small>
          </button>
          <button type="button" role="menuitem" onClick={() => setResetOpen(false)}>{m.common.cancel}</button>
        </div>
      )}
    </div>
  );

  const viewControls = (
    <>
      {showNames && <NotationToggle value={notation} onChange={setNotation} />}
      {variantToggle}
      {pageCount > 1 && (
        <div className="sheet-toggle" role="group" aria-label={t.pageLayout}>
          {([["scroll", t.scrollPages, t.scrollPagesTitle], ["swipe", t.swipePages, t.swipePagesTitle]] as const).map(([id, label, title]) => (
            <button key={id} type="button" className={`sheet-toggle-option${pageMode === id ? " active" : ""}`}
              aria-pressed={pageMode === id} title={title} onClick={() => changePageMode(id)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {zoomControls}
      {onFullWindow && !fullWindow && (
        <button type="button" className="editor-btn" onClick={() => { setMoreOpen(false); onFullWindow(true); }}
          title={t.fullWindowTitle}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          <span>{t.fullWindow}</span>
        </button>
      )}
    </>
  );
  // Always in sight while the sheet fills the window, never folded away.
  const closeFull = fullWindow && onFullWindow && (
    <button type="button" className="editor-btn close-full" onClick={() => onFullWindow(false)}
      title={t.closeFullWindowTitle} aria-label={t.closeFullWindowTitle}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      {t.closeFullWindow}
    </button>
  );
  const statuses = !editing && variant === "annotated" && !labelsLive && (
    <span className="editor-status">{t.namesFixed}</span>
  );
  // Shown instead of the inline view controls when the box is too narrow
  // for them beside the other buttons.
  const viewMenu = (
    <div className="view-more" ref={moreRef}>
      <button type="button" className="editor-btn icon" aria-haspopup="true" aria-expanded={moreOpen}
        title={t.viewOptions} aria-label={t.viewOptions} onClick={() => setMoreOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" aria-hidden="true" style={{ strokeWidth: 3 }}><path d="M5 12h.01M12 12h.01M19 12h.01" /></svg>
      </button>
      {moreOpen && (
        <div className="view-more-panel" role="group" aria-label={t.viewOptions}>
          {statuses}
          {viewControls}
        </div>
      )}
    </div>
  );

  // In the toolbar beside Edit sheet, where it is always in sight.
  const pager = swiping && (
    <div className="page-pager" role="group" aria-label={t.pageLayout}>
      <button type="button" className="editor-btn icon" disabled={shownPage <= 1} onClick={() => goToPage(shownPage - 1)}
        title={t.prevPage} aria-label={t.prevPage}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
      <span className="page-pager-count" aria-live="polite"
        aria-label={fmt(t.pageOf, { n: shownPage, total: pageCount })}>
        {shownPage} / {pageCount}
      </span>
      <button type="button" className="editor-btn icon" disabled={shownPage >= pageCount} onClick={() => goToPage(shownPage + 1)}
        title={t.nextPage} aria-label={t.nextPage}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
      </button>
    </div>
  );

  const showSub = !!edits.notice || (editing && (visibleSelection.length > 0 || tool === "select"));

  return (
    <div className={`sheet-editor${!editing || spaceHeld ? " pannable" : ""}${panning ? " panning" : ""}`}>
      {/* Outside the scrolling area, so zooming and scrolling the sheet
          never move or scale the tools; the selection line stays under the
          toolbar however many rows the toolbar wraps onto. */}
      <div className={`sheet-editor-head${pager ? " has-pager" : ""}`}>
        {/* "view-inline" parts give way to the "..." menu when narrow. */}
        <div className={`sheet-editor-bar${editing ? " view-inline" : ""}`}>
          {!editing ? (
            <>
              <button type="button" className="editor-btn primary" onClick={() => setEditing(true)}
                title={showNames ? t.editSheetTitle : t.editSheetTitleNoNames}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1-4L16 5l3 3L8 19z" /></svg>
                {t.editSheet}
              </button>
              <span className="view-inline bar-statuses">{statuses}</span>
              {pager}
              <div className="bar-end view-inline">{viewControls}</div>
              {viewMenu}
              {closeFull}
            </>
          ) : (
            // How the sheet is shown, on a row of its own above the tools
            // that change it.
            <div className="bar-end">{viewControls}</div>
          )}
        </div>
        {editing && (
          <div className="sheet-editor-bar">
            <div className="editor-tools" role="toolbar" aria-label={t.editingTools}>
              {tools.map((t) => (
                <button key={t.id} type="button" title={t.title} aria-pressed={tool === t.id}
                  className={`editor-btn${tool === t.id ? " active" : ""}`} onClick={() => setTool(t.id)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">{t.icon}</svg>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
            {(tool === "pen" || tool === "text") && (
              <div className="editor-swatches" role="group" aria-label={t.colour}>
                {PEN_COLORS.map((c) => (
                  <button key={c} type="button" className={`swatch${penColor === c ? " active" : ""}`} style={{ background: c }}
                    aria-label={fmt(t.colourValue, { value: c })} aria-pressed={penColor === c} onClick={() => setPenColor(c)} />
                ))}
              </div>
            )}
            {tool === "highlighter" && (
              <div className="editor-swatches" role="group" aria-label={t.highlighterColour}>
                {HIGHLIGHT_COLORS.map((c) => (
                  <button key={c} type="button" className={`swatch${highlightColor === c ? " active" : ""}`} style={{ background: c }}
                    aria-label={fmt(t.highlighterValue, { value: c })} aria-pressed={highlightColor === c} onClick={() => setHighlightColor(c)} />
                ))}
              </div>
            )}
            <div className="editor-tools">
              <button type="button" className="editor-btn" onClick={undo} disabled={!edits.canUndo} title={t.undoTitle}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" /></svg>
                <span>{t.undo}</span>
              </button>
              <button type="button" className="editor-btn" onClick={redo} disabled={!edits.canRedo} title={t.redoTitle}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h2" /></svg>
                <span>{t.redo}</span>
              </button>
              {resetControl}
            </div>
            <span className="editor-status" aria-live="polite">{saveText[edits.saveState]}</span>
            <div className="bar-end">
              {pager}
              {viewMenu}
              <button type="button" className="editor-btn primary" onClick={stopEditing}>{t.done}</button>
              {closeFull}
            </div>
          </div>
        )}

        {unnamed.length > 0 && (
          <div className="sheet-editor-sub unnamed-notice" role="status">
            <span>
              {rich(plural(locale, unnamed.length, editing ? t.unnamedEditing : t.unnamed, { count: "{n}" }), {},
                { n: <strong>{unnamed.length}</strong> })}
            </span>
            <button type="button" className="editor-link" onClick={showNextUnnamed}>{t.showNext}</button>
            {!editing && <button type="button" className="editor-link" onClick={() => setEditing(true)}>{t.addNames}</button>}
          </div>
        )}

        {showSub && (
          <div className="sheet-editor-sub">
            {editing && single && selectedLabel && selectedResolved && (
              <>
                <span>
                  {rich(t.selectedName, {}, { name: <strong>{selectedResolved.text}</strong> })}
                  {selectedLabel.notes.length > 0 ? t.linked : t.notLinkedShort}
                </span>
                <button type="button" className="editor-link" onClick={() => openInlineFor(single)}>{t.retype}</button>
                {chord.length > 1 && (
                  <button type="button" className="editor-link"
                    onClick={() => setSelection(chord.map((l) => ({ kind: "label" as const, id: l.id })))}>
                    {fmt(t.selectChord, { count: chord.length })}
                  </button>
                )}
                <button type="button" className="editor-link" onClick={deleteSelection}>{t.hide}</button>
                {doc.labels[selectedLabel.id] && (
                  <button type="button" className="editor-link" onClick={() => resetLabels([selectedLabel.id])}>{t.reset}</button>
                )}
              </>
            )}
            {editing && single?.kind === "text" && (
              <>
                <span>{t.textNote}</span>
                <button type="button" className="editor-link" onClick={() => openInlineFor(single)}>{t.edit}</button>
                <button type="button" className="editor-link" onClick={deleteSelection}>{m.common.delete}</button>
              </>
            )}
            {editing && single?.kind === "stroke" && (
              <>
                <span>{t.drawing}</span>
                <button type="button" className="editor-link" onClick={deleteSelection}>{m.common.delete}</button>
              </>
            )}
            {editing && visibleSelection.length > 1 && (
              <>
                <span>{rich(t.selectedMany, {}, { count: <strong>{visibleSelection.length}</strong> })}</span>
                <button type="button" className="editor-link" onClick={deleteSelection}>
                  {selectedLabelIds.length === visibleSelection.length ? t.hide : t.hideOrDelete}
                </button>
                {selectedLabelIds.some((id) => doc.labels[id]) && (
                  <button type="button" className="editor-link" onClick={() => resetLabels(selectedLabelIds)}>{t.resetNamesButton}</button>
                )}
                <button type="button" className="editor-link" onClick={() => setSelection([])}>{t.clear}</button>
              </>
            )}
            {editing && !visibleSelection.length && tool === "select" && !edits.notice && (
              <span className="editor-hint">
                {t.hint}
                {variant === "original" && labelsLive && t.hintOriginal}
              </span>
            )}
            {edits.notice && (
              <span className="editor-notice">
                {edits.notice}
                {resetNotice === edits.notice && (
                  <button type="button" className="editor-link" onClick={() => { undo(); edits.clearNotice(); }}>
                    {t.undo}
                  </button>
                )}
                <button type="button" className="editor-link" onClick={edits.clearNotice}
                  aria-label={t.dismiss}>✕</button>
              </span>
            )}
          </div>
        )}
      </div>

      <div
        className={`sheet-editor-scroll${swiping && zoom <= 1 && !editing ? " swipe-lock" : ""}`}
        ref={scrollRef}
        style={{ "--zoom": zoom } as CSSProperties}
        onPointerDownCapture={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
        // The middle button's own autoscroll would fight the drag.
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      >
      <PdfPages
        pdfData={base}
        currentPage={swiping ? shownPage : undefined}
        onPageCount={setPageCount}
        renderScale={Math.min(4, Math.max(2, Math.round(renderZoom * 4) / 2))}
        renderOverlay={(page) => (
          <>
            <AnnotationLayer
              page={page}
              labels={showNames ? labelsByPage.get(page.pageNumber) ?? [] : []}
              labelColor={labelColor}
              showLabels={showNames}
              notation={notation}
              unnamed={unnamed.filter((u) => u.page === page.pageNumber)}
              focusedUnnamed={focusedUnnamed}
              nameSize={nameSize}
              edits={doc}
              editor={hooks}
            />
            {renderInline(page)}
          </>
        )}
      />
      </div>
    </div>
  );
}
