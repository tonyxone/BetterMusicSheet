// Base URL of the backend API. Lives here rather than in client-api.ts so
// auth.ts can reach it too without importing the module that imports auth.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE!;

// The bundled sample job every visitor can play with no account and no
// subscription (see app/demo-sample-card.tsx and app/play/play-view.tsx).
// Must name the same job as the backend's config.DEMO_JOB_ID - the backend
// grants this one job id a read-only, no-auth carve-out (see server.py's
// _readable_job_or_404), and _seed_local.py's seed_demo() is what creates it.
export const DEMO_JOB_ID = "demo-ode-to-joy";

export type AnnotationJob = {
  job_id: string;
  music_sheet_id: string;
  status: "uploading" | "queued" | "processing" | "done" | "failed";
  sheet_name?: string;
  error: string | null;
  stage: string | null;
  labeled_groups: number | null;
  style: string;
  octave: boolean;
  /** Absent on jobs created before the option existed (letters). */
  notation?: "letters" | "numbers";
  font_size: number;
  dpi: number | null;
  /** "#rrggbb". Absent on jobs created before the option existed. */
  color?: string;
  created_at: number;
  updated_at: number;
  /** The upload can be shown - true as soon as it finishes, while the note
   * names are still being added and after that failed. Absent from older
   * backends, which only ever show a finished sheet. */
  original_ready?: boolean;
  /** A failed sheet whose upload is kept, so it can be read again. */
  can_retry?: boolean;
  /** Notes the reader named, and notes the sheet prints (null for a photo or
   * scan). Absent on sheets finished before they were recorded. */
  notes_named?: number | null;
  notes_printed?: number | null;
};

/** Still being uploaded or read - worth checking back on. */
export function isActive(job: Pick<AnnotationJob, "status">) {
  return job.status === "uploading" || job.status === "queued" || job.status === "processing";
}

export type MusicSheet = {
  music_sheet_id: string;
  sheet_name: string;
  created_at: number;
};

export type User = {
  user_id: string;
  email: string | null;
  /** Null for accounts created before names were required. */
  display_name: string | null;
  created_at: number;
};
