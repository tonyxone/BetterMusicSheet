"use client";

import { useEffect, useState } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useRouter } from "next/navigation";
import { MAX_UPLOAD_BYTES, uploadSheet } from "@/lib/sheet-files";
import { useAuth } from "./auth-context";
import { clientApiFetch } from "@/lib/client-api";
import { refreshSubscription } from "@/lib/subscription";
import { resolveUploadAttempt } from "@/lib/upload-gate";
import { addFiles, combinePhotos, isPhoto, moveFile, removeFile } from "@/lib/photo-pages";
import { PremiumWindow } from "./(en)/subscription/premium-window";
import { useI18n } from "@/lib/i18n/client";
import { fmt, rich } from "@/lib/i18n/format";
import { translateKnown } from "@/lib/i18n/known-text";
import type { Messages } from "@/lib/i18n/messages/en";

type UploadOption = "notation" | "style" | "fontSize" | "color" | "dpi" | "octave" | "autoRetry";

/** Presets worth one click. All dark enough to read against the staff; the
 * picker beside them still allows anything at all. */
const LABEL_COLORS: { value: string; name: keyof Messages["upload"]["colours"] }[] = [
  { value: "#000000", name: "black" },
  { value: "#1451c4", name: "blue" },
  { value: "#c62828", name: "red" },
  { value: "#1b7a3e", name: "green" },
  { value: "#6a3fb5", name: "purple" },
];

/** ``heading`` off when the page around it already has a title of its own -
 *  the landing page introduces the site before the form, and two headlines
 *  saying the same thing is worse than either alone. */
export function UploadForm({ heading = true }: { heading?: boolean } = {}) {
  const router = useRouter();
  const { user, openSignIn } = useAuth();
  const { m, path } = useI18n();
  const t = m.upload;
  // One PDF, or one or more photos of the same score in page order - see
  // lib/photo-pages.ts. Several photos are put together into one sheet.
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [style, setStyle] = useState<"unicode" | "ascii">("unicode");
  const [octave, setOctave] = useState(false);
  const [notation, setNotation] = useState<"letters" | "numbers" | "solfege">("letters");
  const [fontSize, setFontSize] = useState(6.5);
  const [color, setColor] = useState("#000000");
  const [dpi, setDpi] = useState("");
  const [autoRetry, setAutoRetry] = useState(true);
  const [openHelp, setOpenHelp] = useState<UploadOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [atFreeLimit, setAtFreeLimit] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);

  // Uploading needs a signed-in account. Premium uploads freely; the free
  // plan keeps one sheet at a time (lib/upload-gate.ts). Both are checked
  // fresh here rather than trusted from whatever was cached before sign-in,
  // and server.py enforces the limit whatever this decides.
  const photos = files.length > 0 && files.every(isPhoto);
  const file = files.length === 1 ? files[0] : null;

  function choose(incoming: FileList | null) {
    const result = addFiles(files, Array.from(incoming ?? []));
    setFiles(result.files);
    setError(result.error && translateKnown(result.error, m));
  }

  async function checkAccountAndUpload() {
    if (!files.length) return;
    setSubmitting(true);
    setError(null);
    try {
      const [subscription, jobs] = await Promise.all([
        refreshSubscription(),
        // Unreadable, the list counts as empty: the server still refuses an
        // upload over the limit, and its message is shown like any error.
        clientApiFetch("/api/sheets").then((res) => (res.ok ? res.json() : [])).catch(() => []),
      ]);
      if (!resolveUploadAttempt(subscription, jobs).proceed) {
        setAtFreeLimit(true);
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
        style, octave, notation, font_size: fontSize, auto_retry: autoRetry, dpi: dpi ? Number(dpi) : null,
        color,
      });
      router.push(path(`/sheets?job=${job_id}`));
    } catch (err) {
      setError(translateKnown(err instanceof Error ? err.message : String(err), m));
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
          <h1 className="upload-h1">{t.heading}</h1>
          <p className="upload-sub">{t.sub}</p>
        </>
      )}

      <p className="upload-sub" style={{ marginTop: heading ? 6 : 0 }}>
        {rich(t.accountNote, {
          plans: (text) => <button type="button" className="inline-link" onClick={() => setPlansOpen(true)}>{text}</button>,
        })}
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
            {!files.length ? t.dropPrompt
              : photos && files.length > 1 ? fmt(t.photosOneSheet, { count: files.length })
              : files[0].name}
          </div>
          {!files.length ? (
            <>
              <div className="detail">{fmt(t.formats, { mb: MAX_UPLOAD_BYTES / 1024 / 1024 })}</div>
              <div className="detail">{t.photosHint}</div>
            </>
          ) : photos ? (
            <div className="detail">{t.addMorePages}</div>
          ) : file && (
            <div className="detail">
              {file.size > MAX_UPLOAD_BYTES
                ? fmt(t.overLimit, { size: (file.size / 1024 / 1024).toFixed(1), limit: MAX_UPLOAD_BYTES / 1024 / 1024 })
                : fmt(t.ready, { size: (file.size / 1024).toFixed(0) })}
            </div>
          )}
        </label>

        {photos ? (
          <PhotoPages files={files} onChange={setFiles} disabled={submitting} />
        ) : files.length > 0 && (
          <div className="picked-file">
            <button type="button" className="link-button" disabled={submitting}
              onClick={() => { setFiles([]); setError(null); }}>
              {t.removeFile}
            </button>
          </div>
        )}

        <details className="options">
          <summary>{t.options}</summary>
          <div>
            <div className="opt-row">
              <label htmlFor="notation" className="main">{t.noteNames}</label>
              <OptionHelp option="notation" label={t.noteNames} open={openHelp} onToggle={setOpenHelp} />
              <select id="notation" value={notation} onChange={(e) => setNotation(e.target.value as "letters" | "numbers" | "solfege")}>
                <option value="letters">{t.notationLetters}</option>
                <option value="numbers">{t.notationNumbers}</option>
                <option value="solfege">{t.notationSolfege}</option>
              </select>
            </div>
            {openHelp === "notation" && <OptionExplanation option="notation" />}
            <div className="opt-row">
              <label htmlFor="style" className="main">{t.labelStyle}</label>
              <OptionHelp option="style" label={t.labelStyle} open={openHelp} onToggle={setOpenHelp} />
              <select id="style" value={style} onChange={(e) => setStyle(e.target.value as "unicode" | "ascii")}>
                <option value="unicode">Unicode (B♭, C♯)</option>
                <option value="ascii">ASCII (Bb, C#)</option>
              </select>
            </div>
            {openHelp === "style" && <OptionExplanation option="style" />}
            <div className="opt-row">
              <label htmlFor="fontSize" className="main">{t.fontSize}</label>
              <OptionHelp option="fontSize" label={t.fontSize} open={openHelp} onToggle={setOpenHelp} />
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
              <label htmlFor="color" className="main">{t.labelColour}</label>
              <OptionHelp option="color" label={t.labelColour} open={openHelp} onToggle={setOpenHelp} />
              <div className="opt-colors">
                {LABEL_COLORS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className={`swatch${color.toLowerCase() === preset.value ? " on" : ""}`}
                    style={{ background: preset.value }}
                    title={t.colours[preset.name]}
                    aria-label={t.colours[preset.name]}
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
                  title={t.anyColour}
                  aria-label={t.anyColour}
                  onChange={(e) => setColor(e.target.value)}
                />
              </div>
            </div>
            {openHelp === "color" && <OptionExplanation option="color" />}
            <div className="opt-row">
              <label htmlFor="dpi" className="main">{t.forceDpi}</label>
              <OptionHelp option="dpi" label={t.forceDpi} open={openHelp} onToggle={setOpenHelp} />
              <select
                id="dpi"
                value={dpi}
                onChange={(e) => setDpi(e.target.value)}
              >
                <option value="">{t.dpiAuto}</option>
                {[200, 300, 400, 500, 600].map((value) => (
                  <option key={value} value={value}>{fmt(t.dpiValue, { dpi: value })}</option>
                ))}
              </select>
            </div>
            {openHelp === "dpi" && <OptionExplanation option="dpi" />}
            <div className="opt-row checkbox">
              <input id="octave" type="checkbox" checked={octave} onChange={(e) => setOctave(e.target.checked)} />
              <label htmlFor="octave">{t.showOctave}</label>
              <OptionHelp option="octave" label={t.showOctaveShort} open={openHelp} onToggle={setOpenHelp} />
            </div>
            {openHelp === "octave" && <OptionExplanation option="octave" />}
            <div className="opt-row checkbox">
              <input
                id="autoRetry"
                type="checkbox"
                checked={autoRetry}
                onChange={(e) => setAutoRetry(e.target.checked)}
              />
              <label htmlFor="autoRetry">{t.autoRetry}</label>
              <OptionHelp option="autoRetry" label={t.autoRetryShort} open={openHelp} onToggle={setOpenHelp} />
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
            !files.length ? t.chooseFirst
            : submitting ? t.beingUploaded
            : !user ? t.signInToAnnotate
            : t.uploadAndAnnotate
          }
        >
          {preparing ? t.preparingPages : submitting ? t.uploading : !user && files.length ? t.signInToUpload : t.submit}
        </button>
      </form>
      {atFreeLimit && (
        <FreeLimitNotice onClose={() => setAtFreeLimit(false)}
          onSeePlans={() => { setAtFreeLimit(false); setPlansOpen(true); }} />
      )}
      {plansOpen && <PremiumWindow onClose={() => setPlansOpen(false)} />}
    </div>
  );
}

/** A free account that already has a sheet: the free plan keeps one at a
 * time, so the way on is to delete it (or go Premium). The chosen file stays
 * picked, for straight after either. */
function FreeLimitNotice({ onClose, onSeePlans }: { onClose: () => void; onSeePlans: () => void }) {
  const { m } = useI18n();
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal-card delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="free-limit-title"
        style={{ textAlign: "left" }}>
        <button type="button" className="modal-close" onClick={onClose} title={m.common.close} aria-label={m.common.close}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
        <h2 id="free-limit-title" className="modal-title">{m.upload.freeLimitTitle}</h2>
        <p className="modal-sub">{m.upload.freeLimitBody}</p>
        <div className="modal-actions">
          <button type="button" className="btn-pill" onClick={onSeePlans}>{m.common.seePremiumPlans}</button>
        </div>
      </div>
    </div>
  );
}

// A stable identity per photo, however the list is reordered: keyed by
// position, a row would be rebuilt mid-drag.
const photoIds = new WeakMap<File, string>();
let nextPhotoId = 0;

function photoId(file: File) {
  let id = photoIds.get(file);
  if (!id) photoIds.set(file, id = `photo-${nextPhotoId++}`);
  return id;
}

// A small thumbnail per photo, made once. Showing the photo itself would have
// the browser redraw a 12-megapixel image at 44px in every row as they move.
// A data URL, so there is nothing to release afterwards.
const THUMB_WIDTH = 88, THUMB_HEIGHT = 112;
const thumbnails = new WeakMap<File, Promise<string>>();

function thumbnail(file: File) {
  let made = thumbnails.get(file);
  if (!made) {
    made = createImageBitmap(file, { imageOrientation: "from-image" }).then((bitmap) => {
      const canvas = document.createElement("canvas");
      canvas.width = THUMB_WIDTH;
      canvas.height = THUMB_HEIGHT;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
      // Cover the box, cropping the overflow, like object-fit: cover.
      const scale = Math.max(THUMB_WIDTH / bitmap.width, THUMB_HEIGHT / bitmap.height);
      const width = bitmap.width * scale, height = bitmap.height * scale;
      context.drawImage(bitmap, (THUMB_WIDTH - width) / 2, (THUMB_HEIGHT - height) / 2, width, height);
      bitmap.close();
      return canvas.toDataURL("image/jpeg", 0.8);
    });
    thumbnails.set(file, made);
  }
  return made;
}

/** The chosen photos in page order: drag a page to a new place, ✕ to remove it.
 *
 * dnd-kit (@dnd-kit/react) does the dragging: the page follows the pointer
 * and the others glide out of its way, then it settles where it's dropped.
 * With a mouse it moves after a few pixels; by touch after a short press and
 * hold, so a quick swipe still scrolls the page. By keyboard: Tab to a page,
 * Space to pick it up, the arrow keys to move it, Space to drop, Escape to
 * cancel - announced to screen readers. The list itself only changes on the
 * drop. */
function PhotoPages({ files, onChange, disabled }: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled: boolean;
}) {
  const { m } = useI18n();
  return (
    <>
      <DragDropProvider
        onDragEnd={(event) => {
          const { source } = event.operation;
          if (event.canceled || !isSortable(source)) return;
          onChange(moveFile(files, source.initialIndex, source.index));
        }}
      >
        <ol className="photo-pages" aria-label={m.upload.pagesInOrder} style={{
          "--page-before": JSON.stringify(m.upload.pageNumberBefore),
          "--page-after": JSON.stringify(m.upload.pageNumberAfter),
        } as React.CSSProperties}>
          {files.map((file, index) => (
            <PhotoPage key={photoId(file)} file={file} index={index} disabled={disabled}
              onRemove={() => onChange(removeFile(files, index))} />
          ))}
        </ol>
      </DragDropProvider>
      {files.length > 1 && <p className="photo-pages-hint">{m.upload.dragHint}</p>}
    </>
  );
}

function PhotoPage({ file, index, disabled, onRemove }: {
  file: File;
  index: number;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { ref, isDragging, isDropping } = useSortable({ id: photoId(file), index, disabled });
  const { m } = useI18n();
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    thumbnail(file).then((url) => { if (current) setPreview(url); }, () => { /* The row still works without one. */ });
    return () => { current = false; };
  }, [file]);
  return (
    <li ref={ref} className={isDragging || isDropping ? "dragging" : undefined}>
      <span className="photo-grip" aria-hidden="true">⠿</span>
      {preview
        // eslint-disable-next-line @next/next/no-img-element -- a local thumbnail, nothing to optimize
        ? <img src={preview} alt="" draggable={false} />
        : <span className="photo-thumb-placeholder" />}
      <div className="photo-page-text">
        {/* Numbered by CSS, not by index: it renumbers live as pages move
            during a drag, where the list itself only changes on the drop. */}
        <strong className="photo-page-number" />
        <span>{file.name}</span>
      </div>
      <button type="button" className="photo-remove" onClick={onRemove}
        disabled={disabled} aria-label={fmt(m.upload.removePage, { n: index + 1 })} title={m.upload.remove}>✕</button>
    </li>
  );
}

function OptionHelp({ option, label, open, onToggle }: {
  option: UploadOption;
  label: string;
  open: UploadOption | null;
  onToggle: (option: UploadOption | null) => void;
}) {
  const expanded = open === option;
  const { m } = useI18n();
  return (
    <button
      type="button"
      className="option-help"
      title={m.upload.help[option]}
      aria-label={fmt(m.upload.aboutOption, { label })}
      aria-expanded={expanded}
      aria-controls={`option-explanation-${option}`}
      onClick={() => onToggle(expanded ? null : option)}
    >
      ?
    </button>
  );
}

function OptionExplanation({ option }: { option: UploadOption }) {
  const { m } = useI18n();
  return (
    <p id={`option-explanation-${option}`} className="option-explanation" role="status">
      {m.upload.help[option]}
    </p>
  );
}
