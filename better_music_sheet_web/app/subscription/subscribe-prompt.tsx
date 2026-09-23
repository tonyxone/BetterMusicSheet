"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useSubscription } from "@/lib/subscription";

/** Shown when a non-subscriber's free preview runs out - on the play page,
 * not a full-page redirect, so the sheet and keyboard stay right where they
 * were closed on top of. */
export function SubscribePrompt({ onClose }: { onClose: () => void }) {
  const { subscription } = useSubscription();
  const trial = subscription?.trial_eligible !== false;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Go Premium">
        <button type="button" className="modal-close" title="Close" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <h2 className="serif modal-title">Keep practicing</h2>
        <p className="modal-sub">
          That&apos;s the free preview. Subscribe for full practice mode on every piece{trial ? ", with a 7-day free trial" : ""}.
        </p>
        <Link className="btn-pill" href="/subscription/upgrade" onClick={onClose} style={{ display: "block", textAlign: "center" }}>
          {trial ? "Start 7-day free trial" : "Subscribe"}
        </Link>
      </div>
    </div>
  );
}
