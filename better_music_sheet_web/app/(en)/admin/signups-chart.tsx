"use client";

import { useEffect, useRef, useState } from "react";
import type { AdminSignupDay } from "@/lib/admin";
import { LoadState, useAdminData } from "./admin-parts";

const RANGES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
] as const;

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 36 };

/** Round steps for the y axis - 1, 2, 5, 10, 20... - so its labels are
 * whole numbers of people. */
function ticks(max: number) {
  let step = 1;
  for (let i = 1; max / step > 5; i++) step = [1, 2, 5][i % 3] * 10 ** Math.floor(i / 3);
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

function dayLabel(day: string, long = false) {
  // Noon UTC, so no time zone can move it onto another day.
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    month: "short", day: "numeric", ...(long ? { year: "numeric", weekday: "short" } : {}), timeZone: "UTC",
  });
}

/** New accounts per day, each day midnight to midnight where the admin is. */
export function SignupsChart() {
  const [days, setDays] = useState<number>(30);
  // Minutes east of UTC; getTimezoneOffset counts the other way.
  const offset = -new Date().getTimezoneOffset();
  const { data, error, loading, reload } = useAdminData<AdminSignupDay[]>(`/users/signups?days=${days}&offset=${offset}`);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const rows = data ?? [];
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const scale = ticks(Math.max(1, ...rows.map((row) => row.count)));
  const top = scale[scale.length - 1];
  const plotW = Math.max(0, width - PAD.left - PAD.right), plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = rows.length ? plotW / rows.length : 0;
  const gap = slot > 6 ? 2 : slot > 3 ? 1 : 0;
  const barW = Math.max(1, slot - gap);
  const y = (value: number) => PAD.top + plotH - (value / top) * plotH;
  // About one date label per 80px, always including the last day.
  const every = Math.max(1, Math.ceil(80 / Math.max(slot, 1)));
  const shown = rows.find((_, i) => i === hover);

  return (
    <div className="admin-chart">
      <div className="admin-toolbar">
        <div>
          <h2 className="admin-heading admin-chart-title">New users per day</h2>
          <div className="admin-sub">{data ? `${total.toLocaleString()} in the last ${days} days` : " "}</div>
        </div>
        <div className="admin-toolbar-end">
          <div className="admin-filters">
            {RANGES.map((range) => (
              <button key={range.days} type="button" className={days === range.days ? "active" : ""}
                onClick={() => { setDays(range.days); setHover(null); }}>{range.label}</button>
            ))}
          </div>
          <LoadState loading={loading} error={error} onReload={reload} />
        </div>
      </div>
      <div ref={box} className="admin-chart-plot" onMouseLeave={() => setHover(null)}>
        {width > 0 && data && (
          <svg width={width} height={HEIGHT} role="img"
            aria-label={`New users per day: ${total} over the last ${rows.length} days`}>
            {scale.map((value) => (
              <g key={value}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)}
                  className={value ? "admin-chart-grid" : "admin-chart-axis"} />
                <text x={PAD.left - 8} y={y(value)} dy="0.32em" textAnchor="end" className="admin-chart-label">{value}</text>
              </g>
            ))}
            {rows.map((row, i) => {
              const x = PAD.left + i * slot + gap / 2;
              const h = y(0) - y(row.count);
              const last = i === rows.length - 1;
              return (
                <g key={row.date}>
                  {row.count > 0 && (
                    <path className={`admin-chart-bar${hover === i ? " hover" : ""}`}
                      d={roundedTop(x, y(row.count), barW, h, Math.min(4, barW / 2, h))} />
                  )}
                  {(i % every === (rows.length - 1) % every) && (last || rows.length - 1 - i >= every / 2) && (
                    <text x={x + barW / 2} y={HEIGHT - 8} textAnchor={last ? "end" : "middle"}
                      className="admin-chart-label">{dayLabel(row.date)}</text>
                  )}
                  {/* The whole column is the hover target, not just the bar. */}
                  <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="transparent"
                    onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
        )}
        {shown && hover !== null && (
          <div className="admin-chart-tip" style={{
            left: Math.min(Math.max(PAD.left + (hover + 0.5) * slot, 70), width - 70),
            top: Math.max(0, y(shown.count) - 48),
          }}>
            <div className="admin-sub">{dayLabel(shown.date, true)}</div>
            <strong>{shown.count.toLocaleString()}</strong> new {shown.count === 1 ? "user" : "users"}
          </div>
        )}
      </div>
    </div>
  );
}

/** A bar standing on the baseline, its top corners rounded. */
function roundedTop(x: number, top: number, w: number, h: number, r: number) {
  const bottom = top + h;
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bottom}Z`;
}
