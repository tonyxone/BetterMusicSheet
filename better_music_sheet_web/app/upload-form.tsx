"use client";

import { useEffect, useState } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MAX_UPLOAD_BYTES, uploadSheet } from "@/lib/sheet-files";
import { useAuth } from "./auth-context";
import { refreshSubscription } from "@/lib/subscription";
import { resolveUploadAttempt } from "@/lib/upload-gate";
import { addFiles, combinePhotos, isPhoto, moveFile, removeFile } from "@/lib/photo-pages";

type UploadOption = "notation" | "style" | "fontSize" | "color" | "dpi" | "octave" | "autoRetry";

const OPTION_HELP: Record<UploadOption, string> = {
  notation: "Letter names each note C, D, E... Jianpu (numbered notation, 簡譜) shows a number instead: 1 = C, 2 = D, 3 = E, 4 = F, 5 = G, 6 = A, 7 = B in every key, so a number always means the same piano key - F♯ reads ♯4 and B♭ reads ♭7. You can switch between the two while viewing the sheet at any time; this sets the printed download.",
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
  const [notation, setNotation] = useState<"letters" | "numbers">("letters");
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
        style, octave, notation, font_size: fontSize, auto_retry: autoRetry, dpi: dpi ? Number(dpi) : null,
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
              <label htmlFor="notation" className="main">Note names</label>
              <OptionHelp option="notation" label="Note names" open={openHelp} onToggle={setOpenHelp} />
              <select id="notation" value={notation} onChange={(e) => setNotation(e.target.value as "letters" | "numbers")}>
                <option value="letters">Letter (C D E)</option>
                <option value="numbers">簡 Jianpu (1 2 3)</option>
              </select>
            </div>
            {openHelp === "notation" && <OptionExplanation option="notation" />}
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
  return (
    <>
      <DragDropProvider
        onDragEnd={(event) => {
          const { source } = event.operation;
          if (event.canceled || !isSortable(source)) return;
          onChange(moveFile(files, source.initialIndex, source.index));
        }}
      >
        <ol className="photo-pages" aria-label="Pages, in order">
          {files.map((file, index) => (
            <PhotoPage key={photoId(file)} file={file} index={index} disabled={disabled}
              onRemove={() => onChange(removeFile(files, index))} />
          ))}
        </ol>
      </DragDropProvider>
      {files.length > 1 && <p className="photo-pages-hint">Drag the pages into order.</p>}
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
        disabled={disabled} aria-label={`Remove page ${index + 1}`} title="Remove">✕</button>
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
