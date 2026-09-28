"use client";

import { Fragment, useEffect, useState } from "react";
import { useAuth } from "../auth-context";
import { clientApiFetch } from "@/lib/client-api";
import type { AdminOverview, AdminSystem, AdminUpload, AdminUser } from "@/lib/admin";
import { LoadState, SubscriptionBadge, UploadsTable, date, duration, useAdminData } from "./admin-parts";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "uploads", label: "Uploads" },
  { id: "system", label: "System" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function tabFromHash(): Tab {
  const hash = typeof window === "undefined" ? "" : window.location.hash.slice(1);
  return TABS.find((tab) => tab.id === hash)?.id ?? "overview";
}

/** What anyone but an admin sees: the same thing as a page that doesn't
 * exist. The API is what actually keeps the data private (../../admin.py);
 * this only avoids advertising that there is anything here. */
function NotFound() {
  return (
    <div className="admin-not-found">
      <h1>404</h1>
      <p>This page could not be found.</p>
    </div>
  );
}

export function AdminDashboard() {
  const { user, loading } = useAuth();
  const userId = loading ? undefined : (user?.user_id ?? null);
  const [checked, setChecked] = useState<{ userId: string; admin: boolean } | null>(null);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    clientApiFetch("/api/admin/me").then(
      (response) => { if (!cancelled) setChecked({ userId, admin: response.ok }); },
      () => { if (!cancelled) setChecked({ userId, admin: false }); },
    );
    return () => { cancelled = true; };
  }, [userId]);

  // Nothing at all until it's known, so the dashboard never flashes at a
  // visitor and a 404 never flashes at the admin.
  if (userId === undefined || (userId && checked?.userId !== userId)) return null;
  if (!userId || !checked?.admin) return <NotFound />;
  return <Dashboard />;
}

function Dashboard() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  function choose(next: Tab) {
    setTab(next);
    // Kept in the URL so a reload stays on the same tab.
    window.history.replaceState(null, "", `#${next}`);
  }
  return (
    <div className="wrap wide admin-page">
      <div className="page-title-row"><h1 className="serif">Admin</h1></div>
      <div className="admin-tabs" role="tablist">
        {TABS.map(({ id, label }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id}
            className={tab === id ? "active" : ""} onClick={() => choose(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" && <OverviewTab />}
      {tab === "users" && <UsersTab />}
      {tab === "uploads" && <UploadsTab />}
      {tab === "system" && <SystemTab />}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="admin-tile">
      <div className="admin-tile-label">{label}</div>
      <div className="admin-tile-value">{value}</div>
      {sub && <div className="admin-sub">{sub}</div>}
    </div>
  );
}

function OverviewTab() {
  const { data, error, loading, reload } = useAdminData<AdminOverview>("/overview");
  return (
    <section>
      <div className="admin-toolbar"><LoadState loading={loading} error={error} onReload={reload} /></div>
      {data && (
        <div className="admin-tiles">
          <Tile label="Users" value={data.users.total.toLocaleString()}
            sub={`${data.users.new_7d} new this week · ${data.users.new_30d} in 30 days`} />
          <Tile label="Premium now" value={data.subscriptions.premium.toLocaleString()}
            sub={`${data.subscriptions.stripe} Stripe · ${data.subscriptions.apple} Apple · `
              + `${data.subscriptions.trialing} on trial · ${data.subscriptions.canceling} canceling`} />
          <Tile label="Subscriptions ended" value={data.subscriptions.ended.toLocaleString()}
            sub="Canceled or expired, not premium now" />
          <Tile label="Uploads, last 30 days" value={data.uploads.last_30d.toLocaleString()}
            sub={`${data.uploads.last_7d} this week · ${data.uploads.total} all time`} />
          <Tile label="Failure rate, last 30 days"
            value={data.uploads.failure_rate_30d == null ? "—" : `${Math.round(data.uploads.failure_rate_30d * 100)}%`}
            sub={`${data.uploads.failed_30d} failed · ${data.uploads.review_30d} need review`} />
          <Tile label="Median processing time" value={duration(data.uploads.median_seconds_30d)}
            sub="Queue to done, last 30 days" />
          <Tile label="In progress" value={data.uploads.in_progress.toLocaleString()}
            sub="Uploading, queued or processing" />
        </div>
      )}
    </section>
  );
}

function UserUploads({ userId }: { userId: string }) {
  const { data, error, loading } = useAdminData<AdminUpload[]>(`/users/${encodeURIComponent(userId)}/uploads`);
  if (error) return <p className="admin-error-text">{error}</p>;
  if (!data) return <p className="admin-sub">{loading ? "Loading uploads…" : ""}</p>;
  return <UploadsTable uploads={data} />;
}

function UsersTab() {
  const { data, error, loading, reload } = useAdminData<AdminUser[]>("/users");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const needle = search.trim().toLowerCase();
  const users = (data ?? []).filter((u) => !needle
    || [u.email, u.display_name, u.user_id].some((field) => field?.toLowerCase().includes(needle)));
  return (
    <section>
      <div className="admin-toolbar">
        <input type="search" className="admin-input" placeholder="Search email, name or user ID"
          value={search} onChange={(event) => setSearch(event.target.value)} />
        <LoadState loading={loading} error={error} onReload={reload} />
      </div>
      {data && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th><th>Joined</th><th>Plan</th><th>Subscribed</th><th>Canceled</th>
                <th className="num">Uploads</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const expanded = open === u.user_id;
                const s = u.subscription;
                return (
                  <Fragment key={u.user_id}>
                    <tr className="admin-row" aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : u.user_id)}>
                      <td>
                        <span className="admin-caret">{expanded ? "▾" : "▸"}</span>
                        {u.display_name || u.email || "—"}
                        {u.display_name && u.email && <div className="admin-sub">{u.email}</div>}
                        <div className="admin-sub admin-id">{u.user_id}</div>
                      </td>
                      <td className="nowrap">{date(u.created_at)}</td>
                      <td><SubscriptionBadge subscription={s} master={u.master} /></td>
                      <td className="nowrap">{date(s?.started_at)}</td>
                      <td className="nowrap">
                        {date(s?.canceled_at)}
                        {s?.ended_at && <div className="admin-sub">Ended {date(s.ended_at)}</div>}
                        {s?.cancel_at_period_end && s.premium && s.current_period_end &&
                          <div className="admin-sub">Access until {date(s.current_period_end)}</div>}
                      </td>
                      <td className="num">
                        {u.uploads}
                        {u.failed > 0 && <div className="admin-sub">{u.failed} failed</div>}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="admin-expanded">
                        <td colSpan={6}><UserUploads userId={u.user_id} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!users.length && <p className="admin-sub">No users match.</p>}
        </div>
      )}
    </section>
  );
}

const FILTERS = [
  { id: "", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "review", label: "Needs review" },
  { id: "active", label: "In progress" },
  { id: "done", label: "Done" },
  { id: "deleted", label: "Deleted" },
];

function UploadsTab() {
  const [filter, setFilter] = useState("");
  const { data, error, loading, reload } = useAdminData<AdminUpload[]>(
    `/uploads${filter ? `?status=${filter}` : ""}`);
  return (
    <section>
      <div className="admin-toolbar">
        <div className="admin-filters">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <LoadState loading={loading} error={error} onReload={reload} />
      </div>
      {data && <UploadsTable uploads={data} showOwner />}
    </section>
  );
}

function failed(panel: object | null): panel is { error: string } {
  return !!panel && "error" in panel;
}

function SystemTab() {
  const { data, error, loading, reload } = useAdminData<AdminSystem>("/system");
  const queue = data?.queue, workers = data?.workers;
  return (
    <section>
      <div className="admin-toolbar">
        <span className="admin-sub">{data ? `Region ${data.region}, as of ${date(data.now)}` : ""}</span>
        <LoadState loading={loading} error={error} onReload={reload} />
      </div>
      {data && (
        <>
          <div className="admin-tiles">
            {queue == null ? <Tile label="Queue" value="—" sub="Not used by this server" />
              : failed(queue) ? <Tile label="Queue" value="—" sub={queue.error} />
              : <>
                  <Tile label="Waiting in queue" value={queue.waiting} />
                  <Tile label="Being processed" value={queue.in_flight} />
                  <Tile label="Dead-letter queue" value={queue.dead_letter}
                    sub={queue.dead_letter ? "Messages the controller gave up on" : "Empty"} />
                </>}
            {workers == null ? <Tile label="Workers" value="—" sub="Not used by this server" />
              : failed(workers) ? <Tile label="Workers" value="—" sub={workers.error} />
              : <Tile label="Workers running" value={`${workers.running} of ${workers.desired}`}
                  sub={`${workers.pending} starting · ${workers.task_definition}`} />}
          </div>
          <h2 className="admin-heading">In progress</h2>
          <UploadsTable uploads={data.active} />
        </>
      )}
    </section>
  );
}
