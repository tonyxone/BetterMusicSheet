"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DEMO_JOB_ID } from "@/lib/api";
import { useAuth } from "./auth-context";
import { KeyboardIcon } from "./keyboard-icon";
import { fetchDemoHidden, readLocalDemoHidden, saveDemoHidden, writeLocalDemoHidden } from "@/lib/demo-hidden";

const PLAY_TITLE = "Try practice mode with a sample sheet - free, no account needed";
const SHEET_TITLE = "See the sample sheet, annotated - free, no account needed";

/** A standing, no-commitment invite to try Play - no upload, no account, no
 * subscription. Shown on both the landing page (signed out) and the library
 * (signed in or guest), since it's for anyone who hasn't tried practice mode
 * yet, not just a first-time visitor. The backend's demo read carve-out (see
 * server.py's DEMO_JOB_ID) is what makes the link work for everyone.
 *
 * `removable` turns on the same remove affordance a normal library row has -
 * it only ever hides the entry for this one viewer (signed-in account or
 * guest browser), never the underlying job; see lib/demo-hidden.ts. The
 * landing page omits it: there's nothing to restore from there, and the
 * entry just disappears once hidden.
 *
 * `emptyLibrary` says whether this is the only thing the library would
 * otherwise show, so a hidden demo can still explain the empty state and
 * offer the restore link, rather than the library rendering its own "no
 * sheets" message on top of nothing. */
export function DemoSampleCard({ removable = false, emptyLibrary = false }: { removable?: boolean; emptyLibrary?: boolean }) {
  const { user, loading: authLoading } = useAuth();
  const [hidden, setHidden] = useState<boolean | null>(null);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    // Unified into one promise even for the guest branch's synchronous
    // localStorage read, so setHidden is always called from a .then()
    // rather than directly in the effect body.
    (user ? fetchDemoHidden() : Promise.resolve(readLocalDemoHidden())).then((value) => {
      if (!cancelled) setHidden(value);
    });
    return () => { cancelled = true; };
  }, [user, authLoading]);

  function hide() {
    setHidden(true);
    if (user) void saveDemoHidden(true);
    else writeLocalDemoHidden(true);
  }

  function show() {
    setHidden(false);
    if (user) void saveDemoHidden(false);
    else writeLocalDemoHidden(false);
  }

  if (hidden === null) return null; // Still loading - avoids a flash before the real state is known.

  if (hidden) {
    if (!removable) return null;
    return (
      <>
        {emptyLibrary && <div className="history-empty">No sheets annotated yet.</div>}
        <button type="button" className="play-clear" onClick={show}>
          Show the sample again
        </button>
      </>
    );
  }

  if (!removable) {
    return (
      <Link href={`/play?job=${DEMO_JOB_ID}`} className="history-row" title={PLAY_TITLE}>
        <div className="history-icon">🎼</div>
        <div className="history-info">
          <div className="history-title">Try a sample</div>
          <div className="history-meta">Ode to Joy · Beethoven · free, no account needed</div>
        </div>
        <span className="history-badge done">Play</span>
      </Link>
    );
  }

  // Mirrors a normal library row exactly: clicking the row itself opens the
  // sheet (annotated/original toggle, download), and practice mode is the
  // separate keyboard icon - not the other way around.
  return (
    <div className="history-row">
      <Link href={`/sheets?job=${DEMO_JOB_ID}`} className="history-row-link" title={SHEET_TITLE}>
        <div className="history-icon">🎼</div>
        <div className="history-info">
          <div className="history-title">Try a sample</div>
          <div className="history-meta">Ode to Joy · Beethoven · free, no account needed</div>
        </div>
        <span className="history-badge done">Annotated</span>
      </Link>
      <div className="history-actions">
        <Link
          href={`/play?job=${DEMO_JOB_ID}`}
          className="history-action history-play"
          title="Practice with the keyboard"
          aria-label="Practice with the keyboard"
        >
          <KeyboardIcon size={40} />
        </Link>
        <button
          type="button"
          className="history-action history-delete"
          onClick={hide}
          title="Remove the sample from your library"
          aria-label="Remove the sample from your library"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
