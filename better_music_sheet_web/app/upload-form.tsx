"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { uploadSheet } from "@/lib/sheet-files";

type UploadOption = "style" | "fontSize" | "dpi" | "octave" | "autoRetry";

const OPTION_HELP: Record<UploadOption, string> = {
  style: "Unicode uses musical accidental symbols such as B♭ and C♯. ASCII uses plain-text Bb and C#, which can be easier to copy into older software.",
  fontSize: "Controls the printed note-label size. Larger labels are easier to read but have less room around dense chords.",
  dpi: "Controls the scan resolution used for recognition. Leave it on auto for most sheets; 300 DPI can help a blurry scan but takes longer to process.",
  octave: "Adds the scientific octave number to every label, such as B♭4. This identifies the exact piano key but makes each label longer.",
  autoRetry: "Automatically scans a page again at higher resolution when unusually few notes are found. It can improve difficult pages but increases processing time.",
};

export function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [style, setStyle] = useState<"unicode" | "ascii">("unicode");
  const [octave, setOctave] = useState(false);
  const [fontSize, setFontSize] = useState(6.5);
  const [dpi, setDpi] = useState("");
  const [autoRetry, setAutoRetry] = useState(true);
  const [openHelp, setOpenHelp] = useState<UploadOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setSubmitting(true);
    setError(null);

    try {
      const job_id = await uploadSheet(file, {
        style, octave, font_size: fontSize, auto_retry: autoRetry, dpi: dpi ? Number(dpi) : null,
      });
      router.push(`/sheets?job=${job_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const ready = !!file && !submitting;

  return (
    <div className="wrap">
      <h1 className="upload-h1">Upload your sheet music</h1>
      <p className="upload-sub">
        We read every note on your piano sheet music and pencil in the letter name so you can
        practice without guessing.
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
              <label htmlFor="dpi" className="main">Force DPI</label>
              <OptionHelp option="dpi" label="Force DPI" open={openHelp} onToggle={setOpenHelp} />
              <input
                id="dpi"
                type="number"
                min={150}
                max={300}
                step={50}
                placeholder="auto"
                value={dpi}
                onChange={(e) => setDpi(e.target.value)}
              />
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
              <label htmlFor="autoRetry">Auto re-scan under-recognized pages at higher DPI</label>
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
          title={!file ? "Choose a PDF or photo first" : submitting ? "Your sheet is being uploaded" : "Upload and annotate this sheet"}
        >
          {submitting ? "Uploading…" : "Upload"}
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
