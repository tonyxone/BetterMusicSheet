"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { uploadSheet } from "@/lib/sheet-files";
import { useAuth } from "./auth-context";
import { refreshSubscription } from "@/lib/subscription";
import { resolveUploadAttempt } from "@/lib/upload-gate";

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
  const [file, setFile] = useState<File | null>(null);
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
  async function checkAccountAndUpload() {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      const subscription = await refreshSubscription();
      const attempt = resolveUploadAttempt(subscription);
      if (!attempt.proceed) {
        router.push(attempt.redirectTo);
        return;
      }
      const job_id = await uploadSheet(file, {
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
    if (!file) return;
    if (!user) {
      openSignIn(() => void checkAccountAndUpload());
      return;
    }
    void checkAccountAndUpload();
  }

  const ready = !!file && !submitting;

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
        <label className={`dropzone${file ? " has-file" : ""}`}>
          <input
            type="file"
            accept="application/pdf,.pdf,image/jpeg,image/png,.jpg,.jpeg,.png"
            style={{ display: "none" }}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="icon">📄</div>
          <div className="title">{file ? file.name : "Drop a PDF or photo here, or click to browse"}</div>
          <div className="detail">
            {file ? `${(file.size / 1024).toFixed(0)} KB · ready to annotate` : "PDF, JPG, or PNG - one file at a time"}
          </div>
        </label>

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
          disabled={!file || submitting}
          title={
            !file ? "Choose a PDF or photo first"
            : submitting ? "Your sheet is being uploaded"
            : !user ? "Sign in to upload and annotate this sheet"
            : "Upload and annotate this sheet"
          }
        >
          {submitting ? "Uploading…" : !user && file ? "Sign in to upload" : "Upload"}
        </button>
      </form>
    </div>
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
