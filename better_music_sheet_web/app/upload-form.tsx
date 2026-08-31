"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApiFetch } from "@/lib/client-api";

export function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [style, setStyle] = useState<"unicode" | "ascii">("unicode");
  const [octave, setOctave] = useState(false);
  const [fontSize, setFontSize] = useState(6.5);
  const [dpi, setDpi] = useState("");
  const [autoRetry, setAutoRetry] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setSubmitting(true);
    setError(null);

    const body = new FormData();
    body.append("file", file);
    body.append("style", style);
    body.append("octave", String(octave));
    body.append("font_size", String(fontSize));
    body.append("auto_retry", String(autoRetry));
    if (dpi) body.append("dpi", dpi);

    try {
      const res = await clientApiFetch("/api/sheets", { method: "POST", body });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `upload failed (${res.status})`);
      }
      const { job_id } = await res.json();
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
              <select id="style" value={style} onChange={(e) => setStyle(e.target.value as "unicode" | "ascii")}>
                <option value="unicode">Unicode (B♭, C♯)</option>
                <option value="ascii">ASCII (Bb, C#)</option>
              </select>
            </div>
            <div className="opt-row">
              <label htmlFor="fontSize" className="main">Font size</label>
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
            <div className="opt-row">
              <label htmlFor="dpi" className="main">Force DPI</label>
              <input
                id="dpi"
                type="number"
                min={150}
                max={1200}
                step={50}
                placeholder="auto"
                value={dpi}
                onChange={(e) => setDpi(e.target.value)}
              />
            </div>
            <div className="opt-row checkbox">
              <input id="octave" type="checkbox" checked={octave} onChange={(e) => setOctave(e.target.checked)} />
              <label htmlFor="octave">Show octave number (B♭4)</label>
            </div>
            <div className="opt-row checkbox">
              <input
                id="autoRetry"
                type="checkbox"
                checked={autoRetry}
                onChange={(e) => setAutoRetry(e.target.checked)}
              />
              <label htmlFor="autoRetry">Auto re-scan under-recognized pages at higher DPI</label>
            </div>
          </div>
        </details>

        {error && <p style={{ color: "var(--danger)", marginTop: 16, fontSize: 14 }}>{error}</p>}

        <button type="submit" className={`btn-block${ready ? " ready" : ""}`} disabled={!file || submitting}>
          {submitting ? "Uploading…" : "Upload"}
        </button>
      </form>
    </div>
  );
}
