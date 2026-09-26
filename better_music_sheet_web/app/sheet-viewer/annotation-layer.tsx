"use client";

// Everything drawn over one page of the sheet: the note names, the reader's
// freehand marks and their text notes. One SVG whose viewBox is the page in
// PDF points, so every coordinate is stored and drawn in the same units the
// labels and the timeline already use, and it scales with the canvas.
//
// Read-only unless an `editor` is passed, in which case it also takes the
// pointer: selecting (one item, several, or everything inside a dragged
// box), moving the selection together, drawing, erasing.

import { useRef, useState } from "react";
import type { LabelItem } from "@/lib/labels";
import { itemKey, moveItems, newId, resolveLabel, type ItemKind, type SelectedItem, type SheetEdits } from "@/lib/edits";
import { simplify, strokePath } from "@/lib/ink";
import type { PageInfo } from "./pdf-pages";

export type Tool = "select" | "text" | "pen" | "highlighter" | "eraser";
export type { ItemKind, SelectedItem };
export { itemKey, moveItems };
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
  selection: SelectedItem[];
  select: (items: SelectedItem[]) => void;
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

type Drag = { items: SelectedItem[]; startX: number; startY: number; before: SheetEdits; moved: boolean };
type Marquee = { x0: number; y0: number; x1: number; y1: number; additive: boolean; base: SelectedItem[] };

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
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const drawing = useRef<number[] | null>(null);
  const drag = useRef<Drag | null>(null);
  const boxing = useRef<Marquee | null>(null);
  const erasing = useRef<{ before: SheetEdits; removed: boolean } | null>(null);

  const w = page.widthPt;
  const h = page.heightPt;
  const strokes = edits.strokes.filter((s) => s.page === page.pageNumber);
  const texts = edits.texts.filter((t) => t.page === page.pageNumber);
  const resolved = showLabels
    ? labels.map((item) => resolveLabel(item, edits)).filter((l) => l !== null)
    : [];
  const interactive = !!editor;
  const selectedKeys = new Set((editor?.selection ?? []).map(itemKey));
  const isSelected = (kind: ItemKind, id: string) => selectedKeys.has(`${kind}:${id}`);
  const tool = editor?.tool ?? "select";

  function toPt(e: { clientX: number; clientY: number }) {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * w, y: ((e.clientY - rect.top) / rect.height) * h };
  }

  function pxPerPt() {
    return svgRef.current!.getBoundingClientRect().width / w;
  }

  function targetOf(el: EventTarget | null): SelectedItem | null {
    const node = (el as Element | null)?.closest?.("[data-kind]");
    if (!node || !svgRef.current?.contains(node)) return null;
    return { kind: node.getAttribute("data-kind") as ItemKind, id: node.getAttribute("data-id")! };
  }

  function nearest(x: number, y: number, radius: number): SelectedItem | null {
    let best: SelectedItem | null = null;
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

  /** Items whose centre lies inside the box. */
  function itemsIn(m: Marquee): SelectedItem[] {
    const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
    const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
    const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const found: SelectedItem[] = [];
    for (const l of resolved) if (inside(l.x, l.y - l.size * 0.35)) found.push({ kind: "label", id: l.id });
    for (const t of texts) {
      if (inside(t.x + approxWidth(t.text, t.size * 0.9) / 2, t.y - t.size * 0.35)) found.push({ kind: "text", id: t.id });
    }
    for (const s of strokes) {
      const xs = s.points.filter((_, i) => i % 2 === 0), ys = s.points.filter((_, i) => i % 2 === 1);
      if (inside((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2)) {
        found.push({ kind: "stroke", id: s.id });
      }
    }
    return found;
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
      editor.select([{ kind: "text", id }]);
      editor.openInline({ kind: "text", id, page: page.pageNumber, pxPerPt: pxPerPt(), isNew: true });
      return;
    }

    // Select (or the text tool on an existing note). A name is only a few
    // pixels across, so a press near one counts as on it.
    e.preventDefault();
    svgRef.current!.setPointerCapture(e.pointerId);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const picked = hit ?? nearest(pt.x, pt.y, PICK_RADIUS_PX / pxPerPt());
    if (!picked) {
      // Empty space: drag out a box to select everything inside it.
      const m = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, additive, base: additive ? editor.selection : [] };
      boxing.current = m;
      setMarquee(m);
      return;
    }
    if (additive) {
      // Shift/Ctrl/Cmd-click adds or removes one item, and doesn't move anything.
      const key = itemKey(picked);
      editor.select(selectedKeys.has(key)
        ? editor.selection.filter((s) => itemKey(s) !== key)
        : [...editor.selection, picked]);
      return;
    }
    // Pressing on part of the selection moves all of it; on anything else,
    // that item becomes the selection.
    const items = selectedKeys.has(itemKey(picked)) ? editor.selection : [picked];
    if (items !== editor.selection) editor.select(items);
    drag.current = { items, startX: pt.x, startY: pt.y, before: current, moved: false };
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
    if (boxing.current) {
      const pt = toPt(e);
      boxing.current = { ...boxing.current, x1: pt.x, y1: pt.y };
      setMarquee(boxing.current);
      return;
    }
    const d = drag.current;
    if (!d) return;
    const pt = toPt(e);
    const dx = pt.x - d.startX;
    const dy = pt.y - d.startY;
    if (!d.moved && Math.hypot(dx, dy) * pxPerPt() < 3) return;
    d.moved = true;
    editor.update(() => moveItems(d.before, d.items, dx, dy), { transient: true });
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
    if (boxing.current) {
      const m = boxing.current;
      boxing.current = null;
      setMarquee(null);
      const tiny = Math.hypot(m.x1 - m.x0, m.y1 - m.y0) * pxPerPt() < 4;
      if (tiny) {
        // A plain click on empty space clears the selection.
        if (!m.additive) editor.select([]);
        return;
      }
      const found = itemsIn(m);
      const keys = new Set(m.base.map(itemKey));
      editor.select([...m.base, ...found.filter((item) => !keys.has(itemKey(item)))]);
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      const pt = toPt(e);
      editor.update(() => moveItems(d.before, d.items, pt.x - d.startX, pt.y - d.startY), { before: d.before });
    }
  }

  function onDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!editor) return;
    const pt = toPt(e);
    const hit = targetOf(e.target) ?? nearest(pt.x, pt.y, PICK_RADIUS_PX / pxPerPt());
    if (!hit || hit.kind === "stroke") return;
    editor.select([hit]);
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
    const selected = isSelected("stroke", s.id);
    return (
      <g key={s.id} data-kind="stroke" data-id={s.id}>
        {interactive && (
          <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(6, s.width * 1.6)}
            strokeLinecap="round" strokeLinejoin="round" pointerEvents="stroke" />
        )}
        {selected && (
          <path d={d} fill="none" stroke="var(--accent)" strokeWidth={s.width + 2.4} strokeOpacity={0.35}
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
        const selected = isSelected("label", l.id);
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
        const selected = isSelected("text", t.id);
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

      {marquee && (
        <rect
          className="selection-box"
          x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)}
          width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)}
          pointerEvents="none"
        />
      )}
    </svg>
  );
}
