// The left/right hand balance for playback, from -1 (the left hand alone) to
// 1 (the right alone); 0 plays both as written. Kept per sheet and in this
// browser only: it suits practising one piece, not the reader in general.
import { useCallback, useSyncExternalStore } from "react";

const EVENT = "hand-balance-change";
// Stands in for browser storage where that is unavailable, so the slider
// still moves for as long as the page is open.
const memory = new Map<string, number>();

const storageKey = (jobId: string) => `hand-balance:${jobId}`;

function read(jobId: string): number {
  const held = memory.get(jobId);
  if (held !== undefined) return held;
  try {
    const value = Number(localStorage.getItem(storageKey(jobId)));
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  } catch {
    return 0;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useHandBalance(jobId: string) {
  const balance = useSyncExternalStore(subscribe, () => read(jobId), () => 0);
  const setBalance = useCallback((value: number) => {
    // Snaps to even near the middle, where a drag can't otherwise land.
    const next = Math.abs(value) < .08 ? 0 : Math.max(-1, Math.min(1, value));
    memory.set(jobId, next);
    try {
      if (next === 0) localStorage.removeItem(storageKey(jobId));
      else localStorage.setItem(storageKey(jobId), String(next));
    } catch { /* Browser storage may be unavailable. */ }
    window.dispatchEvent(new Event(EVENT));
  }, [jobId]);
  return [balance, setBalance] as const;
}
