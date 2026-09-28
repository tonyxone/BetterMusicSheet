"use client";

import { useCallback, useEffect, useState } from "react";
import { adminGet, openUploadFile, type AdminSubscription, type AdminUpload } from "@/lib/admin";

/** Load an admin route; `reload` fetches it again. While reloading, the last
 * answer stays on screen rather than blanking the tab. */
export function useAdminData<T>(path: string) {
  const [version, setVersion] = useState(0);
  const key = `${path}#${version}`;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    adminGet<T>(path).then(
      (data) => { if (!cancelled) setResult({ key, data }); },
      (error: Error) => { if (!cancelled) setResult((last) => ({ key, data: last?.data, error: error.message })); },
    );
    return () => { cancelled = true; };
  }, [key, path]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data: result?.data, error: result?.error, loading: result?.key !== key, reload };
}

export function date(value: number | null | undefined) {
  return value ? new Date(value * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) : "—";
}

export function duration(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function bytes(value: number | null | undefined) {
  if (!value) return "—";
  return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

type Tone = "good" | "bad" | "warn" | "info" | "muted";

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`admin-badge ${tone}`}>{children}</span>;
}

export function UploadStatus({ upload }: { upload: AdminUpload }) {
  const review = upload.status === "done" && !!upload.review_reasons?.length;
  const [tone, label]: [Tone, string] =
    review ? ["warn", "Needs review"]
    : upload.status === "done" ? ["good", "Done"]
    : upload.status === "failed" ? ["bad", "Failed"]
    : upload.status === "deleted" || upload.status === "deleting" ? ["muted", "Deleted"]
    : ["info", upload.stage || upload.status];
  return (
    <>
      <Badge tone={tone}>{label}</Badge>
      {upload.status === "failed" && upload.error && <div className="admin-sub">{upload.error}</div>}
      {review && upload.review_reasons!.map((reason) => <div key={reason} className="admin-sub">{reason}</div>)}
    </>
  );
}

export function SubscriptionBadge({ subscription, master }: { subscription: AdminSubscription | null; master: boolean }) {
  if (subscription?.premium) {
    const plan = subscription.plan === "yearly" ? "Yearly" : "Monthly";
    const store = subscription.platform === "apple" ? "Apple" : "Stripe";
    if (subscription.cancel_at_period_end) return <Badge tone="warn">Canceling · {plan} · {store}</Badge>;
    return <Badge tone="good">{subscription.status === "trialing" ? "Trial" : plan} · {store}</Badge>;
  }
  if (master) return <Badge tone="info">Master</Badge>;
  if (subscription) return <Badge tone="muted">Ended</Badge>;
  return <Badge tone="muted">Free</Badge>;
}

function FileButton({ jobId, which }: { jobId: string; which: "original" | "annotated" }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="admin-link" onClick={() => {
        setError(null);
        openUploadFile(jobId, which).catch((reason: Error) => setError(reason.message));
      }}>
        {which === "original" ? "Original" : "Annotated"}
      </button>
      {error && <div className="admin-sub admin-error-text">{error}</div>}
    </>
  );
}

/** Uploads as a table. `showOwner` adds who uploaded each one - for the lists
 * that span every account. */
export function UploadsTable({ uploads, showOwner = false }: { uploads: AdminUpload[]; showOwner?: boolean }) {
  if (!uploads.length) return <p className="admin-sub">No uploads.</p>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Uploaded</th><th>Sheet</th>{showOwner && <th>Owner</th>}<th>Result</th>
            <th className="num">Time</th><th className="num">Size</th><th>Files</th>
          </tr>
        </thead>
        <tbody>
          {uploads.map((upload) => (
            <tr key={upload.job_id}>
              <td className="nowrap">{date(upload.created_at)}</td>
              <td>
                {upload.sheet_name || "—"}
                <div className="admin-sub admin-id">{upload.job_id}{upload.region ? ` · ${upload.region}` : ""}</div>
              </td>
              {showOwner && (
                <td>
                  {upload.guest ? <Badge tone="muted">Guest</Badge> : upload.owner_email || "—"}
                  <div className="admin-sub admin-id">{upload.user_id}</div>
                </td>
              )}
              <td><UploadStatus upload={upload} /></td>
              <td className="num nowrap">
                {duration(upload.seconds)}
                {!!upload.attempts && upload.attempts > 1 && <div className="admin-sub">{upload.attempts} attempts</div>}
              </td>
              <td className="num nowrap">{bytes(upload.size)}</td>
              <td className="nowrap">
                {upload.status !== "deleted" && <FileButton jobId={upload.job_id} which="original" />}
                {upload.status === "done" && <> · <FileButton jobId={upload.job_id} which="annotated" /></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LoadState({ loading, error, onReload }: { loading: boolean; error?: string; onReload: () => void }) {
  return (
    <div className="admin-toolbar-end">
      {error && <span className="admin-error-text">{error}</span>}
      <button type="button" className="btn-pill ghost admin-small" onClick={onReload} disabled={loading}>
        {loading ? "Loading…" : "Refresh"}
      </button>
    </div>
  );
}
