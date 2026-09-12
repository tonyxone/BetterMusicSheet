"use client";

import { clientApiFetch } from "./client-api";

/** Fetch credentials from our API, then bytes from S3 without forwarding the
 * user's Authorization/X-Guest-Id headers to another origin. No redirect. */
export async function fetchSheetFile(jobId: string, kind: "pdf" | "timeline") {
  const assets = await clientApiFetch(`/api/sheets/${jobId}/assets`, { cache: "no-store" });
  // Allows the new UI to be published before the backend cutover.
  if (assets.status === 404) {
    return clientApiFetch(`/api/sheets/${jobId}/${kind === "pdf" ? "download?inline=1" : "timeline"}`);
  }
  if (!assets.ok) return assets;
  const data = await assets.json() as { direct: boolean; pdf: string | null; timeline: string | null };
  const url = data[kind];
  if (!url) return new Response("File not available", { status: 404 });
  return data.direct ? fetch(url, { credentials: "omit", cache: "no-store" }) : clientApiFetch(url);
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
