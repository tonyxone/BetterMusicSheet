import type { Subscription } from "./subscription";

export type UploadAttempt = { proceed: true } | { proceed: false; redirectTo: string };

/** Where a signed-in visitor's upload attempt goes once their subscription
 * is known - uploading is a members feature (see server.py's upload
 * routes), so only an active premium account proceeds; anyone else is sent
 * to the paywall instead of the upload going through. Pulled out of
 * app/upload-form.tsx as a plain function so this one decision has a test
 * that doesn't need to render the component. */
export function resolveUploadAttempt(subscription: Subscription): UploadAttempt {
  if (subscription.tier === "premium") return { proceed: true };
  return { proceed: false, redirectTo: "/subscription/upgrade" };
}
