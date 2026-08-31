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
