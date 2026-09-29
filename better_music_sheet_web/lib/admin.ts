"use client";

import { clientApiFetch } from "./client-api";

// Shapes of the admin dashboard's API (see ../../admin.py). Times are Unix
// seconds throughout, and null wherever something hasn't happened. People are
// identified by user id alone - no name or email ever reaches the dashboard.

export type AdminSubscription = {
  status: "trialing" | "active" | "canceled" | "expired" | "past_due";
  plan: "monthly" | "yearly";
  platform: "stripe" | "apple";
  started_at: number | null;
  current_period_end: number | null;
  cancel_at_period_end: boolean;
  /** When it stopped renewing. Recorded only from the dashboard's release on. */
  canceled_at: number | null;
  ended_at: number | null;
  /** Whether it grants Premium right now. */
  premium: boolean;
};

export type AdminUser = {
  user_id: string;
  created_at: number | null;
  master: boolean;
  subscription: AdminSubscription | null;
  uploads: number;
  failed: number;
  last_upload_at: number | null;
};

export type AdminUpload = {
  job_id: string;
  user_id: string;
  sheet_name: string | null;
  status: string;
  stage: string | null;
  error: string | null;
  /** Why the finished sheet was emailed as needing review. */
  review_reasons: string[] | null;
  created_at: number | null;
  updated_at: number | null;
  /** Queue to done, so it includes waiting for a worker to start. */
  seconds: number | null;
  size: number | null;
  attempts: number | null;
  region: string | null;
  /** Only on the all-uploads list: no signed-in account owns it. */
  guest?: boolean;
};

export type AdminOverview = {
  users: { total: number; new_7d: number; new_30d: number };
  subscriptions: { premium: number; trialing: number; canceling: number; stripe: number; apple: number; ended: number };
  uploads: {
    total: number; last_7d: number; last_30d: number; failed_30d: number; review_30d: number;
    failure_rate_30d: number | null; median_seconds_30d: number | null; in_progress: number;
  };
};

/** One page of a list, and where it sits in the whole. */
export type AdminPage<T> = { items: T[]; total: number; page: number; pages: number; page_size: number };

type Failure = { error: string };

export type AdminSystem = {
  region: string;
  now: number;
  queue: { waiting: number; in_flight: number; dead_letter: number } | Failure | null;
  workers: { desired: number; running: number; pending: number; task_definition: string } | Failure | null;
  active: AdminUpload[];
};

type AdminFiles = { direct: boolean; original: string | null; annotated: string | null };

export async function adminGet<T>(path: string): Promise<T> {
  const response = await clientApiFetch(`/api/admin${path}`);
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  return (await response.json()) as T;
}

/** Open an upload's original file or annotated result in a new tab. */
export async function openUploadFile(jobId: string, which: "original" | "annotated") {
  // Opened before any request, while this still counts as the click - a tab
  // opened after an await is what popup blockers stop.
  const tab = window.open("", "_blank");
  try {
    const files = await adminGet<AdminFiles>(`/uploads/${encodeURIComponent(jobId)}/files`);
    let url = files[which];
    if (!url) throw new Error(`This upload has no ${which} file.`);
    if (!files.direct) {
      // Local development: the file route needs the admin's token, which a
      // plain link can't carry.
      const response = await clientApiFetch(url);
      if (!response.ok) throw new Error(`The server answered ${response.status}.`);
      url = URL.createObjectURL(await response.blob());
    }
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (error) {
    tab?.close();
    throw error;
  }
}
