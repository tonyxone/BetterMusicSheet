"use client";

import { useCallback, useEffect, useState } from "react";
import { adminGet, openUploadFile, type AdminPayment, type AdminSubscription, type AdminUpload } from "@/lib/admin";

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

export function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount);
  } catch {
    // An unknown code - show it as is rather than fail the row.
    return `${amount} ${currency.toUpperCase()}`;
  }
}

/** A day, without the time - for the span a payment covers. */
function day(value: number | null | undefined) {
  return value ? new Date(value * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
}

export type Tone = "good" | "bad" | "warn" | "info" | "muted";

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`admin-badge ${tone}`}>{children}</span>;
}

export function UploadStatus({ upload }: { upload: AdminUpload }) {
  const review = upload.status === "done" && !!upload.review_reasons?.length;
  const [tone, label]: [Tone, string] =
    review ? ["warn", "Warning"]
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
  if (subscription?.status === "past_due") return <Badge tone="bad">Past due</Badge>;
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
 * that span every account - and `filterRow` goes under the headings. */
export function UploadsTable({ uploads, showOwner = false, filterRow }: {
  uploads: AdminUpload[]; showOwner?: boolean; filterRow?: React.ReactNode;
}) {
  // With filters the table stays, so they can be loosened again.
  if (!uploads.length && !filterRow) return <p className="admin-sub">No uploads.</p>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Uploaded</th><th>Sheet</th>{showOwner && <th>Owner</th>}<th>Result</th>
            <th className="num">Time</th><th className="num">Size</th><th>Files</th>
          </tr>
          {filterRow}
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
                  <span className="admin-id">{upload.user_id}</span>
                  {upload.guest && <div><Badge tone="muted">Guest</Badge></div>}
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
      {!uploads.length && <p className="admin-sub admin-empty">No uploads match.</p>}
    </div>
  );
}

function PaymentStatus({ payment }: { payment: AdminPayment }) {
  if (payment.status === "refunded") return <Badge tone="muted">Refunded</Badge>;
  if (payment.status === "unpaid") return <Badge tone="bad">Unpaid</Badge>;
  return (
    <>
      <Badge tone="good">Paid</Badge>
      {payment.refunded > 0 && <div className="admin-sub">{money(payment.refunded, payment.currency)} refunded</div>}
    </>
  );
}

/** What each currency adds up to once refunds are taken off. */
function netTotals(payments: AdminPayment[]) {
  const totals = new Map<string, number>();
  for (const p of payments) {
    if (p.status === "unpaid") continue;
    totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.amount - p.refunded);
  }
  return [...totals].map(([currency, amount]) => money(amount, currency)).join(" + ");
}

/** Every charge for one account's subscription, newest first. */
export function PaymentsTable({ payments }: { payments: AdminPayment[] }) {
  if (!payments.length) return <p className="admin-sub">No payments yet.</p>;
  const paid = payments.filter((p) => p.status !== "unpaid").length;
  return (
    <>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>Paid</th><th className="num">Amount</th><th>Plan</th><th>Source</th><th>Covers</th><th>Status</th></tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td className="nowrap">
                  {date(p.paid_at ?? p.created_at)}
                  {!p.paid_at && <div className="admin-sub">Billed, not paid</div>}
                </td>
                <td className="num nowrap">{money(p.amount, p.currency)}</td>
                <td className="nowrap">
                  {p.plan === "yearly" ? "Yearly" : p.plan === "monthly" ? "Monthly" : "—"}
                  {p.plan_change && <div className="admin-sub">Plan change, prorated</div>}
                </td>
                <td className="nowrap">{p.platform === "apple" ? "Apple" : "Stripe"}</td>
                <td className="nowrap">{day(p.period_start)} – {day(p.period_end)}</td>
                <td><PaymentStatus payment={p} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="admin-sub">
        {paid} {paid === 1 ? "payment" : "payments"}{paid ? ` · ${netTotals(payments)} in total` : ""}
      </p>
    </>
  );
}

/** Previous / next through a paged list, with where you are in it. */
export function Pager({ page, pages, total, noun, onPage }: {
  page: number; pages: number; total: number; noun: string; onPage: (page: number) => void;
}) {
  if (!total) return null;
  return (
    <nav className="admin-pager" aria-label={`${noun} pages`}>
      <button type="button" className="pagination-btn" onClick={() => onPage(page - 1)} disabled={page <= 1}
        aria-label="Previous page">‹</button>
      <span className="admin-sub">Page {page} of {pages} · {total.toLocaleString()} {noun}</span>
      <button type="button" className="pagination-btn" onClick={() => onPage(page + 1)} disabled={page >= pages}
        aria-label="Next page">›</button>
    </nav>
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
