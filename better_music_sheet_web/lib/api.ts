// Base URL of the backend API. Lives here rather than in client-api.ts so
// auth.ts can reach it too without importing the module that imports auth.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE!;

export type AnnotationJob = {
  job_id: string;
  music_sheet_id: string;
  status: "queued" | "processing" | "done" | "failed";
  sheet_name?: string;
  error: string | null;
  stage: string | null;
  labeled_groups: number | null;
  style: string;
  octave: boolean;
  font_size: number;
  dpi: number | null;
  created_at: number;
  updated_at: number;
};

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
