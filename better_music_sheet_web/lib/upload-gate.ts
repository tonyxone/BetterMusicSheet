import type { Subscription } from "./subscription";

/** How many sheets a free account keeps at a time - server.py's
 * FREE_SHEET_LIMIT, which the server enforces whatever this says. */
export const FREE_SHEET_LIMIT = 1;

export type UploadAttempt = { proceed: true } | { proceed: false; reason: "free-limit" };

/** How many of an account's sheets count against the free plan's limit. A
 * failed upload doesn't, so it can be retried or replaced; neither does one
 * on its way out - the same rule as server.py's _check_free_sheet_limit. */
export function keptSheets(jobs: { status: string }[]) {
  return jobs.filter((job) => !["failed", "deleting", "deleted"].includes(job.status)).length;
}

/** Whether a signed-in visitor's upload goes ahead, once their subscription
 * and sheets are known. Premium uploads freely; the free plan keeps one
 * sheet at a time, so a free account that has one is told to delete it
 * first. Pulled out of app/upload-form.tsx as a plain function so this one
 * decision has a test that doesn't need to render the component. */
export function resolveUploadAttempt(subscription: Subscription, jobs: { status: string }[]): UploadAttempt {
  if (subscription.tier === "premium") return { proceed: true };
  if (keptSheets(jobs) >= FREE_SHEET_LIMIT) return { proceed: false, reason: "free-limit" };
  return { proceed: true };
}
