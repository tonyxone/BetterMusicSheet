import type { Subscription } from "./subscription";

/** How many sheets a free account uploads, ever - server.py's
 * FREE_SHEET_LIMIT, which the server enforces whatever this says. */
export const FREE_SHEET_LIMIT = 1;

export type UploadAttempt = { proceed: true } | { proceed: false; reason: "free-limit" };

/** How many of an account's sheets use up the free plan's upload. A failed
 * upload doesn't, so it can be retried; one deleted after it finished is
 * counted by the account's free_upload_used instead - the same rule as
 * server.py's _check_free_upload. */
export function keptSheets(jobs: { status: string }[]) {
  return jobs.filter((job) => !["failed", "deleting", "deleted"].includes(job.status)).length;
}

/** Whether a signed-in visitor's upload goes ahead, once their subscription
 * and sheets are known. Premium uploads freely; the free plan includes one
 * upload for good, so a free account that has a sheet - or had one and
 * deleted it - is told it has reached the limit. Pulled out of
 * app/upload-form.tsx as a plain function so this one decision has a test
 * that doesn't need to render the component. */
export function resolveUploadAttempt(subscription: Subscription, jobs: { status: string }[]): UploadAttempt {
  if (subscription.tier === "premium") return { proceed: true };
  if (subscription.free_upload_used || keptSheets(jobs) >= FREE_SHEET_LIMIT) return { proceed: false, reason: "free-limit" };
  return { proceed: true };
}
