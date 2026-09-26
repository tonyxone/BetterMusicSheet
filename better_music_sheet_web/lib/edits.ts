"use client";

// A reader's own changes to a sheet: note names moved, retyped or hidden,
// freehand marks, text notes, and the playback corrections a retyped name
// implies. Stored per reader per sheet on the server (PUT /api/sheets/{id}/
// edits), so they come back on the next visit and on any other device.
//
// Everything is in PDF points, top-down - the space the labels and the
// timeline's boxes already use - so it lines up at any zoom.

import { useCallback, useEffect, useRef, useState } from "react";
import { clientApiFetch } from "./client-api";
import { validCorrection, type Corrections, type NoteCorrection } from "./corrections";
import { retypedMidi, type LabelItem } from "./labels";
import type { Timeline } from "./timeline";

export type LabelEdit = { dx?: number; dy?: number; text?: string; hidden?: boolean };
export type TextNote = { id: string; page: number; x: number; y: number; text: string; size: number; color: string };
export type Stroke = {
  id: string; page: number; tool: "pen" | "highlighter"; color: string; width: number;
  /** Flat [x0, y0, x1, y1, ...]. */
  points: number[];
};

export type SheetEdits = {
  version: 1;
  labels: Record<string, LabelEdit>;
  texts: TextNote[];
  strokes: Stroke[];
  corrections: Corrections;
};

export const EMPTY_EDITS: SheetEdits = { version: 1, labels: {}, texts: [], strokes: [], corrections: {} };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const COLOR = /^#[0-9a-f]{6}$/i;

/** Whatever came back from storage, reduced to what this version can draw.
 * A malformed entry is dropped on its own rather than costing the rest. */
export function sanitizeEdits(value: unknown): SheetEdits {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<SheetEdits>;
  const labels: Record<string, LabelEdit> = {};
  for (const [id, e] of Object.entries(raw.labels ?? {})) {
    if (!e || typeof e !== "object") continue;
    const edit: LabelEdit = {};
    if (finite(e.dx)) edit.dx = e.dx;
    if (finite(e.dy)) edit.dy = e.dy;
    if (typeof e.text === "string") edit.text = e.text.slice(0, 40);
    if (e.hidden === true) edit.hidden = true;
    if (Object.keys(edit).length) labels[id] = edit;
  }
  const texts = (Array.isArray(raw.texts) ? raw.texts : []).filter((t): t is TextNote =>
    !!t && typeof t.id === "string" && finite(t.page) && finite(t.x) && finite(t.y)
    && typeof t.text === "string" && finite(t.size) && COLOR.test(t.color));
  const strokes = (Array.isArray(raw.strokes) ? raw.strokes : []).filter((s): s is Stroke =>
    !!s && typeof s.id === "string" && finite(s.page) && (s.tool === "pen" || s.tool === "highlighter")
    && COLOR.test(s.color) && finite(s.width) && Array.isArray(s.points) && s.points.length >= 2
    && s.points.every(finite));
  const corrections = Object.fromEntries(Object.entries(raw.corrections ?? {})
    .filter(([, c]) => validCorrection(c))) as Corrections;
  return { version: 1, labels, texts, strokes, corrections };
}

export function isEmptyEdits(doc: SheetEdits) {
  return !Object.keys(doc.labels).length && !doc.texts.length && !doc.strokes.length && !Object.keys(doc.corrections).length;
}

/** A label as it should be drawn now: moved, retyped, or null if hidden. */
export function resolveLabel(item: LabelItem, edits: SheetEdits) {
  const e = edits.labels[item.id];
  if (e?.hidden) return null;
  return { ...item, x: item.x + (e?.dx ?? 0), y: item.y + (e?.dy ?? 0), text: e?.text ?? item.text, edited: !!e };
}

export type ResolvedLabel = NonNullable<ReturnType<typeof resolveLabel>>;

// ---- selections ------------------------------------------------------------

export type ItemKind = "label" | "text" | "stroke";
export type SelectedItem = { kind: ItemKind; id: string };

export const itemKey = (item: SelectedItem) => `${item.kind}:${item.id}`;

/** Every selected item moved by (dx, dy) points, from the ``before`` state. */
export function moveItems(before: SheetEdits, items: SelectedItem[], dx: number, dy: number): SheetEdits {
  const r = (v: number) => Math.round(v * 100) / 100;
  const keys = new Set(items.map(itemKey));
  const labels = { ...before.labels };
  for (const item of items) {
    if (item.kind !== "label") continue;
    const e = labels[item.id] ?? {};
    labels[item.id] = { ...e, dx: r((e.dx ?? 0) + dx), dy: r((e.dy ?? 0) + dy) };
  }
  return {
    ...before,
    labels,
    texts: before.texts.map((t) => keys.has(`text:${t.id}`) ? { ...t, x: r(t.x + dx), y: r(t.y + dy) } : t),
    strokes: before.strokes.map((s) => keys.has(`stroke:${s.id}`)
      ? { ...s, points: s.points.map((v, i) => r(v + (i % 2 ? dy : dx))) } : s),
  };
}

// ---- retyped names -> playback --------------------------------------------

/** The corrections implied by retyping ``item`` to ``text``: every note it
 * names moves to the new pitch, keeping its timing and hand. Retyping back
 * to the printed name drops those corrections again. Returns the new
 * corrections and how many notes changed, or null when ``text`` isn't a note
 * name (the label then changes on the page only). */
export function correctionsForRetype(item: LabelItem, text: string, original: Timeline, corrections: Corrections) {
  if (!item.notes.length) return { corrections, changed: 0, linked: false };
  const next = { ...corrections };
  let changed = 0;
  const byId = new Map<string, Timeline["notes"][number]>();
  for (const n of original.notes) {
    const id = n.printed_id ?? n.source_id;
    if (id && !byId.has(id)) byId.set(id, n);
  }
  for (const id of item.notes) {
    const note = byId.get(id);
    const m = note && original.measures[note.measure_index];
    if (!note || !m) continue;
    if (text.trim() === item.text.trim()) {
      if (next[id]) {
        delete next[id];
        changed++;
      }
      continue;
    }
    const midi = retypedMidi(text, item.text, note.midi);
    if (midi === null) return null;
    const existing = next[id];
    const correction: NoteCorrection = existing
      ? { ...existing, midi }
      : { midi, hand: note.hand ?? null, offset: note.start_beat - m.start_beat,
          duration: note.duration_beats > 0 ? note.duration_beats : 0.125 };
    next[id] = correction;
    changed++;
  }
  return { corrections: next, changed, linked: true };
}

// ---- storage ---------------------------------------------------------------

type Stored = { revision: number; doc: SheetEdits };

const draftKey = (jobId: string) => `sheet-edits-draft:${jobId}`;
const legacyCorrectionsKey = (jobId: string) => `sheet-corrections:${jobId}`;

/** Corrections made before edits were saved on the server lived only in
 * this browser. Folded in once, the first time the sheet has none. */
function legacyCorrections(jobId: string): Corrections {
  try {
    const raw = JSON.parse(localStorage.getItem(legacyCorrectionsKey(jobId)) ?? "{}");
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => validCorrection(v))) as Corrections;
  } catch {
    return {};
  }
}

export async function fetchEdits(jobId: string): Promise<Stored & { draft: boolean }> {
  const res = await clientApiFetch(`/api/sheets/${jobId}/edits`, { cache: "no-store" });
  if (!res.ok) throw new Error(`couldn't load your edits (${res.status})`);
  const body = await res.json() as { revision: number; doc: unknown };
  let doc = sanitizeEdits(body.doc);
  const revision = Number(body.revision) || 0;
  // An unsaved draft from a visit that went offline, still based on what the
  // server holds, wins over it; one based on anything older is stale.
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey(jobId)) ?? "null") as { base: number; doc: unknown } | null;
    if (draft && draft.base === revision) return { revision, doc: sanitizeEdits(draft.doc), draft: true };
    if (draft) localStorage.removeItem(draftKey(jobId));
  } catch { /* Storage is optional. */ }
  const legacy = legacyCorrections(jobId);
  if (!Object.keys(doc.corrections).length && Object.keys(legacy).length) {
    doc = { ...doc, corrections: legacy };
    return { revision, doc, draft: true };
  }
  return { revision, doc, draft: false };
}

export type SaveState = "saved" | "saving" | "unsaved" | "offline" | "error";

const SAVE_DELAY_MS = 1000;
const HISTORY_LIMIT = 100;

/** The editor's copy of the edits: undo/redo, and saving shortly after each
 * change (and on leaving the page). A save refused because another window
 * saved first adopts that window's copy rather than overwriting it. */
export function useSheetEdits(jobId: string) {
  const [doc, setDoc] = useState<SheetEdits | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string | null>(null);
  const history = useRef<{ past: SheetEdits[]; future: SheetEdits[] }>({ past: [], future: [] });
  const [, setHistoryTick] = useState(0);
  const revision = useRef(0);
  const docRef = useRef<SheetEdits | null>(null);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchEdits(jobId).then(({ revision: rev, doc: loaded, draft }) => {
      if (cancelled) return;
      revision.current = rev;
      docRef.current = loaded;
      setDoc(loaded);
      if (draft) {
        dirty.current = true;
        setSaveState("unsaved");
        schedule();
      }
    }).catch((err) => {
      console.error(err);
      if (!cancelled) setLoadError("Couldn't load your saved changes. Reload the page to try again.");
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const save = useCallback(async (keepalive = false) => {
    if (!dirty.current || inFlight.current || !docRef.current) return;
    inFlight.current = true;
    dirty.current = false;
    const sending = docRef.current;
    setSaveState("saving");
    try {
      const res = await clientApiFetch(`/api/sheets/${jobId}/edits`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, keepalive,
        body: JSON.stringify({ revision: revision.current, doc: sending }),
      });
      if (res.status === 409) {
        const body = await res.json() as { revision: number; doc: unknown };
        revision.current = Number(body.revision) || 0;
        const theirs = sanitizeEdits(body.doc);
        docRef.current = theirs;
        setDoc(theirs);
        history.current = { past: [], future: [] };
        setNotice("These edits were changed in another window, so that version is shown now.");
        setSaveState("saved");
      } else if (!res.ok) {
        const body = await res.json().catch(() => null) as { detail?: string } | null;
        throw new Error(body?.detail ?? `save failed (${res.status})`);
      } else {
        revision.current = (await res.json()).revision;
        try { localStorage.removeItem(draftKey(jobId)); localStorage.removeItem(legacyCorrectionsKey(jobId)); } catch { /* optional */ }
        setSaveState(dirty.current ? "unsaved" : "saved");
      }
    } catch (err) {
      console.error("Saving edits failed:", err);
      dirty.current = true;
      try { localStorage.setItem(draftKey(jobId), JSON.stringify({ base: revision.current, doc: docRef.current })); } catch { /* optional */ }
      setSaveState(navigator.onLine ? "error" : "offline");
      if (err instanceof Error && /Too many/.test(err.message)) setNotice(err.message);
      timer.current = setTimeout(() => void save(), 8000);
    } finally {
      inFlight.current = false;
      // Changes made while this save was on the wire go out next.
      if (dirty.current && !timer.current) schedule();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  function schedule() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void save();
    }, SAVE_DELAY_MS);
  }

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden" || !document.visibilityState) void save(true);
    };
    const leave = () => void save(true);
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", leave);
      if (timer.current) clearTimeout(timer.current);
      void save(true);
    };
  }, [save]);

  const commit = useCallback((next: SheetEdits) => {
    docRef.current = next;
    setDoc(next);
    dirty.current = true;
    setSaveState("unsaved");
    try { localStorage.setItem(draftKey(jobId), JSON.stringify({ base: revision.current, doc: next })); } catch { /* optional */ }
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  /** Apply a change. ``transient`` changes (a drag in progress) update the
   * page without an undo step; the final one of the gesture records it. */
  const update = useCallback((fn: (d: SheetEdits) => SheetEdits, options: { transient?: boolean; before?: SheetEdits } = {}) => {
    const current = docRef.current;
    if (!current) return;
    const next = fn(current);
    // A gesture that changed things transiently records its undo step at the
    // end, even when that last call has nothing further to change.
    if (next === current && (!options.before || options.before === current)) return;
    if (options.transient) {
      docRef.current = next;
      setDoc(next);
      return;
    }
    const h = history.current;
    h.past.push(options.before ?? current);
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
    h.future = [];
    setHistoryTick((t) => t + 1);
    commit(next);
  }, [commit]);

  const undo = useCallback(() => {
    const h = history.current;
    const current = docRef.current;
    const previous = h.past.pop();
    if (!previous || !current) return;
    h.future.push(current);
    setHistoryTick((t) => t + 1);
    commit(previous);
  }, [commit]);

  const redo = useCallback(() => {
    const h = history.current;
    const current = docRef.current;
    const next = h.future.pop();
    if (!next || !current) return;
    h.past.push(current);
    setHistoryTick((t) => t + 1);
    commit(next);
  }, [commit]);

  return {
    doc, loadError, saveState, notice, clearNotice: () => setNotice(null), setNotice,
    update, undo, redo,
    canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0,
    /** The live document, for event handlers that must not wait on a render. */
    current: () => docRef.current,
  };
}

export function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
