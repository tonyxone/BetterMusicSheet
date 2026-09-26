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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { fetchSheetAssets, fetchSheetFile } from "@/lib/sheet-files";
import { loadLabels, type LabelItem, type LabelSet } from "@/lib/labels";
import { correctionsForRetype, EMPTY_EDITS, isEmptyEdits, resolveLabel, useSheetEdits, type LabelEdit, type SaveState, type SheetEdits } from "@/lib/edits";
import type { Timeline } from "@/lib/timeline";
import type { SheetVariant } from "../sheet-toggle";
import { PdfPages, type PageInfo } from "./pdf-pages";
import { AnnotationLayer, itemKey, moveItems, type EditorHooks, type InlineTarget, type SelectedItem, type Tool } from "./annotation-layer";

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

function savedZoom() {
  try {
    const z = Number(localStorage.getItem(ZOOM_KEY));
    return z >= MIN_ZOOM && z <= MAX_ZOOM ? z : 1;
  } catch {
    return 1;
  }
}

/** The nearest ancestor that scrolls - the preview's resizable box. */
function scrollerOf(el: HTMLElement | null) {
  let node = el?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) return node;
    node = node.parentElement;
  }
  return null;
}

const SAVE_TEXT: Record<SaveState, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  unsaved: "Saving…",
  offline: "Offline — changes will save when you reconnect",
  error: "Couldn't save yet — retrying",
};

export function SheetEditor({ jobId, variant, exportRef }: {
  jobId: string;
  variant: SheetVariant;
  /** Filled in once the sheet has loaded, for the page's Download menu. */
  exportRef?: MutableRefObject<CustomizedExport | null>;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const edits = useSheetEdits(jobId);
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
  // A reset can wipe a lot at once, so it offers its own undo, in or out of
  // edit mode.
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(savedZoom);
  const zoomRef = useRef(zoom);
  // The page is re-rasterized for a new zoom only once zooming pauses; until
  // then the current pixels are stretched, which is cheap.
  const [renderZoom, setRenderZoom] = useState(zoom);
  const zoomAnchor = useRef<{ cx: number; cy: number; left: number; top: number; ratio: number } | null>(null);
  // Dragging the sheet around with the mouse, like a hand tool. Outside edit
  // mode a plain drag pans; in edit mode a drag draws or selects, so there
  // it takes the space bar held down, or the middle button.
  const panStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const assets = await fetchSheetAssets(jobId).catch(() => null);
        const originalIsPdf = !!assets?.original && (!assets.original_type || assets.original_type === "application/pdf");
        const [annotated, original, timeline] = await Promise.all([
          fetchBytes(jobId, "pdf").catch((err) => { console.error(err); return null; }),
          originalIsPdf ? fetchBytes(jobId, "original").then((b) => (isPdf(b) ? b : null)).catch(() => null) : Promise.resolve(null),
          fetchSheetFile(jobId, "timeline").then((r) => (r.ok ? r.json() as Promise<Timeline> : null)).catch(() => null),
        ]);
        if (!annotated && !original) throw new Error("no PDF to show");
        // Without the original there is nothing clean to draw the names over.
        const labels = original ? await loadLabels(jobId, annotated, timeline) : null;
        if (!cancelled) setLoaded({ original, annotated, timeline, labels });
      } catch (err) {
        console.error("Loading the sheet preview failed:", err);
        if (!cancelled) setLoadError("Couldn't show the preview here. The Download button still gives you the file.");
      }
    })();
    return () => { cancelled = true; };
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

  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = loaded ? async () => {
      const { exportCustomizedPdf } = await import("@/lib/export-pdf");
      // What the preview shows: the names over the original, the original
      // alone, or the annotated copy when the names can't be drawn.
      const exportBase = variant === "original" || labelsLive ? loaded.original! : loaded.annotated ?? loaded.original!;
      return exportCustomizedPdf({ base: exportBase, labels: showNames ? loaded.labels : null, edits: current() ?? EMPTY_EDITS });
    } : null;
    return () => { exportRef.current = null; };
  }, [exportRef, loaded, labelsLive, showNames, variant, current]);

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
    const scroller = scrollerOf(rootRef.current);
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
    const scroller = scrollerOf(rootRef.current);
    zoomAnchor.current = null;
    if (!anchor || !scroller) return;
    scroller.scrollLeft = (anchor.left + anchor.cx) * anchor.ratio - anchor.cx;
    scroller.scrollTop = (anchor.top + anchor.cy) * anchor.ratio - anchor.cy;
  }, [zoom]);

  useEffect(() => {
    const t = setTimeout(() => setRenderZoom(zoom), 250);
    return () => clearTimeout(t);
  }, [zoom]);

  // Ctrl + wheel (and a trackpad pinch, which browsers report the same way)
  // zooms the sheet around the pointer instead of the whole page.
  useEffect(() => {
    const scroller = scrollerOf(rootRef.current);
    if (!scroller) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
    }
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [loaded, zoomTo]);

  function onPanStart(e: React.PointerEvent<HTMLDivElement>) {
    // Touch and pens already scroll natively (outside edit mode) and draw
    // inside it; this is for the mouse.
    if (e.pointerType !== "mouse") return;
    const target = e.target as HTMLElement;
    if (target.closest(".sheet-editor-head, input, textarea, button")) return;
    const wanted = e.button === 1 || (e.button === 0 && (!editing || spaceHeld));
    if (!wanted) return;
    const scroller = scrollerOf(rootRef.current);
    if (!scroller) return;
    // Captured before the annotation layer sees it, so a space-drag in edit
    // mode pans instead of drawing or selecting.
    e.preventDefault();
    e.stopPropagation();
    panStart.current = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
    setPanning(true);
  }

  function onPanMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = panStart.current;
    const scroller = start && scrollerOf(rootRef.current);
    if (!start || !scroller) return;
    scroller.scrollLeft = start.left - (e.clientX - start.x);
    scroller.scrollTop = start.top - (e.clientY - start.y);
  }

  function onPanEnd() {
    if (!panStart.current) return;
    panStart.current = null;
    setPanning(false);
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
    const text = raw.trim();
    const edit: LabelEdit = { ...(now.labels[id] ?? {}) };
    if (!text) {
      update((d) => ({ ...d, labels: withLabelEdit(d.labels, id, { ...edit, hidden: true }) }));
      edits.setNotice("Name hidden. Undo brings it back.");
      return;
    }
    if (text === (edit.text ?? item.text)) return;
    if (text === item.text) delete edit.text;
    else edit.text = text;
    let corrections = now.corrections;
    let message: string;
    if (!loaded?.timeline) {
      message = "Playback isn't available for this sheet, so only the page changes.";
    } else {
      const result = correctionsForRetype(item, text, loaded.timeline, now.corrections);
      if (result === null) message = `"${text}" isn't a note name, so playback stays the same.`;
      else if (!result.linked) message = "This name isn't linked to a note, so only the page changes.";
      else {
        corrections = result.corrections;
        message = text === item.text
          ? "Back to the printed name; playback restored."
          : `Playback now plays ${text}${result.changed > 1 ? ` for ${result.changed} notes` : ""}.`;
      }
    }
    update((d) => ({ ...d, labels: withLabelEdit(d.labels, id, edit), corrections }));
    edits.setNotice(message);
  }, [labelsById, current, update, loaded, edits]);

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
    const message = scope === "all"
      ? "Reset to the annotated version: your names, playback fixes, drawings and notes are removed."
      : "Note names and playback reset to the annotated version. Your drawings and notes are kept.";
    setResetNotice(message);
    edits.setNotice(message);
  }, [update, edits]);

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

  // ---- rendering -------------------------------------------------------------

  if (loadError) {
    return <p style={{ color: "var(--danger)", textAlign: "center", padding: 24 }}>{loadError}</p>;
  }
  if (!loaded || !doc) {
    if (edits.loadError) return <p style={{ color: "var(--danger)", textAlign: "center", padding: 24 }}>{edits.loadError}</p>;
    return <p className="play-hint" style={{ padding: 24 }}>Loading the sheet…</p>;
  }
  if (!base) {
    return <p style={{ color: "var(--danger)", textAlign: "center", padding: 24 }}>Couldn&apos;t show the uploaded file here.</p>;
  }

  const hooks: EditorHooks | undefined = editing ? {
    tool, penColor, highlightColor, textColor: penColor, selection: visibleSelection, select: setSelection,
    update, current, inline, openInline,
  } : undefined;
  const labelColor = loaded.labels?.color ?? "#000000";
  const single = visibleSelection.length === 1 ? visibleSelection[0] : null;
  const selectedLabel = single?.kind === "label" ? labelsById.get(single.id) : undefined;
  const selectedResolved = selectedLabel ? resolveLabel(selectedLabel, doc) : null;
  const chord = selectedLabel ? labelsByPage.get(selectedLabel.page)?.filter((l) => l.group === selectedLabel.group) ?? [] : [];
  const selectedLabelIds = visibleSelection.filter((s) => s.kind === "label").map((s) => s.id);
  const hasNameChanges = Object.keys(doc.labels).length > 0 || Object.keys(doc.corrections).length > 0;
  const hasMarks = doc.texts.length > 0 || doc.strokes.length > 0;

  function renderInline(page: PageInfo) {
    if (!inline || inline.page !== page.pageNumber || !doc) return null;
    if (inline.kind === "label") {
      const item = labelsById.get(inline.id);
      const l = item && resolveLabel(item, doc);
      if (!l) return null;
      const fontPx = Math.max(14, l.size * inline.pxPerPt);
      return (
        <input
          key={inline.id}
          className="sheet-inline-input"
          defaultValue={l.text}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Note name"
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
        placeholder="Type a note"
        aria-label="Text note"
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
    { id: "select", label: "Select", title: "Select and move: drag a name or note; Shift- or Ctrl-click, or drag a box over empty space, to select several and move them together. Double-click a name to retype it.", icon: <path d="M5 3l14 8-6 1.5L10 19z" /> },
    { id: "pen", label: "Pen", title: "Draw on the sheet", icon: <path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3" /> },
    { id: "highlighter", label: "Highlight", title: "Highlight part of the sheet", icon: <path d="M4 20h6M7 17l-2-2 9-9 4 4-9 9zM12 8l4 4" /> },
    { id: "text", label: "Text", title: "Click anywhere to add a text note", icon: <path d="M5 5h14M12 5v14M9 19h6" /> },
    { id: "eraser", label: "Erase", title: "Erase drawings and text notes (note names are hidden with Delete instead)", icon: <path d="M8 20h12M5 15l8-9 6 6-7 8H9z" /> },
  ];

  const zoomControls = (
    <div className="zoom-controls" role="group" aria-label="Zoom">
      <button type="button" className="editor-btn icon" onClick={() => stepZoom(-1)} disabled={zoom <= MIN_ZOOM}
        title="Zoom out (Ctrl + scroll also zooms)" aria-label="Zoom out">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
      <button type="button" className="editor-btn zoom-level" onClick={() => zoomTo(1)} title="Fit the page to the width">
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className="editor-btn icon" onClick={() => stepZoom(1)} disabled={zoom >= MAX_ZOOM}
        title="Zoom in (Ctrl + scroll also zooms)" aria-label="Zoom in">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14" /></svg>
      </button>
    </div>
  );

  const resetControl = (
    <div className="reset-menu">
      <button type="button" className="editor-btn" disabled={isEmptyEdits(doc)} aria-haspopup="menu" aria-expanded={resetOpen}
        title="Go back to the annotated version as it was generated" onClick={() => setResetOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v6h6M4.5 10A8 8 0 1 1 6 17" /></svg>
        <span>Reset</span>
      </button>
      {resetOpen && (
        <div className="download-menu-list reset-menu-list" role="menu">
          <button type="button" role="menuitem" disabled={!hasNameChanges} onClick={() => reset("names")}>
            Note names only
            <small>Undo moved, retyped and hidden names, and the playback fixes they made. Keeps your drawings and notes.</small>
          </button>
          <button type="button" role="menuitem" onClick={() => reset("all")}>
            Everything
            <small>Back to the annotated version exactly as generated{hasMarks ? ", removing your drawings and notes too" : ""}.</small>
          </button>
          <button type="button" role="menuitem" onClick={() => setResetOpen(false)}>Cancel</button>
        </div>
      )}
    </div>
  );

  const showSub = !!edits.notice || (editing && (visibleSelection.length > 0 || tool === "select"));

  return (
    <div
      className={`sheet-editor${!editing || spaceHeld ? " pannable" : ""}${panning ? " panning" : ""}`}
      ref={rootRef}
      style={{ "--zoom": zoom } as CSSProperties}
      onPointerDownCapture={onPanStart}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      onPointerCancel={onPanEnd}
      // The middle button's own autoscroll would fight the drag.
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
    >
      {/* One sticky block, so the selection line stays under the toolbar
          however many rows the toolbar wraps onto. */}
      <div className="sheet-editor-head">
        <div className="sheet-editor-bar">
          {!editing ? (
            <>
              <button type="button" className="editor-btn primary" onClick={() => setEditing(true)}
                title={showNames ? "Move or retype note names, draw, highlight and add notes" : "Draw, highlight and add notes"}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1-4L16 5l3 3L8 19z" /></svg>
                Edit sheet
              </button>
              {!isEmptyEdits(doc) && <span className="editor-status">Showing your changes</span>}
              {variant === "annotated" && !labelsLive && <span className="editor-status">Names on this sheet can&apos;t be moved; you can still draw and add notes.</span>}
              <div className="bar-end">
                {resetControl}
                {zoomControls}
              </div>
            </>
          ) : (
            <>
              <div className="editor-tools" role="toolbar" aria-label="Editing tools">
                {tools.map((t) => (
                  <button key={t.id} type="button" title={t.title} aria-pressed={tool === t.id}
                    className={`editor-btn${tool === t.id ? " active" : ""}`} onClick={() => setTool(t.id)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">{t.icon}</svg>
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
              {(tool === "pen" || tool === "text") && (
                <div className="editor-swatches" role="group" aria-label="Colour">
                  {PEN_COLORS.map((c) => (
                    <button key={c} type="button" className={`swatch${penColor === c ? " active" : ""}`} style={{ background: c }}
                      aria-label={`Colour ${c}`} aria-pressed={penColor === c} onClick={() => setPenColor(c)} />
                  ))}
                </div>
              )}
              {tool === "highlighter" && (
                <div className="editor-swatches" role="group" aria-label="Highlighter colour">
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button key={c} type="button" className={`swatch${highlightColor === c ? " active" : ""}`} style={{ background: c }}
                      aria-label={`Highlighter ${c}`} aria-pressed={highlightColor === c} onClick={() => setHighlightColor(c)} />
                  ))}
                </div>
              )}
              <div className="editor-tools">
                <button type="button" className="editor-btn" onClick={undo} disabled={!edits.canUndo} title="Undo (Ctrl+Z)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" /></svg>
                  <span>Undo</span>
                </button>
                <button type="button" className="editor-btn" onClick={redo} disabled={!edits.canRedo} title="Redo (Ctrl+Shift+Z)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h2" /></svg>
                  <span>Redo</span>
                </button>
                {resetControl}
              </div>
              <span className="editor-status" aria-live="polite">{SAVE_TEXT[edits.saveState]}</span>
              <div className="bar-end">
                {zoomControls}
                <button type="button" className="editor-btn primary" onClick={stopEditing}>Done</button>
              </div>
            </>
          )}
        </div>

        {showSub && (
          <div className="sheet-editor-sub">
            {editing && single && selectedLabel && selectedResolved && (
              <>
                <span>
                  Note name <strong>{selectedResolved.text}</strong>
                  {selectedLabel.notes.length > 0 ? " · linked to playback" : " · not linked to playback"}
                </span>
                <button type="button" className="editor-link" onClick={() => openInlineFor(single)}>Retype</button>
                {chord.length > 1 && (
                  <button type="button" className="editor-link"
                    onClick={() => setSelection(chord.map((l) => ({ kind: "label" as const, id: l.id })))}>
                    Select chord ({chord.length})
                  </button>
                )}
                <button type="button" className="editor-link" onClick={deleteSelection}>Hide</button>
                {doc.labels[selectedLabel.id] && (
                  <button type="button" className="editor-link" onClick={() => resetLabels([selectedLabel.id])}>Reset</button>
                )}
              </>
            )}
            {editing && single?.kind === "text" && (
              <>
                <span>Text note</span>
                <button type="button" className="editor-link" onClick={() => openInlineFor(single)}>Edit</button>
                <button type="button" className="editor-link" onClick={deleteSelection}>Delete</button>
              </>
            )}
            {editing && single?.kind === "stroke" && (
              <>
                <span>Drawing</span>
                <button type="button" className="editor-link" onClick={deleteSelection}>Delete</button>
              </>
            )}
            {editing && visibleSelection.length > 1 && (
              <>
                <span><strong>{visibleSelection.length}</strong> selected · drag any of them to move them together</span>
                <button type="button" className="editor-link" onClick={deleteSelection}>
                  {selectedLabelIds.length === visibleSelection.length ? "Hide" : "Hide / delete"}
                </button>
                {selectedLabelIds.some((id) => doc.labels[id]) && (
                  <button type="button" className="editor-link" onClick={() => resetLabels(selectedLabelIds)}>Reset names</button>
                )}
                <button type="button" className="editor-link" onClick={() => setSelection([])}>Clear</button>
              </>
            )}
            {editing && !visibleSelection.length && tool === "select" && !edits.notice && (
              <span className="editor-hint">
                Click to select · Shift- or Ctrl-click, or drag a box, to select several · double-click a name to retype it · hold Space and drag to move around
                {variant === "original" && labelsLive && " · note names are edited in the Annotated view"}
              </span>
            )}
            {edits.notice && (
              <span className="editor-notice">
                {edits.notice}
                {resetNotice === edits.notice && (
                  <button type="button" className="editor-link" onClick={() => { undo(); edits.clearNotice(); }}>
                    Undo
                  </button>
                )}
                <button type="button" className="editor-link" onClick={edits.clearNotice}
                  aria-label="Dismiss">✕</button>
              </span>
            )}
          </div>
        )}
      </div>

      <PdfPages
        pdfData={base}
        renderScale={Math.min(4, Math.max(2, Math.round(renderZoom * 4) / 2))}
        renderOverlay={(page) => (
          <>
            <AnnotationLayer
              page={page}
              labels={showNames ? labelsByPage.get(page.pageNumber) ?? [] : []}
              labelColor={labelColor}
              showLabels={showNames}
              edits={doc}
              editor={hooks}
            />
            {renderInline(page)}
          </>
        )}
      />
    </div>
  );
}
