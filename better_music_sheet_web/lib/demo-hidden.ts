import { clientApiFetch } from "./client-api";

const STORAGE_KEY = "bms-demo-hidden";

/** Guests: kept in this browser's localStorage, since there's no account to
 * attach it to (see app/demo-sample-card.tsx, which reads this only for a
 * signed-out visitor). */
export function readLocalDemoHidden(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeLocalDemoHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* Storage is optional. */ }
}

/** Signed-in accounts: persisted server-side against the account (see
 * server.py's /api/me/demo-hidden), so it follows them across devices. A
 * failed read is treated as "not hidden" - the same fail-open the rest of
 * the subscription/profile fetches in this app use. */
export async function fetchDemoHidden(): Promise<boolean> {
  const response = await clientApiFetch("/api/me/demo-hidden");
  if (!response.ok) return false;
  const data = await response.json() as { hidden: boolean };
  return Boolean(data.hidden);
}

export async function saveDemoHidden(hidden: boolean): Promise<void> {
  await clientApiFetch("/api/me/demo-hidden", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hidden }),
  });
}
