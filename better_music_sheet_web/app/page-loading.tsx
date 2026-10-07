"use client";

import { BackButton } from "./back-button";
import { useI18n } from "@/lib/i18n/client";

/** A page's back button with "Loading…" (or ``text``) beside it - what a
 * sheet's pages show while they fetch what they need. */
export function PageLoading({ text, error = false }: { text?: string; error?: boolean }) {
  const { m } = useI18n();
  return (
    <div className="wrap">
      <div className="page-title-row">
        <BackButton />
        <p style={{ color: error ? "var(--danger)" : "var(--ink-soft)", margin: 0 }}>{text ?? m.common.loading}</p>
      </div>
    </div>
  );
}
