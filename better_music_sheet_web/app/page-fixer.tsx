"use client";

// Fitting a photographed page before it is uploaded: the photo, with the
// page's edges found (lib/page-edges.ts) and drawn over it, four corners to
// drag where they belong, and the page flattened to a rectangle on the way
// out (lib/page-photo.ts). Opened straight after the camera takes a photo,
// and from a photo's ⤢ button in the list of pages.

import { useCallback, useEffect, useRef, useState } from "react";
import { wholeFrame, type Point, type Quad } from "@/lib/page-edges";
import { asUploadable, detectPage, flattenPhoto, openPhoto, type PageFix } from "@/lib/page-photo";
import { checkUpload } from "@/lib/staff-check";
import { useI18n } from "@/lib/i18n/client";
import { rich } from "@/lib/i18n/format";

/** Where the corners start when no page was found: in from the photo's own
 * corners, where a finger can still take hold of them. */
const INSET = 0.08;
const CORNERS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
/** The magnifier shown while a corner is dragged: its size on screen, and how
 * much it enlarges. A finger covers exactly the spot it is placing. */
const LOUPE = 120, ZOOM = 3;

type Loaded = { bitmap: ImageBitmap; width: number; height: number };

export function PageFixer({ photo, fix, camera = false, onDone, onCancel, onRetake }: {
  /** The photo as taken - never a page already flattened from it. */
  photo: File;
  /** How the page was fitted last time, to start from. */
  fix: PageFix | null;
  camera?: boolean;
  /** The page to use: flattened, or the photo itself. */
  onDone: (page: File) => void;
  onCancel: () => void;
  onRetake?: () => void;
}) {
  const { m } = useI18n();
  const t = m.upload.camera;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [found, setFound] = useState(false);
  const [even, setEven] = useState(fix?.even ?? true);
  const [busy, setBusy] = useState<"working" | "checking" | null>(null);
  // A page just made from a camera photo in which no staff could be found -
  // offered back for a retake while the page is still at hand, rather than
  // found out minutes after uploading it (lib/staff-check.ts).
  const [review, setReview] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const [fit, setFit] = useState({ width: 0, height: 0 });

  useEffect(() => {
    let cancelled = false;
    let opened: ImageBitmap | null = null;
    openPhoto(photo).then(({ bitmap, width, height }) => {
      opened = bitmap;
      if (cancelled) { bitmap.close(); return; }
      const detected = fix ? null : detectPage(bitmap, width, height);
      setLoaded({ bitmap, width, height });
      setFound(!!(fix || detected));
      setQuad(fix?.quad ?? detected ?? inset(wholeFrame(width, height), width, height));
    }, () => { if (!cancelled) setError(t.failed); });
    return () => { cancelled = true; opened?.close(); };
  }, [photo, fix, t]);

  // The photo as large as the space allows, its shape kept.
  useEffect(() => {
    const box = stage.current;
    if (!box || !loaded) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const scale = Math.min(width / loaded.width, height / loaded.height);
      setFit({ width: Math.floor(loaded.width * scale), height: Math.floor(loaded.height * scale) });
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [loaded]);

  useEffect(() => {
    const canvas = preview.current;
    if (!canvas || !loaded || !fit.width) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(fit.width * ratio);
    canvas.height = Math.round(fit.height * ratio);
    canvas.getContext("2d")!.drawImage(loaded.bitmap, 0, 0, canvas.width, canvas.height);
  }, [loaded, fit]);

  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [busy, onCancel]);

  /** Photo pixels per screen pixel. */
  const k = loaded && fit.width ? loaded.width / fit.width : 1;

  const drawLoupe = useCallback((point: Point) => {
    const canvas = loupe.current;
    if (!canvas || !loaded) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.height = LOUPE * ratio;
    const context = canvas.getContext("2d")!;
    const span = (LOUPE / ZOOM) * k;
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(loaded.bitmap, (point.x - span / 2) * (loaded.bitmap.width / loaded.width),
      (point.y - span / 2) * (loaded.bitmap.height / loaded.height), span * (loaded.bitmap.width / loaded.width),
      span * (loaded.bitmap.height / loaded.height), 0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#ffffff";
    context.lineWidth = ratio;
    context.beginPath();
    context.moveTo(canvas.width / 2, 0); context.lineTo(canvas.width / 2, canvas.height);
    context.moveTo(0, canvas.height / 2); context.lineTo(canvas.width, canvas.height / 2);
    context.stroke();
  }, [loaded, k]);

  const move = useCallback((index: number, point: Point) => {
    if (!loaded) return;
    const clamped = { x: Math.min(loaded.width, Math.max(0, point.x)), y: Math.min(loaded.height, Math.max(0, point.y)) };
    setQuad((current) => current && (current.map((p, i) => (i === index ? clamped : p)) as Quad));
    setReview(null);
    drawLoupe(clamped);
  }, [loaded, drawLoupe]);

  function toPhoto(event: React.PointerEvent) {
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * loaded!.width, y: ((event.clientY - rect.top) / rect.height) * loaded!.height };
  }

  function keyMove(index: number, event: React.KeyboardEvent) {
    if (!quad || !loaded) return;
    const step = Math.max(loaded.width, loaded.height) * (event.shiftKey ? 0.02 : 0.004);
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    move(index, { x: quad[index].x + delta[0], y: quad[index].y + delta[1] });
  }

  async function finish(flatten: boolean) {
    if (!quad) return;
    setBusy("working");
    setError(null);
    setReview(null);
    try {
      const page = flatten ? await flattenPhoto(photo, { quad, even }) : await asUploadable(photo);
      if (camera) {
        setBusy("checking");
        // A check that can't run is no reason to hold the page back.
        const check = await checkUpload([page], () => false).catch(() => null);
        if (check?.unreadable.length) {
          setReview(page);
          setBusy(null);
          return;
        }
      }
      onDone(page);
    } catch {
      setError(t.failed);
      setBusy(null);
    }
  }

  const outline = quad?.map((p) => `${p.x},${p.y}`).join(" ");
  // Kept to the side away from the corner being placed, out from under the finger.
  const loupeRight = active !== null && quad && loaded && quad[active].x < loaded.width / 2;

  return (
    <div className="page-fixer" role="dialog" aria-modal="true" aria-labelledby="page-fixer-title">
      <div className="page-fixer-head">
        <h2 id="page-fixer-title">{t.title}</h2>
        {review
          ? <p role="alert" className="page-fixer-warning">{rich(t.unreadable, { b: (text) => <strong>{text}</strong> })}</p>
          : <p role="status">{error ?? (loaded ? (found ? t.found : t.notFound) : "")}</p>}
      </div>
      <div className="page-fixer-stage" ref={stage}>
        {loaded && quad && fit.width > 0 && (
          <div className="page-fixer-photo" style={{ width: fit.width, height: fit.height }}>
            <canvas ref={preview} style={{ width: fit.width, height: fit.height }} />
            <svg viewBox={`0 0 ${loaded.width} ${loaded.height}`} width={fit.width} height={fit.height}
              onPointerMove={(e) => { if (active !== null) move(active, toPhoto(e)); }}
              onPointerUp={() => setActive(null)} onPointerCancel={() => setActive(null)}>
              {/* Everything outside the page dimmed: what will be cut away. */}
              <path className="page-fixer-shade" fillRule="evenodd"
                d={`M0,0H${loaded.width}V${loaded.height}H0Z M${outline!.replaceAll(" ", " L")}Z`} />
              <polygon className="page-fixer-edge" points={outline} strokeWidth={2 * k} />
              {quad.map((p, i) => (
                <g key={CORNERS[i]} className={`page-fixer-corner${active === i ? " active" : ""}`} tabIndex={0}
                  role="button" aria-label={`${t.corners[CORNERS[i]]}. ${t.cornerKeys}`}
                  onKeyDown={(e) => keyMove(i, e)}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    (e.currentTarget.ownerSVGElement ?? e.currentTarget).setPointerCapture?.(e.pointerId);
                    setActive(i);
                    drawLoupe(p);
                  }}>
                  {/* A target bigger than it looks, for a fingertip. */}
                  <circle cx={p.x} cy={p.y} r={24 * k} className="page-fixer-hit" />
                  <circle cx={p.x} cy={p.y} r={9 * k} strokeWidth={2.5 * k} />
                </g>
              ))}
            </svg>
            <canvas ref={loupe} className={`page-fixer-loupe${loupeRight ? " right" : ""}`}
              style={{ display: active === null ? "none" : "block", width: LOUPE, height: LOUPE }} aria-hidden="true" />
          </div>
        )}
      </div>
      <div className="page-fixer-foot">
        <label className="page-fixer-even">
          <input type="checkbox" checked={even} disabled={!!busy}
            onChange={(e) => { setEven(e.target.checked); setReview(null); }} />
          {t.evenLighting}
        </label>
        <div className="page-fixer-actions">
          <button type="button" className="link-button" onClick={onCancel} disabled={!!busy}>{m.common.cancel}</button>
          {review ? (
            <>
              <button type="button" className="btn-pill ghost" onClick={() => onDone(review)}>{t.useAnyway}</button>
              {onRetake && <button type="button" className="btn-pill" onClick={onRetake}>{t.retake}</button>}
            </>
          ) : (
            <>
              {camera && onRetake && (
                <button type="button" className="btn-pill ghost" onClick={onRetake} disabled={!!busy}>{t.retake}</button>
              )}
              <button type="button" className="btn-pill ghost" onClick={() => void finish(false)} disabled={!!busy || !loaded}>
                {t.whole}
              </button>
              <button type="button" className="btn-pill" onClick={() => void finish(true)} disabled={!!busy || !quad}>
                {busy === "checking" ? t.checking : busy ? t.working : t.use}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function inset(quad: Quad, width: number, height: number): Quad {
  const dx = width * INSET, dy = height * INSET;
  const [tl, tr, br, bl] = quad;
  return [{ x: tl.x + dx, y: tl.y + dy }, { x: tr.x - dx, y: tr.y + dy }, { x: br.x - dx, y: br.y - dy }, { x: bl.x + dx, y: bl.y - dy }];
}
