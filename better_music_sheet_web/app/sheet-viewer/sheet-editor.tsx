"use client";

// The sheet preview, with the reader's own changes on top and the tools to
// make them: move or retype a note name (retyping one fixes what plays too),
// draw, highlight, add text notes. Changes save as they are made (see
// lib/edits.ts) and come back on the next visit.
//
// The note names are drawn from data over the ORIGINAL upload, rather than
// shown baked into the annotated PDF, which is what makes them editable.
// When a sheet can't be shown that way - no stored original, or a photo
// upload - the annotated PDF is shown instead, and only marks and notes can
// be added on top of it.

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { fetchSheetAssets, fetchSheetFile } from "@/lib/sheet-files";
import { loadLabels, type LabelItem, type LabelSet } from "@/lib/labels";
import { correctionsForRetype, EMPTY_EDITS, isEmptyEdits, resolveLabel, useSheetEdits, type LabelEdit, type SaveState, type SheetEdits } from "@/lib/edits";
import type { Timeline } from "@/lib/timeline";
import type { SheetVariant } from "../sheet-toggle";
import { PdfPages, type PageInfo } from "./pdf-pages";
import { AnnotationLayer, type EditorHooks, type InlineTarget, type Selection, type Tool } from "./annotation-layer";

const PEN_COLORS = ["#2e2117", "#c0392b", "#1f5fbf", "#2f7d32"];
const HIGHLIGHT_COLORS = ["#ffd84d", "#8ee07a", "#ff9ec7", "#7cc8ff"];

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

  const [editRequested, setEditRequested] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [penColor, setPenColor] = useState(PEN_COLORS[1]);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [selection, setSelection] = useState<Selection>(null);
  const [inline, setInline] = useState<InlineTarget | null>(null);
  // Mirrors `inline`, so the box closing twice (Enter, then the blur its
  // removal can cause) only applies once.
  const inlineRef = useRef<InlineTarget | null>(null);
  const inlineBefore = useRef<SheetEdits | null>(null);

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
      const exportBase = labelsLive ? loaded.original! : loaded.annotated ?? loaded.original!;
      return exportCustomizedPdf({ base: exportBase, labels: labelsLive ? loaded.labels : null, edits: current() ?? EMPTY_EDITS });
    } : null;
    return () => { exportRef.current = null; };
  }, [exportRef, loaded, labelsLive, current]);

  // Switching to the original puts the tools away; there is nothing of the
  // reader's on it to edit.
  const editing = editRequested && variant === "annotated";

  function stopEditing() {
    setEditRequested(false);
    setSelection(null);
    setInline(null);
    inlineRef.current = null;
  }

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

  const resetLabel = useCallback((id: string) => {
    const item = labelsById.get(id);
    const now = current();
    if (!item || !now) return;
    const result = loaded?.timeline ? correctionsForRetype(item, item.text, loaded.timeline, now.corrections) : null;
    update((d) => ({ ...d, labels: withLabelEdit(d.labels, id, {}), corrections: result?.corrections ?? d.corrections }));
  }, [labelsById, current, update, loaded]);

  const deleteSelection = useCallback(() => {
    if (!selection) return;
    if (selection.kind === "label") {
      update((d) => ({ ...d, labels: withLabelEdit(d.labels, selection.id, { ...(d.labels[selection.id] ?? {}), hidden: true }) }));
    } else if (selection.kind === "text") {
      update((d) => ({ ...d, texts: d.texts.filter((t) => t.id !== selection.id) }));
    } else {
      update((d) => ({ ...d, strokes: d.strokes.filter((s) => s.id !== selection.id) }));
    }
    setSelection(null);
  }, [selection, update]);

  const nudge = useCallback((dx: number, dy: number) => {
    if (!selection) return;
    const r = (v: number) => Math.round(v * 100) / 100;
    update((d) => {
      if (selection.kind === "label") {
        const e = d.labels[selection.id] ?? {};
        return { ...d, labels: { ...d.labels, [selection.id]: { ...e, dx: r((e.dx ?? 0) + dx), dy: r((e.dy ?? 0) + dy) } } };
      }
      if (selection.kind === "text") {
        return { ...d, texts: d.texts.map((t) => t.id === selection.id ? { ...t, x: r(t.x + dx), y: r(t.y + dy) } : t) };
      }
      return { ...d, strokes: d.strokes.map((s) => s.id === selection.id
        ? { ...s, points: s.points.map((v, i) => r(v + (i % 2 ? dy : dx))) } : s) };
    });
  }, [selection, update]);

  const openInline = useCallback((target: InlineTarget) => {
    // A new text note exists only transiently until it has text; remember
    // the document without it, so keeping it records one undo step.
    const now = current();
    inlineBefore.current = target.isNew && now
      ? { ...now, texts: now.texts.filter((t) => t.id !== target.id) } : null;
    inlineRef.current = target;
    setInline(target);
  }, [current]);

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
        setSelection(null);
      } else {
        update((d) => ({ ...d, texts: d.texts.map((t) => t.id === target.id ? { ...t, text } : t) }), before ? { before } : {});
      }
      return;
    }
    if (text === null) return;
    if (!text) update((d) => ({ ...d, texts: d.texts.filter((t) => t.id !== target.id) }));
    else update((d) => ({ ...d, texts: d.texts.map((t) => t.id === target.id ? { ...t, text } : t) }));
  }, [retypeLabel, update]);

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
      if (!selection) {
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
        setSelection(null);
      } else if (e.key === "Enter" && selection.kind !== "stroke") {
        e.preventDefault();
        const item = selection.kind === "label" ? labelsById.get(selection.id) : current()?.texts.find((t) => t.id === selection.id);
        const pageEl = item && document.querySelector<SVGSVGElement>(`.sheet-page[data-page="${item.page}"] svg.annotation-layer`);
        if (item && pageEl) {
          openInline({ kind: selection.kind, id: selection.id, page: item.page,
            pxPerPt: pageEl.getBoundingClientRect().width / pageEl.viewBox.baseVal.width });
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, selection, undo, redo, nudge, deleteSelection, labelsById, current, openInline]);

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
    tool, penColor, highlightColor, textColor: penColor, selection, select: setSelection,
    update, current, inline, openInline,
  } : undefined;
  const showLayer = variant === "annotated";
  const labelColor = loaded.labels?.color ?? "#000000";
  const selectedLabel = selection?.kind === "label" ? labelsById.get(selection.id) : undefined;
  const selectedResolved = selectedLabel ? resolveLabel(selectedLabel, doc) : null;

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
    { id: "select", label: "Move", title: "Move and edit: drag a note name or note, double-click to retype it. Shift-drag moves a whole chord's names.", icon: <path d="M5 3l14 8-6 1.5L10 19z" /> },
    { id: "pen", label: "Pen", title: "Draw on the sheet", icon: <path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3" /> },
    { id: "highlighter", label: "Highlight", title: "Highlight part of the sheet", icon: <path d="M4 20h6M7 17l-2-2 9-9 4 4-9 9zM12 8l4 4" /> },
    { id: "text", label: "Text", title: "Click anywhere to add a text note", icon: <path d="M5 5h14M12 5v14M9 19h6" /> },
    { id: "eraser", label: "Erase", title: "Erase drawings and text notes (note names are hidden with Delete instead)", icon: <path d="M8 20h12M5 15l8-9 6 6-7 8H9z" /> },
  ];

  return (
    <div className="sheet-editor">
      {/* One sticky block, so the selection line stays under the toolbar
          however many rows the toolbar wraps onto. */}
      <div className="sheet-editor-head">
      {showLayer && (
        <div className="sheet-editor-bar">
          {!editing ? (
            <>
              <button type="button" className="editor-btn primary" onClick={() => setEditRequested(true)}
                title="Move or retype note names, draw, highlight and add notes">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1-4L16 5l3 3L8 19z" /></svg>
                Edit sheet
              </button>
              {!isEmptyEdits(doc) && <span className="editor-status">Showing your changes</span>}
              {!labelsLive && <span className="editor-status">Names on this sheet can&apos;t be moved; you can still draw and add notes.</span>}
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
                <button type="button" className="editor-btn" disabled={isEmptyEdits(doc)}
                  title="Remove all your changes to this sheet"
                  onClick={() => {
                    if (window.confirm("Remove all your changes to this sheet? This includes moved and retyped names, drawings, notes and playback fixes.")) {
                      update(() => EMPTY_EDITS);
                      setSelection(null);
                    }
                  }}>
                  <span>Reset all</span>
                </button>
              </div>
              <span className="editor-status" aria-live="polite">{SAVE_TEXT[edits.saveState]}</span>
              <button type="button" className="editor-btn primary done" onClick={stopEditing}>Done</button>
            </>
          )}
        </div>
      )}

      {editing && (selection || edits.notice) && (
        <div className="sheet-editor-sub">
          {selectedLabel && selectedResolved && (
            <>
              <span>
                Note name <strong>{selectedResolved.text}</strong>
                {selectedLabel.notes.length > 0 ? " · linked to playback" : " · not linked to playback"}
              </span>
              <button type="button" className="editor-link" onClick={() => {
                const pageEl = document.querySelector<SVGSVGElement>(`.sheet-page[data-page="${selectedLabel.page}"] svg.annotation-layer`);
                if (pageEl) openInline({ kind: "label", id: selectedLabel.id, page: selectedLabel.page,
                  pxPerPt: pageEl.getBoundingClientRect().width / pageEl.viewBox.baseVal.width });
              }}>Retype</button>
              <button type="button" className="editor-link" onClick={deleteSelection}>Hide</button>
              {doc.labels[selectedLabel.id] && (
                <button type="button" className="editor-link" onClick={() => resetLabel(selectedLabel.id)}>Reset</button>
              )}
            </>
          )}
          {selection?.kind === "text" && (
            <>
              <span>Text note</span>
              <button type="button" className="editor-link" onClick={deleteSelection}>Delete</button>
            </>
          )}
          {selection?.kind === "stroke" && (
            <>
              <span>Drawing</span>
              <button type="button" className="editor-link" onClick={deleteSelection}>Delete</button>
            </>
          )}
          {edits.notice && (
            <span className="editor-notice">
              {edits.notice}
              <button type="button" className="editor-link" onClick={edits.clearNotice} aria-label="Dismiss">✕</button>
            </span>
          )}
        </div>
      )}
      </div>

      <PdfPages
        pdfData={base}
        renderOverlay={showLayer ? (page) => (
          <>
            <AnnotationLayer
              page={page}
              labels={labelsLive ? labelsByPage.get(page.pageNumber) ?? [] : []}
              labelColor={labelColor}
              showLabels={labelsLive}
              edits={doc}
              editor={hooks}
            />
            {renderInline(page)}
          </>
        ) : undefined}
      />
    </div>
  );
}
