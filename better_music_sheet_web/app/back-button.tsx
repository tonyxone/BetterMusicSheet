"use client";

import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";

// Sits inline beside each page's own title (see .page-title-row), rather
// than in the sticky header or on a banner row of its own - a back control
// reads as part of the page you're leaving, not as site-wide chrome next to
// the logo, and shouldn't cost the page an extra row just to show it.
export function BackButton() {
  const router = useRouter();
  const { m } = useI18n();
  return (
    <button type="button" className="page-back" title={m.common.back} aria-label={m.common.back} onClick={() => router.back()}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M15 6l-6 6 6 6" />
      </svg>
    </button>
  );
}

export default BackButton;
