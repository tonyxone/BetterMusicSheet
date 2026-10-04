"use client";

// Premium's page in a window, over whatever opened it - the sign-in window's
// "See Premium plans" (as the iOS app's sign-in screen offers) and the upload
// page's links to the plans - so closing it goes back there. Signed in, it is
// the whole Paywall, trial and all; signed out, the plans only to look at,
// since subscribing needs an account.

import { Suspense, useEffect } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../auth-context";
import { Paywall } from "./paywall";

export function PremiumWindow({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();

  // Escape closes this window only: caught on the way down, before a window
  // under it (the sign-in window) would close too.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // The page behind shouldn't scroll with it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // On the page body: inside another window's card, "fixed" would be
  // relative to that card wherever it is transformed.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card premium-window" role="dialog" aria-modal="true" aria-label="Premium plans">
        <button type="button" className="modal-close" title="Close" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <Suspense fallback={null}>
          <Paywall previewOnly={!user} />
        </Suspense>
      </div>
    </div>,
    document.body,
  );
}
