"use client";

// Everything drawn over one page of the sheet: the note names, the reader's
// freehand marks and their text notes. One SVG whose viewBox is the page in
// PDF points, so every coordinate is stored and drawn in the same units the
// labels and the timeline already use, and it scales with the canvas.
//
// Read-only unless an `editor` is passed, in which case it also takes the
// pointer: dragging names and notes, drawing, erasing.

import { useRef, useState } from "react";
import type { LabelItem } from "@/lib/labels";
import { resolveLabel, type SheetEdits } from "@/lib/edits";
import { simplify, strokePath } from "@/lib/ink";
import { newId } from "@/lib/edits";
import type { PageInfo } from "./pdf-pages";

export type Tool = "select" | "text" | "pen" | "highlighter" | "eraser";
export type Selection = { kind: "label" | "text" | "stroke"; id: string } | null;
export type InlineTarget = { kind: "label" | "text"; id: string; page: number; pxPerPt: number; isNew?: boolean };

export const PEN_WIDTH = 1.2;
export const HIGHLIGHTER_WIDTH = 7;
export const TEXT_SIZE = 10;
/** How far from a name or note a press still picks it up, in screen pixels. */
const PICK_RADIUS_PX = 12;

export type EditorHooks = {
  tool: Tool;
  penColor: string;
  highlightColor: string;
  textColor: string;
  selection: Selection;
  select: (s: Selection) => void;
  update: (fn: (d: SheetEdits) => SheetEdits, options?: { transient?: boolean; before?: SheetEdits }) => void;
  current: () => SheetEdits | null;
  /** The item under the inline text box, hidden while it is open. */
  inline: InlineTarget | null;
  openInline: (target: InlineTarget) => void;
};

/** Rough width of a label, for hit boxes and selection outlines only. */
function approxWidth(text: string, size: number) {
  return Math.max(1, [...text].length) * size * 0.62;
}

type Drag = {
  kind: "label" | "text" | "stroke";
  ids: string[];
  startX: number;
  startY: number;
  before: SheetEdits;
  moved: boolean;
};

export function AnnotationLayer({
  page,
  labels,
  labelColor,
  showLabels,
  edits,
  editor,
}: {
  page: PageInfo;
  /** This page's labels. */
  labels: LabelItem[];
  labelColor: string;
  showLabels: boolean;
  edits: SheetEdits;
  editor?: EditorHooks;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<number[] | null>(null);
  const drawing = useRef<number[] | null>(null);
  const drag = useRef<Drag | null>(null);
  const erasing = useRef<{ before: SheetEdits; removed: boolean } | null>(null);

  const w = page.widthPt;
  const h = page.heightPt;
  const strokes = edits.strokes.filter((s) => s.page === page.pageNumber);
  const texts = edits.texts.filter((t) => t.page === page.pageNumber);
  const resolved = showLabels
    ? labels.map((item) => resolveLabel(item, edits)).filter((l) => l !== null)
    : [];
  const interactive = !!editor;
  const selection = editor?.selection ?? null;
  const tool = editor?.tool ?? "select";

  function toPt(e: { clientX: number; clientY: number }) {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * w, y: ((e.clientY - rect.top) / rect.height) * h };
  }

  function pxPerPt() {
    return svgRef.current!.getBoundingClientRect().width / w;
  }

  function targetOf(el: EventTarget | null) {
    const node = (el as Element | null)?.closest?.("[data-kind]");
    if (!node || !svgRef.current?.contains(node)) return null;
    return { kind: node.getAttribute("data-kind") as Drag["kind"], id: node.getAttribute("data-id")! };
  }

  function eraseAt(e: React.PointerEvent) {
    if (!editor || !erasing.current) return;
    // elementsFromPoint, not the event target: pointer capture pins the
    // target to the SVG for the whole gesture.
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const hit = targetOf(el);
      if (!hit || hit.kind === "label") continue;
      editor.update((d) => hit.kind === "stroke"
        ? { ...d, strokes: d.strokes.filter((s) => s.id !== hit.id) }
        : { ...d, texts: d.texts.filter((t) => t.id !== hit.id) }, { transient: true });
      erasing.current.removed = true;
      break;
    }
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (!editor || e.button > 0) return;
    const current = editor.current();
    if (!current) return;
    const pt = toPt(e);
    const hit = targetOf(e.target);

    if (tool === "pen" || tool === "highlighter") {
      e.preventDefault();
      svgRef.current!.setPointerCapture(e.pointerId);
      drawing.current = [pt.x, pt.y];
      setDraft([pt.x, pt.y]);
      return;
    }
    if (tool === "eraser") {
      e.preventDefault();
      svgRef.current!.setPointerCapture(e.pointerId);
      erasing.current = { before: current, removed: false };
      eraseAt(e);
      return;
    }
    if (tool === "text" && (!hit || hit.kind !== "text")) {
      e.preventDefault();
      const id = newId("text");
      const note = { id, page: page.pageNumber, x: pt.x, y: pt.y + TEXT_SIZE * 0.35, text: "", size: TEXT_SIZE, color: editor.textColor };
      // Not an undo step yet: an empty note is dropped when its box closes,
      // and a filled one is recorded then (see sheet-editor.tsx).
      editor.update((d) => ({ ...d, texts: [...d.texts, note] }), { transient: true });
      editor.select({ kind: "text", id });
      editor.openInline({ kind: "text", id, page: page.pageNumber, pxPerPt: pxPerPt(), isNew: true });
      return;
    }
    // Select (or text tool on an existing note): pick up what was hit - or,
    // since a name is only a few pixels across, whatever is nearest within
    // a fingertip's reach.
    const picked = hit ?? nearest(pt.x, pt.y, PICK_RADIUS_PX / pxPerPt());
    if (!picked) {
      editor.select(null);
      return;
    }
    return pickUp(e, picked, pt, current);
  }

  function nearest(x: number, y: number, radius: number): { kind: Drag["kind"]; id: string } | null {
    let best: { kind: Drag["kind"]; id: string } | null = null;
    let bestDistance = radius;
    for (const l of resolved) {
      const d = Math.hypot(l.x - x, l.y - l.size * 0.35 - y);
      if (d < bestDistance) {
        bestDistance = d;
        best = { kind: "label", id: l.id };
      }
    }
    for (const t of texts) {
      const d = Math.hypot(t.x + approxWidth(t.text, t.size * 0.9) / 2 - x, t.y - t.size * 0.35 - y);
      if (d < bestDistance) {
        bestDistance = d;
        best = { kind: "text", id: t.id };
      }
    }
    return best;
  }

  function pickUp(e: React.PointerEvent<SVGSVGElement>, hit: { kind: Drag["kind"]; id: string }, pt: { x: number; y: number }, current: SheetEdits) {
    if (!editor) return;
    e.preventDefault();
    editor.select({ kind: hit.kind, id: hit.id });
    let ids = [hit.id];
    if (hit.kind === "label" && e.shiftKey) {
      const group = labels.find((l) => l.id === hit.id)?.group;
      ids = labels.filter((l) => l.group === group).map((l) => l.id);
    }
    drag.current = { kind: hit.kind, ids, startX: pt.x, startY: pt.y, before: current, moved: false };
    svgRef.current!.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!editor) return;
    if (drawing.current) {
      const pt = toPt(e);
      const pts = drawing.current;
      const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
      if (Math.hypot(pt.x - lx, pt.y - ly) < 0.3) return;
      pts.push(pt.x, pt.y);
      setDraft(pts.slice());
      return;
    }
    if (erasing.current) {
      eraseAt(e);
      return;
    }
    const d = drag.current;
    if (!d) return;
    const pt = toPt(e);
    const dx = pt.x - d.startX;
    const dy = pt.y - d.startY;
    if (!d.moved && Math.hypot(dx, dy) * pxPerPt() < 3) return;
    d.moved = true;
    editor.update(() => moved(d, dx, dy), { transient: true });
  }

  function moved(d: Drag, dx: number, dy: number): SheetEdits {
    const b = d.before;
    const r = (v: number) => Math.round(v * 100) / 100;
    if (d.kind === "label") {
      const labelsEdit = { ...b.labels };
      for (const id of d.ids) {
        const e = labelsEdit[id] ?? {};
        labelsEdit[id] = { ...e, dx: r((e.dx ?? 0) + dx), dy: r((e.dy ?? 0) + dy) };
      }
      return { ...b, labels: labelsEdit };
    }
    if (d.kind === "text") {
      return { ...b, texts: b.texts.map((t) => d.ids.includes(t.id) ? { ...t, x: r(t.x + dx), y: r(t.y + dy) } : t) };
    }
    return { ...b, strokes: b.strokes.map((s) => d.ids.includes(s.id)
      ? { ...s, points: s.points.map((v, i) => r(v + (i % 2 ? dy : dx))) } : s) };
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (!editor) return;
    if (drawing.current) {
      const points = simplify(drawing.current);
      drawing.current = null;
      setDraft(null);
      const highlighter = tool === "highlighter";
      editor.update((d) => ({ ...d, strokes: [...d.strokes, {
        id: newId("stroke"), page: page.pageNumber, tool: highlighter ? "highlighter" : "pen",
        color: highlighter ? editor.highlightColor : editor.penColor,
        width: highlighter ? HIGHLIGHTER_WIDTH : PEN_WIDTH, points,
      }] }));
      return;
    }
    if (erasing.current) {
      const { before, removed } = erasing.current;
      erasing.current = null;
      // One undo step for the whole sweep.
      if (removed) editor.update((d) => d, { before });
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      const pt = toPt(e);
      editor.update(() => moved(d, pt.x - d.startX, pt.y - d.startY), { before: d.before });
    }
  }

  function onDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!editor) return;
    const pt = toPt(e);
    const hit = targetOf(e.target) ?? nearest(pt.x, pt.y, PICK_RADIUS_PX / pxPerPt());
    if (!hit || hit.kind === "stroke") return;
    editor.select({ kind: hit.kind, id: hit.id });
    editor.openInline({ kind: hit.kind, id: hit.id, page: page.pageNumber, pxPerPt: pxPerPt() });
  }

  const inlineId = editor?.inline?.page === page.pageNumber ? editor.inline.id : null;
  const cursor = !interactive ? undefined
    : tool === "pen" || tool === "highlighter" ? "crosshair"
    : tool === "text" ? "text" : tool === "eraser" ? "cell" : "default";

  const highlight = strokes.filter((s) => s.tool === "highlighter");
  const pens = strokes.filter((s) => s.tool === "pen");

  function strokeEl(s: (typeof strokes)[number]) {
    const d = strokePath(s.points);
    const selected = selection?.kind === "stroke" && selection.id === s.id;
    return (
      <g key={s.id} data-kind="stroke" data-id={s.id}>
        {interactive && (
          <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(6, s.width * 1.6)}
            strokeLinecap="round" strokeLinejoin="round" pointerEvents="stroke" />
        )}
        {selected && (
          <path d={d} fill="none" stroke="var(--gold)" strokeWidth={s.width + 2.4} strokeOpacity={0.5}
            strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
        )}
        <path d={d} fill="none" stroke={s.color} strokeWidth={s.width}
          strokeOpacity={s.tool === "highlighter" ? 0.4 : 1}
          style={s.tool === "highlighter" ? { mixBlendMode: "multiply" } : undefined}
          strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
      </g>
    );
  }

  return (
    <svg
      ref={svgRef}
      className={`annotation-layer${interactive ? " editing" : ""}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ cursor }}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
      onPointerCancel={interactive ? onPointerUp : undefined}
      onDoubleClick={interactive ? onDoubleClick : undefined}
    >
      {highlight.map(strokeEl)}

      {resolved.map((l) => {
        if (l.id === inlineId) return null;
        const width = approxWidth(l.text, l.size);
        const selected = selection?.kind === "label" && selection.id === l.id;
        return (
          <g key={l.id} data-kind="label" data-id={l.id}>
            {interactive && (
              <rect
                x={l.x - width / 2 - 0.8} y={l.y - l.size * 0.9} width={width + 1.6} height={l.size * 1.15}
                rx={0.8}
                className={`label-hit${l.edited ? " edited" : ""}${selected ? " selected" : ""}`}
              />
            )}
            <text
              x={l.x} y={l.y} fontSize={l.size} textAnchor="middle" className="sheet-label"
              fill={labelColor} stroke="#fff" strokeWidth={l.size * 0.16} paintOrder="stroke"
            >
              {l.text}
            </text>
          </g>
        );
      })}

      {pens.map(strokeEl)}

      {texts.map((t) => {
        if (t.id === inlineId) return null;
        const lines = t.text.split("\n");
        const selected = selection?.kind === "text" && selection.id === t.id;
        const width = Math.max(...lines.map((line) => approxWidth(line, t.size * 0.9)));
        return (
          <g key={t.id} data-kind="text" data-id={t.id}>
            {interactive && (
              <rect x={t.x - 1} y={t.y - t.size} width={width + 2} height={t.size * 1.2 * lines.length + 1}
                rx={1} className={`label-hit${selected ? " selected" : ""}`} />
            )}
            <text x={t.x} y={t.y} fontSize={t.size} fill={t.color} className="sheet-note">
              {lines.map((line, i) => (
                <tspan key={i} x={t.x} dy={i ? t.size * 1.2 : 0}>{line || " "}</tspan>
              ))}
            </text>
          </g>
        );
      })}

      {draft && (
        <path
          d={strokePath(draft)} fill="none"
          stroke={tool === "highlighter" ? editor?.highlightColor : editor?.penColor}
          strokeOpacity={tool === "highlighter" ? 0.4 : 1}
          strokeWidth={tool === "highlighter" ? HIGHLIGHTER_WIDTH : PEN_WIDTH}
          strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"
        />
      )}
    </svg>
  );
}
