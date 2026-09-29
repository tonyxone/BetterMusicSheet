"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MAX_UPLOAD_BYTES, uploadSheet } from "@/lib/sheet-files";
import { useAuth } from "./auth-context";
import { refreshSubscription } from "@/lib/subscription";
import { resolveUploadAttempt } from "@/lib/upload-gate";
import { addFiles, combinePhotos, isPhoto, moveFile, removeFile } from "@/lib/photo-pages";

type UploadOption = "style" | "fontSize" | "color" | "dpi" | "octave" | "autoRetry";

const OPTION_HELP: Record<UploadOption, string> = {
  style: "Unicode uses musical accidental symbols such as B♭ and C♯. ASCII uses plain-text Bb and C#, which can be easier to copy into older software.",
  fontSize: "Controls the printed note-label size. Larger labels are easier to read but have less room around dense chords.",
  color: "Sets the printed colour of every note label. A colour makes the labels easy to tell apart from the printed music, while black keeps the page looking like the original. Pale colours can be hard to read on white paper.",
  dpi: "Controls the resolution used for recognition. Auto starts at 300 DPI and can re-read unclear pages using different recognition methods. A forced higher value takes longer and uses more memory.",
  octave: "Adds the scientific octave number to every label, such as B♭4. This identifies the exact piano key but makes each label longer.",
  autoRetry: "Automatically re-reads a page when notes are missing or its musical structure looks incomplete. It uses higher resolution where noteheads went undetected, and cheaper re-readings where they were found but could not be timed. It can improve difficult pages but increases processing time.",
};

/** Presets worth one click. All dark enough to read against the staff; the
 * picker beside them still allows anything at all. */
const LABEL_COLORS = [
  { value: "#000000", name: "Black" },
  { value: "#1451c4", name: "Blue" },
  { value: "#c62828", name: "Red" },
  { value: "#1b7a3e", name: "Green" },
  { value: "#6a3fb5", name: "Purple" },
];

/** ``heading`` off when the page around it already has a title of its own -
 *  the landing page introduces the site before the form, and two headlines
 *  saying the same thing is worse than either alone. */
export function UploadForm({ heading = true }: { heading?: boolean } = {}) {
  const router = useRouter();
  const { user, openSignIn } = useAuth();
  // One PDF, or one or more photos of the same score in page order - see
  // lib/photo-pages.ts. Several photos are put together into one sheet.
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [style, setStyle] = useState<"unicode" | "ascii">("unicode");
  const [octave, setOctave] = useState(false);
  const [fontSize, setFontSize] = useState(6.5);
  const [color, setColor] = useState("#000000");
  const [dpi, setDpi] = useState("");
  const [autoRetry, setAutoRetry] = useState(true);
  const [openHelp, setOpenHelp] = useState<UploadOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Uploading is a members feature (see server.py's upload routes) - a
  // signed-in account with an active subscription, checked fresh here
  // rather than trusted from whatever was cached before sign-in.
  const photos = files.length > 0 && files.every(isPhoto);
  const file = files.length === 1 ? files[0] : null;

  function choose(incoming: FileList | null) {
    const result = addFiles(files, Array.from(incoming ?? []));
    setFiles(result.files);
    setError(result.error);
  }

  async function checkAccountAndUpload() {
    if (!files.length) return;
    setSubmitting(true);
    setError(null);
    try {
      const subscription = await refreshSubscription();
      const attempt = resolveUploadAttempt(subscription);
      if (!attempt.proceed) {
        router.push(attempt.redirectTo);
        return;
      }
      // Several photos - or one too large to send as it is - go up as one
      // PDF, a page per photo in the order shown.
      let upload = files[0];
      if (photos && (files.length > 1 || upload.size > MAX_UPLOAD_BYTES)) {
        setPreparing(true);
        try {
          upload = await combinePhotos(files, MAX_UPLOAD_BYTES);
        } finally {
          setPreparing(false);
        }
      }
      const job_id = await uploadSheet(upload, {
        style, octave, font_size: fontSize, auto_retry: autoRetry, dpi: dpi ? Number(dpi) : null,
        color,
      });
      router.push(`/sheets?job=${job_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!files.length) return;
    if (!user) {
      openSignIn(() => void checkAccountAndUpload());
      return;
    }
    void checkAccountAndUpload();
  }

  const ready = files.length > 0 && !submitting;

  return (
    <div className={heading ? "wrap" : "wrap embedded"}>
      {heading && (
        <>
          <h1 className="upload-h1">Upload your sheet music</h1>
          <p className="upload-sub">
            We read every note on your piano sheet music and pencil in the letter name so you can
            practice without guessing.
          </p>
        </>
      )}

      <p className="upload-sub" style={{ marginTop: heading ? 6 : 0 }}>
        Uploading requires an account with an active subscription -{" "}
        <Link href="/subscription/plans" style={{ color: "var(--accent)" }}>see plans</Link>.
      </p>

      <form onSubmit={handleSubmit} style={{ marginTop: 40 }}>
        {/* A label, so a click opens the picker. Drops are handled here too:
            a hidden file input never receives a drop made on its label. */}
        <label
          className={`dropzone${files.length ? " has-file" : ""}${dragging ? " dragging" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files); }}
        >
          <input
            type="file"
            multiple
            accept="application/pdf,.pdf,image/jpeg,image/png,.jpg,.jpeg,.png"
            style={{ display: "none" }}
            // Cleared, so choosing the same file again still counts as a change.
            onChange={(e) => { choose(e.target.files); e.target.value = ""; }}
          />
          <div className="icon">📄</div>
          <div className="title">
            {!files.length ? "Drop a PDF or photos here, or click to browse"
              : photos && files.length > 1 ? `${files.length} photos · one sheet`
              : files[0].name}
          </div>
          {!files.length ? (
            <>
              <div className="detail">PDF, JPG, or PNG · up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB</div>
              <div className="detail">
                Several photos of one score become one sheet, a page each. A digital PDF gives the most accurate labels.
              </div>
            </>
          ) : photos ? (
            <div className="detail">Click or drop to add more pages, then put them in order below.</div>
          ) : file && (
            <div className="detail">
              {file.size > MAX_UPLOAD_BYTES
                ? `${(file.size / 1024 / 1024).toFixed(1)} MB · over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`
                : `${(file.size / 1024).toFixed(0)} KB · ready to annotate`}
            </div>
          )}
        </label>

        {photos ? (
          <PhotoPages files={files} onChange={setFiles} disabled={submitting} />
        ) : files.length > 0 && (
          <div className="picked-file">
            <button type="button" className="link-button" disabled={submitting}
              onClick={() => { setFiles([]); setError(null); }}>
              Remove this file
            </button>
          </div>
        )}

        <details className="options">
          <summary>Options</summary>
          <div>
            <div className="opt-row">
              <label htmlFor="style" className="main">Label style</label>
              <OptionHelp option="style" label="Label style" open={openHelp} onToggle={setOpenHelp} />
              <select id="style" value={style} onChange={(e) => setStyle(e.target.value as "unicode" | "ascii")}>
                <option value="unicode">Unicode (B♭, C♯)</option>
                <option value="ascii">ASCII (Bb, C#)</option>
              </select>
            </div>
            {openHelp === "style" && <OptionExplanation option="style" />}
            <div className="opt-row">
              <label htmlFor="fontSize" className="main">Font size</label>
              <OptionHelp option="fontSize" label="Font size" open={openHelp} onToggle={setOpenHelp} />
              <input
                id="fontSize"
                type="number"
                min={3}
                max={12}
                step={0.5}
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
              />
            </div>
            {openHelp === "fontSize" && <OptionExplanation option="fontSize" />}
            <div className="opt-row">
              <label htmlFor="color" className="main">Label colour</label>
              <OptionHelp option="color" label="Label colour" open={openHelp} onToggle={setOpenHelp} />
              <div className="opt-colors">
                {LABEL_COLORS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className={`swatch${color.toLowerCase() === preset.value ? " on" : ""}`}
                    style={{ background: preset.value }}
                    title={preset.name}
                    aria-label={preset.name}
                    aria-pressed={color.toLowerCase() === preset.value}
                    onClick={() => setColor(preset.value)}
                  />
                ))}
                {/* The presets are shortcuts, not the whole choice - this is
                    the control that makes any colour reachable. */}
                <input
                  id="color"
                  type="color"
                  value={color}
                  title="Choose any colour"
                  aria-label="Choose any colour"
                  onChange={(e) => setColor(e.target.value)}
                />
              </div>
            </div>
            {openHelp === "color" && <OptionExplanation option="color" />}
            <div className="opt-row">
              <label htmlFor="dpi" className="main">Force DPI</label>
              <OptionHelp option="dpi" label="Force DPI" open={openHelp} onToggle={setOpenHelp} />
              <select
                id="dpi"
                value={dpi}
                onChange={(e) => setDpi(e.target.value)}
              >
                <option value="">Auto (recommended)</option>
                {[200, 300, 400, 500, 600].map((value) => (
                  <option key={value} value={value}>{value} DPI</option>
                ))}
              </select>
            </div>
            {openHelp === "dpi" && <OptionExplanation option="dpi" />}
            <div className="opt-row checkbox">
              <input id="octave" type="checkbox" checked={octave} onChange={(e) => setOctave(e.target.checked)} />
              <label htmlFor="octave">Show octave number (B♭4)</label>
              <OptionHelp option="octave" label="Show octave number" open={openHelp} onToggle={setOpenHelp} />
            </div>
            {openHelp === "octave" && <OptionExplanation option="octave" />}
            <div className="opt-row checkbox">
              <input
                id="autoRetry"
                type="checkbox"
                checked={autoRetry}
                onChange={(e) => setAutoRetry(e.target.checked)}
              />
              <label htmlFor="autoRetry">Auto re-read unclear pages</label>
              <OptionHelp option="autoRetry" label="Auto re-scan" open={openHelp} onToggle={setOpenHelp} />
            </div>
            {openHelp === "autoRetry" && <OptionExplanation option="autoRetry" />}
          </div>
        </details>

        {error && <p style={{ color: "var(--danger)", marginTop: 16, fontSize: 14 }}>{error}</p>}

        <button
          type="submit"
          className={`btn-block${ready ? " ready" : ""}`}
          disabled={!files.length || submitting}
          title={
            !files.length ? "Choose a PDF or photos first"
            : submitting ? "Your sheet is being uploaded"
            : !user ? "Sign in to upload and annotate this sheet"
            : "Upload and annotate this sheet"
          }
        >
          {preparing ? "Preparing pages…" : submitting ? "Uploading…" : !user && files.length ? "Sign in to upload" : "Upload"}
        </button>
      </form>
    </div>
  );
}

// A stable identity and one preview per photo, however the list is reordered.
// Keyed by position, a row would be rebuilt mid-drag - and lose the drag.
const photoIds = new WeakMap<File, string>();
const photoPreviews = new WeakMap<File, string>();
let nextPhotoId = 0;

function photoId(file: File) {
  let id = photoIds.get(file);
  if (!id) photoIds.set(file, id = `photo-${nextPhotoId++}`);
  return id;
}

function photoPreview(file: File) {
  let url = photoPreviews.get(file);
  if (!url) photoPreviews.set(file, url = URL.createObjectURL(file));
  return url;
}

function releasePreview(file: File) {
  const url = photoPreviews.get(file);
  if (url) URL.revokeObjectURL(url);
  photoPreviews.delete(file);
}

/** The chosen photos in page order: drag a page to move it, ✕ to remove it.
 * Pointer events rather than the browser's own drag and drop, which most
 * phones don't support. With a mouse a page is picked up anywhere; by touch
 * only by its grip, so the rest of the list still scrolls. The grip also
 * takes the arrow keys. */
function PhotoPages({ files, onChange, disabled }: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled: boolean;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  // Where the page being dragged sits right now; null when none is.
  const [dragging, setDragging] = useState<number | null>(null);
  const dragged = useRef<number | null>(null);
  // The drag is followed on the window, not the rows: a row moved in the list
  // loses the pointer, and a release outside the list must still end it.
  // These are what those window listeners read, kept current as rows move.
  const latest = useRef({ files, onChange });
  useEffect(() => { latest.current = { files, onChange }; });
  const stopDragging = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDragging.current?.(), []);

  // Previews of photos no longer listed are released, and the rest when the
  // list goes.
  const listed = useRef<File[]>([]);
  useEffect(() => {
    for (const file of listed.current) if (!files.includes(file)) releasePreview(file);
    listed.current = files;
  }, [files]);
  useEffect(() => {
    const current = listed;
    return () => current.current.forEach(releasePreview);
  }, []);

  function pickUp(event: React.PointerEvent<HTMLLIElement>, index: number) {
    const target = event.target as HTMLElement;
    if (disabled || event.button !== 0 || dragged.current !== null || target.closest(".photo-remove")) return;
    if (event.pointerType !== "mouse" && !target.closest(".photo-grip")) return;
    event.preventDefault();
    dragged.current = index;
    setDragging(index);

    const pointer = event.pointerId;
    function drag(move: PointerEvent) {
      const from = dragged.current;
      if (move.pointerId !== pointer || from === null || !listRef.current) return;
      const rows = Array.from(listRef.current.children) as HTMLElement[];
      // It belongs after every other page whose middle the pointer is below.
      const to = rows.filter((row, i) => {
        const box = row.getBoundingClientRect();
        return i !== from && move.clientY > box.top + box.height / 2;
      }).length;
      if (to === from) return;
      const next = moveFile(latest.current.files, from, to);
      // Kept current straight away: another move can arrive before React
      // has rendered this one.
      latest.current = { ...latest.current, files: next };
      latest.current.onChange(next);
      dragged.current = to;
      setDragging(to);
    }
    function drop(end: PointerEvent) {
      if (end.pointerId === pointer) stop();
    }
    function stop() {
      window.removeEventListener("pointermove", drag);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", drop);
      stopDragging.current = null;
      dragged.current = null;
      setDragging(null);
    }
    window.addEventListener("pointermove", drag);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", drop);
    stopDragging.current = stop;
  }

  return (
    <>
      <ol ref={listRef} className="photo-pages" aria-label="Pages, in order">
        {files.map((file, index) => (
          <li key={photoId(file)} className={dragging === index ? "dragging" : undefined}
            onPointerDown={(event) => pickUp(event, index)}>
            <button type="button" className="photo-grip" disabled={disabled} title="Drag to reorder"
              aria-label={`Page ${index + 1}. Drag, or use the arrow keys, to move it`}
              onKeyDown={(event) => {
                const by = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                if (!by) return;
                event.preventDefault();
                onChange(moveFile(files, index, index + by));
              }}>
              ⠿
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element -- a local preview, nothing to optimize */}
            <img src={photoPreview(file)} alt="" draggable={false} />
            <div className="photo-page-text">
              <strong>Page {index + 1}</strong>
              <span>{file.name}</span>
            </div>
            <button type="button" className="photo-remove" onClick={() => onChange(removeFile(files, index))}
              disabled={disabled} aria-label={`Remove page ${index + 1}`} title="Remove">✕</button>
          </li>
        ))}
      </ol>
      {files.length > 1 && <p className="photo-pages-hint">Drag the pages into order.</p>}
    </>
  );
}

function OptionHelp({ option, label, open, onToggle }: {
  option: UploadOption;
  label: string;
  open: UploadOption | null;
  onToggle: (option: UploadOption | null) => void;
}) {
  const expanded = open === option;
  return (
    <button
      type="button"
      className="option-help"
      title={OPTION_HELP[option]}
      aria-label={`About ${label}`}
      aria-expanded={expanded}
      aria-controls={`option-explanation-${option}`}
      onClick={() => onToggle(expanded ? null : option)}
    >
      ?
    </button>
  );
}

function OptionExplanation({ option }: { option: UploadOption }) {
  return (
    <p id={`option-explanation-${option}`} className="option-explanation" role="status">
      {OPTION_HELP[option]}
    </p>
  );
}
