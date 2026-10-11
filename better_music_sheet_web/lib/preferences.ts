"use client";

// The reader's own settings - which copy a sheet opens on, how the names are
// written, the practice page's options - one set for every sheet.
//
// Signed in, they belong to the account (GET/PUT /api/me/preferences): saved
// as they change and loaded on any device. A guest keeps them in this
// browser. Either way a copy is kept in localStorage, per account, so a page
// opens with them at once instead of flicking from the defaults once the
// account's arrive.
//
// Only what the reader has chosen is stored; everything else is the default
// below (or, for the notation, the one the sheet was made with). Zoom and the
// preview's height stay with the device - they depend on the screen.

import { useCallback, useSyncExternalStore } from "react";
import { readSession } from "./auth";
import { clientApiFetch } from "./client-api";
import type { Notation } from "./notation";

export type Preferences = {
  sheet_view: "annotated" | "original";
  notation: Notation;
  /** An instrument id from app/play/synth.ts. */
  instrument: string;
  speed: number;
  show_key_names: boolean;
  show_note_names: boolean;
  sound_on: boolean;
  sheet_open: boolean;
  roll_open: boolean;
  /** The sheet's share of the space it splits with the piano roll. */
  split: number;
  /** The sheet preview: every page down one column, or one at a time. */
  page_mode: "scroll" | "swipe";
};

export type PreferenceKey = keyof Preferences;

type Chosen = Partial<Preferences>;

// Saving waits for a pause, so dragging the panel divider or the speed slider
// sends one request rather than one per pixel.
const SAVE_DELAY_MS = 600;
const RETRY_DELAY_MS = 5000;
const EVENT = "bms-preferences";

const VALID: { [K in PreferenceKey]: (v: unknown) => boolean } = {
  sheet_view: (v) => v === "annotated" || v === "original",
  notation: (v) => v === "letters" || v === "numbers" || v === "solfege",
  instrument: (v) => typeof v === "string" && /^[a-z0-9-]{1,32}$/.test(v),
  speed: (v) => typeof v === "number" && v >= 0.1 && v <= 2,
  show_key_names: (v) => typeof v === "boolean",
  show_note_names: (v) => typeof v === "boolean",
  sound_on: (v) => typeof v === "boolean",
  sheet_open: (v) => typeof v === "boolean",
  roll_open: (v) => typeof v === "boolean",
  split: (v) => typeof v === "number" && v >= 0 && v <= 1,
  page_mode: (v) => v === "scroll" || v === "swipe",
};

/** Only the settings that are well-formed - whatever was stored or sent. */
function valid(value: unknown): Chosen {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key in VALID && VALID[key as PreferenceKey](v)) out[key] = v;
    }
  }
  return out as Chosen;
}

let owner: string | null | undefined; // whose settings are loaded; undefined = none yet
let chosen: Chosen = {};
let pending: Chosen = {}; // changed here, not yet saved to the account
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const cacheKey = (who: string | null) => `bms_prefs:${who ?? "guest"}`;

function readCache(who: string | null): Chosen {
  try {
    return valid(JSON.parse(localStorage.getItem(cacheKey(who)) ?? "{}"));
  } catch {
    return {};
  }
}

function writeCache() {
  try { localStorage.setItem(cacheKey(owner ?? null), JSON.stringify(chosen)); } catch { /* optional */ }
}

/** Settings this browser kept before they were saved anywhere else: the
 * notation and the instrument each had a key of their own. */
function legacy(): Chosen {
  try {
    return valid({
      notation: localStorage.getItem("bms_label_notation") ?? undefined,
      instrument: localStorage.getItem("sheet-instrument") ?? undefined,
    });
  } catch {
    return {};
  }
}

function notify() {
  window.dispatchEvent(new Event(EVENT));
}

/** Load the settings of whoever is signed in now, if they aren't already. */
function sync() {
  const who = readSession()?.user.user_id ?? null;
  if (who === owner) return;
  owner = who;
  pending = {};
  // A guest's own choices so far come along to an account that has none yet.
  chosen = { ...legacy(), ...readCache(null), ...(who ? readCache(who) : {}) };
  notify();
  if (who) void load(who);
}

async function load(who: string) {
  try {
    const res = await clientApiFetch("/api/me/preferences", { cache: "no-store" });
    if (!res.ok || owner !== who) return;
    const saved = valid((await res.json() as { preferences?: unknown }).preferences);
    // The account wins, except for whatever was changed while it loaded.
    const mine = { ...chosen };
    chosen = { ...mine, ...saved, ...pending };
    writeCache();
    notify();
    // Anything only this browser knew about is saved to the account too.
    const missing = Object.fromEntries(Object.entries(mine).filter(([k]) => !(k in saved))) as Chosen;
    if (Object.keys(missing).length) {
      pending = { ...missing, ...pending };
      scheduleSave(0);
    }
  } catch {
    // Offline or unreachable: the copy in this browser stands in.
  }
}

function scheduleSave(delay = SAVE_DELAY_MS) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), delay);
}

async function save() {
  saveTimer = null;
  const who = owner;
  const body = pending;
  if (!who || !Object.keys(body).length) return;
  pending = {};
  try {
    const res = await clientApiFetch("/api/me/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`saving settings failed (${res.status})`);
  } catch (err) {
    console.error(err);
    if (owner !== who) return;
    // Put them back, under anything changed since, and try again later.
    pending = { ...body, ...pending };
    scheduleSave(RETRY_DELAY_MS);
  }
}

function subscribe(onChange: () => void) {
  sync();
  const fromOtherTab = (e: StorageEvent) => {
    if (owner !== undefined && e.key === cacheKey(owner)) {
      chosen = { ...readCache(owner), ...pending };
      onChange();
    }
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", fromOtherTab);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", fromOtherTab);
  };
}

export function setPreference<K extends PreferenceKey>(key: K, value: Preferences[K]) {
  if (owner === undefined) sync();
  if (!VALID[key](value) || chosen[key] === value) return;
  chosen = { ...chosen, [key]: value };
  writeCache();
  notify();
  if (owner) {
    pending = { ...pending, [key]: value };
    scheduleSave();
  }
}

/** One setting and a way to change it, kept in step across every component
 * and tab using it. ``fallback`` stands in until the reader chooses. The
 * server render, and the first one in the browser, use the fallback too. */
export function usePreference<K extends PreferenceKey>(key: K, fallback: Preferences[K]) {
  const value = useSyncExternalStore(subscribe, () => chosen[key], () => undefined) as Preferences[K] | undefined;
  const set = useCallback((next: Preferences[K]) => setPreference(key, next), [key]);
  return [value ?? fallback, set] as const;
}
