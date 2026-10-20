"use client";

import { useEffect, useRef, useState } from "react";
import type { AdminEngagement } from "@/lib/admin";
import { duration } from "./admin-parts";
import { dayLabel, roundedTop, ticks } from "./signups-chart";

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 40 };
/** The surface left between the two parts of a day's bar. */
const SEAM = 2;

type Day = AdminEngagement["days"][number];

/** Minutes a day on the sheet page and on the practice page, stacked, each
 * day midnight to midnight where the admin is. */
export function EngagementChart({ days }: { days: Day[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const minutes = (seconds: number) => seconds / 60;
  const scale = ticks(Math.max(1, ...days.map((d) => Math.ceil(minutes(d.sheet_seconds + d.practice_seconds)))));
  const top = scale[scale.length - 1];
  const plotW = Math.max(0, width - PAD.left - PAD.right), plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = days.length ? plotW / days.length : 0;
  const gap = slot > 6 ? 2 : slot > 3 ? 1 : 0;
  const barW = Math.max(1, slot - gap);
  const y = (value: number) => PAD.top + plotH - (value / top) * plotH;
  const every = Math.max(1, Math.ceil(80 / Math.max(slot, 1)));
  const shown = hover === null ? undefined : days[hover];

  return (
    <div className="admin-chart">
      <div className="admin-toolbar">
        <div>
          <h2 className="admin-heading admin-chart-title">Minutes a day</h2>
          <div className="admin-sub">Time the page was in use: visible, and touched or playing</div>
        </div>
        <div className="admin-chart-legend">
          <span><i className="admin-chart-key sheet" />Sheet page</span>
          <span><i className="admin-chart-key practice" />Practice</span>
        </div>
      </div>
      <div ref={box} className="admin-chart-plot" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img"
            aria-label={`Minutes a day on the sheet page and practising, over the last ${days.length} days`}>
            {scale.map((value) => (
              <g key={value}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)}
                  className={value ? "admin-chart-grid" : "admin-chart-axis"} />
                <text x={PAD.left - 8} y={y(value)} dy="0.32em" textAnchor="end" className="admin-chart-label">{value}</text>
              </g>
            ))}
            {days.map((day, i) => {
              const x = PAD.left + i * slot + gap / 2;
              const sheet = minutes(day.sheet_seconds), practice = minutes(day.practice_seconds);
              const sheetTop = y(sheet), totalTop = y(sheet + practice);
              const last = i === days.length - 1;
              // The practice part sits on the sheet part, a seam of surface
              // between them; only the top of the whole bar is rounded.
              const practiceBottom = sheet > 0 ? sheetTop - SEAM : y(0);
              const practiceH = Math.max(0, practiceBottom - totalTop);
              return (
                <g key={day.date}>
                  {hover === i && <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} className="admin-chart-hover" />}
                  {sheet > 0 && (
                    <path className="admin-chart-bar sheet" d={practiceH > 0
                      ? `M${x},${y(0)}V${sheetTop}H${x + barW}V${y(0)}Z`
                      : roundedTop(x, sheetTop, barW, y(0) - sheetTop, Math.min(4, barW / 2, y(0) - sheetTop))} />
                  )}
                  {practiceH > 0 && (
                    <path className="admin-chart-bar practice"
                      d={roundedTop(x, totalTop, barW, practiceH, Math.min(4, barW / 2, practiceH))} />
                  )}
                  {(i % every === (days.length - 1) % every) && (last || days.length - 1 - i >= every / 2) && (
                    <text x={x + barW / 2} y={HEIGHT - 8} textAnchor={last ? "end" : "middle"}
                      className="admin-chart-label">{dayLabel(day.date)}</text>
                  )}
                  <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="transparent"
                    onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
        )}
        {shown && hover !== null && (
          <div className="admin-chart-tip" style={{
            left: Math.min(Math.max(PAD.left + (hover + 0.5) * slot, 90), width - 90),
            top: Math.max(0, y(minutes(shown.sheet_seconds + shown.practice_seconds)) - 92),
          }}>
            <div className="admin-sub">{dayLabel(shown.date, true)}</div>
            <div><i className="admin-chart-key sheet" />Sheet page <strong>{duration(shown.sheet_seconds)}</strong></div>
            <div>
              <i className="admin-chart-key practice" />Practice <strong>{duration(shown.practice_seconds)}</strong>
              {shown.playing_seconds > 0 && <span className="admin-sub"> · {duration(shown.playing_seconds)} playing</span>}
            </div>
            <div className="admin-sub">{shown.users.toLocaleString()} {shown.users === 1 ? "reader" : "readers"}</div>
          </div>
        )}
      </div>
    </div>
  );
}
