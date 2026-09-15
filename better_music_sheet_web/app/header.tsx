"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Logo } from "./logo";
import { KeyboardIcon } from "./keyboard-icon";
import { HistoryIcon } from "./history-icon";
import { SignInIcon } from "./sign-in-icon";
import { useAuth } from "./auth-context";
import { isAuthConfigured } from "@/lib/auth";
import { clientApiFetch } from "@/lib/client-api";

export function Header() {
  const { user, loading, openSignIn, signOut } = useAuth();

  return (
    <header className="site-header">
      <Link href="/" className="logo" title="Upload another sheet">
        <Logo />
      </Link>
      <nav className="flex items-center gap-3">
        {/* Open to everyone: signed-out visitors get the first few measures,
            and are asked to sign in only when they reach past them. */}
        <Link
          href="/play"
          className="icon-link"
          title="Practice with the keyboard"
          aria-label="Practice with the keyboard"
        >
          <KeyboardIcon size={44} />
        </Link>
        <Link
          href="/history"
          className="icon-link"
          title="Library"
          aria-label="Library"
        >
          <HistoryIcon />
        </Link>
        {/* Nothing until the session check settles, so someone who is already
            signed in never sees "Sign in" flash first. Sign-in is optional -
            uploading works signed out - so this is the only auth UI. */}
        {loading ? null : user ? (
          <UserMenu
            // An account made before names were required may not have one.
            // Fall back to the email rather than the id - a raw UUID where a
            // name belongs just looks broken.
            name={user.display_name || user.email || "Account"}
            email={user.email}
            onSignOut={signOut}
          />
        ) : isAuthConfigured ? (
          <button
            type="button"
            className="icon-link"
            title="Sign in"
            aria-label="Sign in"
            onClick={openSignIn}
          >
            <SignInIcon />
          </button>
        ) : null}
      </nav>
    </header>
  );
}

function UserMenu({ name, email, onSignOut }: { name: string; email: string | null; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function closeDeleteAccount() {
    if (deleting) return;
    setDeleteOpen(false);
    setDeleteError(null);
    setConfirmText("");
  }

  const confirmTextMatches = confirmText.trim().toLowerCase() === "delete";

  async function confirmDeleteAccount() {
    if (deleting || !confirmTextMatches) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await clientApiFetch("/api/me", { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { detail?: string } | null;
        throw new Error(body?.detail || `Could not delete your account (${res.status}).`);
      }
      // The account (and its Cognito identity) is gone - same cleanup as an
      // ordinary sign-out: drop the local session and reload signed out.
      onSignOut();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete your account.");
      setDeleting(false);
    }
  }

  return (
    <div className="nav-menu-root" ref={rootRef}>
      <button
        type="button"
        className="nav-btn ghost nav-user-btn"
        title={email ? `Open account menu for ${email}` : "Open account menu"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="nav-user">{name}</span>
        <svg className={`nav-caret${open ? " open" : ""}`} viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="nav-menu" role="menu">
          <button
            type="button"
            className="nav-menu-item"
            role="menuitem"
            title="Sign out of this account"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
          <button
            type="button"
            className="nav-menu-item danger"
            role="menuitem"
            title="Permanently delete your account"
            onClick={() => {
              setOpen(false);
              setDeleteError(null);
              setDeleteOpen(true);
            }}
          >
            Delete account
          </button>
        </div>
      )}
      {deleteOpen &&
        createPortal(
          // A plain child of .site-header can't use position:fixed to cover
          // the viewport - the header's own backdrop-filter makes it the
          // containing block instead (a CSS rule for filter/transform/etc,
          // not just this app), which is why this portals to <body> the same
          // way the sign-in modal already avoids the header by living in
          // AuthProvider instead of inside it.
          <div
            className="modal-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) closeDeleteAccount();
            }}
          >
            <div className="modal-card delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-account-title">
              <button
                type="button"
                className="modal-close"
                onClick={closeDeleteAccount}
                disabled={deleting}
                title="Close"
                aria-label="Close"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
              <h2 id="delete-account-title" className="serif modal-title">Delete your account?</h2>
              <p className="modal-sub">
                This permanently deletes your account{email ? ` (${email})` : ""} and your sheet
                history. This can&apos;t be undone.
              </p>
              <label className="modal-field">
                <span>Type <strong>delete</strong> to confirm</span>
                <input
                  type="text"
                  autoComplete="off"
                  autoFocus
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  disabled={deleting}
                />
              </label>
              {deleteError && <p className="modal-error">{deleteError}</p>}
              <div className="modal-actions">
                <button type="button" className="btn-pill ghost" title="Keep your account" onClick={closeDeleteAccount} disabled={deleting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-pill danger"
                  title={confirmTextMatches ? "Permanently delete your account" : 'Type "delete" to enable this button'}
                  onClick={confirmDeleteAccount}
                  disabled={deleting || !confirmTextMatches}
                >
                  {deleting ? "Deleting…" : "Delete account"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
