"use client";

import { useState } from "react";
import type { AnnotationJob } from "@/lib/api";
import { renameSheet, SheetRequestError } from "@/lib/sheet-files";
import { cleanTitle, sheetTitle, TITLE_MAX_LENGTH } from "@/lib/sheet-title";
import { useI18n } from "@/lib/i18n/client";
import { fmt } from "@/lib/i18n/format";
import { translateKnown } from "@/lib/i18n/known-text";

/** Renaming one of the reader's sheets, from the Library or the sheet
 * itself. Only the title changes on the server - the file stays as it was
 * uploaded. ``onRenamed`` gets the sheet back as the server now has it. */
export function RenameSheetDialog({ job, onRenamed, onClose }: {
  job: AnnotationJob;
  onRenamed: (job: AnnotationJob) => void;
  onClose: () => void;
}) {
  const { m } = useI18n();
  const t = m.sheet.rename;
  const [name, setName] = useState(sheetTitle(job));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (!saving) onClose();
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const title = cleanTitle(name);
    if (!title) {
      setError(t.empty);
      return;
    }
    if (title === sheetTitle(job)) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onRenamed(await renameSheet(job.job_id, title));
    } catch (err) {
      setError(err instanceof SheetRequestError
        ? translateKnown(err.detail, m) || fmt(t.failedStatus, { status: err.status })
        : t.failed);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="modal-card delete-modal" role="dialog" aria-modal="true" aria-labelledby="rename-title"
        style={{ textAlign: "left" }}>
        <button type="button" className="modal-close" onClick={close} disabled={saving}
          title={m.common.close} aria-label={m.common.close}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
        <h2 id="rename-title" className="modal-title">{t.title}</h2>
        <form onSubmit={(event) => void save(event)} style={{ marginTop: 18 }}>
          <label className="modal-field">
            <span>{t.label}</span>
            <input
              type="text"
              // The one field in the dialog, opened to be typed in.
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              maxLength={TITLE_MAX_LENGTH}
              value={name}
              onChange={(event) => { setName(event.target.value); setError(null); }}
              onKeyDown={(event) => { if (event.key === "Escape") close(); }}
              disabled={saving}
            />
          </label>
          {error && <div className="modal-error" role="alert">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-pill ghost" onClick={close} disabled={saving}>
              {m.common.cancel}
            </button>
            <button type="submit" className="btn-pill" disabled={saving}>
              {saving ? t.saving : t.save}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function RenameIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="rename-icon">
      <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
    </svg>
  );
}
