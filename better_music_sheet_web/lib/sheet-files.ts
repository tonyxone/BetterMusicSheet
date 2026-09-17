"use client";

import { clientApiFetch } from "./client-api";

/** What /assets reports. `original` is the file as uploaded and may be absent
 * (an older sheet, or one whose upload was cleaned up); `original_type` says
 * whether it is a PDF, which decides if Play can render it. */
export type SheetAssets = {
  direct: boolean;
  pdf: string | null;
  timeline: string | null;
  original?: string | null;
  original_type?: string | null;
};

export type SheetFileKind = "pdf" | "timeline" | "original";

const LEGACY_PATHS: Record<SheetFileKind, string> = {
  pdf: "download?inline=1",
  timeline: "timeline",
  original: "original",
};

export async function fetchSheetAssets(jobId: string): Promise<SheetAssets | null> {
  const assets = await clientApiFetch(`/api/sheets/${jobId}/assets`, { cache: "no-store" });
  if (!assets.ok) return null;
  return await assets.json() as SheetAssets;
}

/** Fetch credentials from our API, then bytes from S3 without forwarding the
 * user's Authorization/X-Guest-Id headers to another origin. No redirect. */
export async function fetchSheetFile(jobId: string, kind: SheetFileKind) {
  const assets = await clientApiFetch(`/api/sheets/${jobId}/assets`, { cache: "no-store" });
  // Allows the new UI to be published before the backend cutover.
  if (assets.status === 404) {
    return clientApiFetch(`/api/sheets/${jobId}/${LEGACY_PATHS[kind]}`);
  }
  if (!assets.ok) return assets;
  const data = await assets.json() as SheetAssets;
  // A backend that predates the original/annotated toggle answers /assets
  // without an "original" at all - fall back to the route rather than
  // reporting the sheet has no original, which would hide the toggle.
  const url = data[kind] ?? (kind === "original" && !("original" in data)
    ? `/api/sheets/${jobId}/original` : null);
  if (!url) return new Response("File not available", { status: 404 });
  return data.direct && url.startsWith("http")
    ? fetch(url, { credentials: "omit", cache: "no-store" })
    : clientApiFetch(url);
}

export async function uploadSheet(file: File, options: Record<string, string | number | boolean | null>) {
  const response = await clientApiFetch("/api/uploads", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, size: file.size, content_type: file.type, ...options }),
  });
  if (response.status === 404) {
    const body = new FormData();
    body.append("file", file);
    for (const [key, value] of Object.entries(options)) if (value !== null) body.append(key, String(value));
    const legacy = await clientApiFetch("/api/sheets", { method: "POST", body });
    await requireSuccess(legacy, "Upload failed");
    return (await legacy.json()).job_id as string;
  }
  await requireSuccess(response, "Could not prepare upload");
  const { job_id, upload } = await response.json() as {
    job_id: string; upload: { url: string; fields: Record<string, string> };
  };
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
  form.append("file", file); // S3 requires the file field last.
  const result = await fetch(upload.url, { method: "POST", body: form, credentials: "omit" });
  if (!result.ok) throw new Error("The file upload failed. Please try again. An unfinished upload expires after 15 minutes.");
  // Completion speeds up status visibility, but S3's durable notification and
  // reconciliation own delivery if the browser closes or this request fails.
  await clientApiFetch(`/api/uploads/${job_id}/complete`, { method: "POST" }).catch(() => undefined);
  return job_id;
}

async function requireSuccess(response: Response, fallback: string) {
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { detail?: unknown } | null;
  const detail = typeof body?.detail === "string" ? body.detail : `${fallback} (${response.status}). Check the file and options.`;
  throw new Error(detail);
}
