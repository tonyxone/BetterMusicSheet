"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n/client";

// App Store app ID 6814721766 (docs/apple-subscription-readiness.md). The
// regionless URL lets the App Store pick the visitor's own storefront.
const APP_STORE_URL = "https://apps.apple.com/app/id6814721766";

/** Header icon that explains, before sending anyone to the App Store, that
 * the app signs in with the same account - so a Premium subscriber does not
 * think they have to pay a second time. */
export function IosAppLink() {
  const { m } = useI18n();
  const t = m.iosApp;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      {/* An <a> with the real URL, so it still works without JS and reads as
          a link; the click is intercepted to show the explanation first. */}
      <a
        href={APP_STORE_URL}
        className="icon-link"
        title={t.link}
        aria-label={t.link}
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        {/* A phone outline drawn at the 34px the other nav icons use. */}
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="6" y="2" width="12" height="20" rx="2.75" />
          <path d="M10.5 5h3M11 18.5h2" />
        </svg>
      </a>
      {/* Portalled to <body>: .site-header's backdrop-filter would otherwise
          become the containing block for the fixed backdrop. */}
      {open && createPortal(
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="modal-card ios-app-modal" role="dialog" aria-modal="true" aria-label={t.title}>
            <button type="button" className="modal-close" title={m.common.close} aria-label={m.common.close} onClick={() => setOpen(false)}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
            {/* The App Store listing's own artwork (256px for 2x screens),
                rounded in CSS the way iOS masks it. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- static export, nothing to optimize */}
            <img className="ios-app-icon" src="/ios-app-icon.png" alt="" width={72} height={72} />
            <h2 className="serif modal-title">{t.title}</h2>
            <p className="modal-sub">{t.lead}</p>
            <ul className="ios-app-points">
              <li>{t.sameAccount}</li>
              <li>{t.sameSubscription}</li>
            </ul>
            <a className="btn-pill ios-app-download" href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
              {t.download}
            </a>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
