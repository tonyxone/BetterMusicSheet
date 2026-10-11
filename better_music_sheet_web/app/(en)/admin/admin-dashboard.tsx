"use client";

import { Fragment, useEffect, useState } from "react";
import { useAuth } from "../../auth-context";
import { clientApiFetch } from "@/lib/client-api";
import type {
  AdminOverview, AdminPage, AdminPayments, AdminSubscriptionState, AdminSubscriptions, AdminSystem, AdminUpload, AdminUploads, AdminUser,
} from "@/lib/admin";
import {
  Badge, LoadState, Pager, PaymentsTable, SubscriptionBadge, UploadsTable, date, duration, useAdminData, type Tone,
} from "./admin-parts";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "subscriptions", label: "Subscriptions" },
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
      {tab === "subscriptions" && <SubscriptionsTab />}
      {tab === "uploads" && <UploadsTab />}
      {tab === "system" && <SystemTab />}
    </div>
  );
}

/** A number with what it counts. Given `onClick` it becomes a button, and
 * `active` marks it as the filter in force. */
function Tile({ label, value, sub, onClick, active }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; onClick?: () => void; active?: boolean;
}) {
  const body = (
    <>
      <div className="admin-tile-label">{label}</div>
      <div className="admin-tile-value">{value}</div>
      {sub && <div className="admin-sub">{sub}</div>}
    </>
  );
  if (!onClick) return <div className="admin-tile">{body}</div>;
  return (
    <button type="button" className={`admin-tile admin-tile-button${active ? " active" : ""}`}
      aria-pressed={active} onClick={onClick}>
      {body}
    </button>
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

function UserPayments({ userId }: { userId: string }) {
  const { data, error, loading } = useAdminData<AdminPayments>(`/users/${encodeURIComponent(userId)}/payments`);
  const failure = error ?? data?.error;
  if (failure) return <p className="admin-error-text">{failure}</p>;
  if (!data) return <p className="admin-sub">{loading ? "Loading payments…" : ""}</p>;
  return (
    <>
      <PaymentsTable payments={data.payments} />
      {data.notes.map((note) => <p key={note} className="admin-sub">{note}</p>)}
    </>
  );
}

const WITHIN: Option[] = [
  { id: "", label: "Any time" },
  { id: "1", label: "Last 24 hours" },
  { id: "7", label: "Last 7 days" },
  { id: "30", label: "Last 30 days" },
  { id: "90", label: "Last 90 days" },
];

type Option = { id: string; label: string };

/** A column's filter, in the row under its heading. */
function ColumnSelect({ label, value, options, onChange }: {
  label: string; value: string; options: Option[]; onChange: (value: string) => void;
}) {
  return (
    <select className={`admin-col-filter${value ? " set" : ""}`} aria-label={`Filter by ${label}`}
      value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map(({ id, label: text }) => <option key={id} value={id}>{text}</option>)}
    </select>
  );
}

function ColumnSearch({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <input type="search" className={`admin-col-filter${value ? " set" : ""}`} placeholder="Search"
      aria-label={`Filter by ${label}`} value={value} onChange={(event) => onChange(event.target.value)} />
  );
}

/** Column filters, and turning them into the route's query. A change goes
 * back to the first page, since the old page number means nothing now. */
function useFilters<K extends string>(keys: readonly K[]) {
  const empty = Object.fromEntries(keys.map((key) => [key, ""])) as Record<K, string>;
  const [filters, setFilters] = useState(empty);
  const [page, setPage] = useState(1);
  const set = (key: K) => (value: string) => { setFilters((last) => ({ ...last, [key]: value })); setPage(1); };
  const any = keys.some((key) => filters[key]);
  const clear = () => { setFilters(empty); setPage(1); };
  const trimmed = Object.fromEntries(keys.map((key) => [key, filters[key].trim()]));
  return { filters, set, any, clear, page, setPage, query: query({ ...trimmed, page }) };
}

function ClearFilters({ any, clear }: { any: boolean; clear: () => void }) {
  return any ? <button type="button" className="admin-link admin-small-text" onClick={clear}>Clear filters</button> : null;
}

const PLANS: Option[] = [
  { id: "", label: "Any plan" },
  { id: "free", label: "Free" },
  { id: "master", label: "Master" },
  { id: "active", label: "Active" },
  { id: "trial", label: "On trial" },
  { id: "canceling", label: "Canceling" },
  { id: "past_due", label: "Past due" },
  { id: "canceled", label: "Ended" },
];

const UPLOAD_COUNTS: Option[] = [
  { id: "", label: "Any" },
  { id: "some", label: "Has uploads" },
  { id: "none", label: "None" },
  { id: "failed", label: "Has a failure" },
];

const USER_FILTERS = ["q", "joined", "plan", "subscribed", "canceled", "uploads"] as const;

function UsersTab() {
  const { filters, set, any, clear, setPage, query: search } = useFilters(USER_FILTERS);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useAdminData<AdminPage<AdminUser>>(`/users${search}`);
  const users = data?.items ?? [];
  return (
    <section>
      <div className="admin-toolbar">
        <ClearFilters any={any} clear={clear} />
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
              <tr className="admin-filter-row">
                <th><ColumnSearch label="user ID" value={filters.q} onChange={set("q")} /></th>
                <th><ColumnSelect label="joined" value={filters.joined} options={WITHIN} onChange={set("joined")} /></th>
                <th><ColumnSelect label="plan" value={filters.plan} options={PLANS} onChange={set("plan")} /></th>
                <th><ColumnSelect label="subscribed" value={filters.subscribed} options={WITHIN} onChange={set("subscribed")} /></th>
                <th><ColumnSelect label="canceled" value={filters.canceled} options={WITHIN} onChange={set("canceled")} /></th>
                <th><ColumnSelect label="uploads" value={filters.uploads} options={UPLOAD_COUNTS} onChange={set("uploads")} /></th>
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
                        <span className="admin-id">{u.user_id}</span>
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
                        <td colSpan={6}>
                          {/* Only an account that has subscribed has a store to ask. */}
                          {s && (
                            <>
                              <h3 className="admin-subheading">Payments</h3>
                              <UserPayments userId={u.user_id} />
                              <h3 className="admin-subheading">Uploads</h3>
                            </>
                          )}
                          <UserUploads userId={u.user_id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!users.length && <p className="admin-sub admin-empty">No users match.</p>}
        </div>
      )}
      {data && <Pager page={data.page} pages={data.pages} total={data.total} noun="users"
        onPage={(next) => { setPage(next); setOpen(null); }} />}
    </section>
  );
}

const STATES: { id: AdminSubscriptionState; label: string; sub: string; tone: Tone }[] = [
  { id: "active", label: "Active", sub: "Paying and renewing", tone: "good" },
  { id: "trial", label: "On trial", sub: "Free trial, set to renew", tone: "info" },
  { id: "canceling", label: "Canceling", sub: "Still Premium until the period ends", tone: "warn" },
  { id: "past_due", label: "Past due", sub: "A renewal payment failed", tone: "bad" },
  { id: "canceled", label: "Canceled", sub: "Canceled or expired, not Premium now", tone: "muted" },
];

function SubscriptionsTab() {
  const [state, setState] = useState<AdminSubscriptionState | "">("");
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useAdminData<AdminSubscriptions>(`/subscriptions${query({ state, page })}`);
  const choose = (next: AdminSubscriptionState | "") => { setState(next); setPage(1); };
  const rows = data?.items ?? [];
  return (
    <section>
      <div className="admin-toolbar">
        <div className="admin-filters">
          <button type="button" className={state === "" ? "active" : ""} onClick={() => choose("")}>All</button>
          {STATES.map(({ id, label }) => (
            <button key={id} type="button" className={state === id ? "active" : ""} onClick={() => choose(id)}>
              {label}
            </button>
          ))}
        </div>
        <LoadState loading={loading} error={error} onReload={reload} />
      </div>
      {data && (
        <div className="admin-tiles">
          {STATES.map(({ id, label, sub }) => (
            <Tile key={id} label={label} value={data.counts[id].toLocaleString()} sub={sub} />
          ))}
        </div>
      )}
      {data && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th><th>State</th><th>Plan</th><th>Started</th><th>Renews / ends</th><th>Canceled</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const state = STATES.find(({ id }) => id === s.state)!;
                return (
                <tr key={s.user_id}>
                  <td><span className="admin-id">{s.user_id}</span></td>
                  <td>
                    <Badge tone={state.tone}>{state.label}</Badge>
                    {s.state === "canceling" && s.status === "trialing" && <div className="admin-sub">During the trial</div>}
                  </td>
                  <td className="nowrap">
                    {s.plan === "yearly" ? "Yearly" : "Monthly"} · {s.platform === "apple" ? "Apple" : "Stripe"}
                  </td>
                  <td className="nowrap">{date(s.started_at)}</td>
                  <td className="nowrap">{date(s.state === "canceled" ? s.ended_at ?? s.current_period_end : s.current_period_end)}</td>
                  <td className="nowrap">{date(s.canceled_at)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <p className="admin-sub admin-empty">No subscriptions here.</p>}
        </div>
      )}
      {data && <Pager page={data.page} pages={data.pages} total={data.total} noun="subscriptions" onPage={setPage} />}
    </section>
  );
}

const RESULTS: Option[] = [
  { id: "", label: "Any result" },
  { id: "done", label: "Done" },
  { id: "warning", label: "Warning" },
  { id: "failed", label: "Failed" },
  { id: "active", label: "In progress" },
  { id: "deleted", label: "Deleted" },
];

const OWNERS: Option[] = [
  { id: "", label: "Anyone" },
  { id: "account", label: "Accounts" },
  { id: "guest", label: "Guests" },
];

const TIMES: Option[] = [
  { id: "", label: "Any" },
  { id: "60", label: "1 min or more" },
  { id: "300", label: "5 min or more" },
  { id: "900", label: "15 min or more" },
];

const SIZES: Option[] = [
  { id: "", label: "Any" },
  { id: "small", label: "Under 1 MB" },
  { id: "medium", label: "1–10 MB" },
  { id: "large", label: "Over 10 MB" },
];

const OUTCOMES = [
  { id: "", key: "processed", label: "Processed", sub: "Finished, whatever the result" },
  { id: "done", key: "done", label: "Done", sub: "No warnings" },
  { id: "warning", key: "warning", label: "Warning", sub: "Done, but flagged for review" },
  { id: "failed", key: "failed", label: "Failed", sub: "No sheet came out" },
] as const;

const UPLOAD_FILTERS = ["since", "sheet", "q", "owner", "status", "min_seconds", "size"] as const;

function UploadsTab() {
  const { filters, set, any, clear, setPage, query: search } = useFilters(UPLOAD_FILTERS);
  const { data, error, loading, reload } = useAdminData<AdminUploads>(`/uploads${search}`);
  const filterRow = (
    <tr className="admin-filter-row">
      <th><ColumnSelect label="upload time" value={filters.since} options={WITHIN} onChange={set("since")} /></th>
      <th><ColumnSearch label="sheet" value={filters.sheet} onChange={set("sheet")} /></th>
      <th>
        <ColumnSearch label="owner's user ID" value={filters.q} onChange={set("q")} />
        <ColumnSelect label="owner" value={filters.owner} options={OWNERS} onChange={set("owner")} />
      </th>
      <th><ColumnSelect label="result" value={filters.status} options={RESULTS} onChange={set("status")} /></th>
      <th><ColumnSelect label="time" value={filters.min_seconds} options={TIMES} onChange={set("min_seconds")} /></th>
      <th><ColumnSelect label="size" value={filters.size} options={SIZES} onChange={set("size")} /></th>
      <th />
    </tr>
  );
  return (
    <section>
      <div className="admin-toolbar">
        <ClearFilters any={any} clear={clear} />
        <LoadState loading={loading} error={error} onReload={reload} />
      </div>
      {data && (
        <div className="admin-tiles">
          {OUTCOMES.map(({ id, key, label, sub }) => (
            <Tile key={key} label={label} value={data.summary[key].toLocaleString()} sub={sub}
              active={filters.status === id} onClick={() => set("status")(id)} />
          ))}
        </div>
      )}
      {data && <UploadsTable uploads={data.items} showOwner filterRow={filterRow} />}
      {data && <Pager page={data.page} pages={data.pages} total={data.total} noun="uploads" onPage={setPage} />}
    </section>
  );
}

/** A route's query string, leaving out what isn't set. */
function query(params: Record<string, string | number>) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== "").map(([key, value]) => [key, String(value)]));
  return search.size ? `?${search}` : "";
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
