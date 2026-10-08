"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Logo } from "./logo";
import { HistoryIcon } from "./history-icon";
import { SignInIcon } from "./sign-in-icon";
import { useAuth } from "./auth-context";
import { isAuthConfigured } from "@/lib/auth";
import { clientApiFetch } from "@/lib/client-api";
import { useSubscription } from "@/lib/subscription";
import { useI18n } from "@/lib/i18n/client";
import { fmt, rich } from "@/lib/i18n/format";
import { translateKnown } from "@/lib/i18n/known-text";

export function Header() {
  const { user, loading, openSignIn, signOut } = useAuth();
  const { m, path } = useI18n();

  return (
    <header className="site-header">
      <Link href={path("/")} className="logo" title={m.header.home}>
        <Logo />
      </Link>
      <nav className="flex items-center gap-3">
        {/* /history, not "/": the root is the Library only for a signed-in
            visitor, and a guest with sheets of their own needs this to work
            too. */}
        <Link
          href={path("/history")}
          className="icon-link"
          title={m.header.library}
          aria-label={m.header.library}
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
            name={user.display_name || user.email || m.header.account}
            email={user.email}
            onSignOut={signOut}
          />
        ) : isAuthConfigured ? (
          <button
            type="button"
            className="icon-link"
            title={m.common.signIn}
            aria-label={m.common.signIn}
            onClick={() => openSignIn()}
          >
            <SignInIcon />
          </button>
        ) : null}
      </nav>
    </header>
  );
}

function UserMenu({ name, email, onSignOut }: { name: string; email: string | null; onSignOut: () => void }) {
  // Only a subscriber has anything to manage; everyone else goes to the plans.
  const { subscription } = useSubscription();
  const { m, path } = useI18n();
  const subscribed = subscription?.tier === "premium";
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

  const confirmTextMatches = confirmText.trim().toLowerCase() === m.header.confirmWord.toLowerCase();

  async function confirmDeleteAccount() {
    if (deleting || !confirmTextMatches) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await clientApiFetch("/api/me", { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { detail?: string } | null;
        throw new Error(translateKnown(body?.detail, m) || fmt(m.header.deleteFailedStatus, { status: res.status }));
      }
      // The account (and its Cognito identity) is gone - same cleanup as an
      // ordinary sign-out: drop the local session and reload signed out.
      onSignOut();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : m.header.deleteFailed);
      setDeleting(false);
    }
  }

  return (
    <div className="nav-menu-root" ref={rootRef}>
      <button
        type="button"
        className="nav-btn ghost nav-user-btn"
        title={email ? fmt(m.header.openAccountMenuFor, { email }) : m.header.openAccountMenu}
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
          <Link
            href={path(subscribed ? "/subscription" : "/subscription/upgrade")}
            className="nav-menu-item"
            role="menuitem"
            title={m.header.manageSubscriptionTitle}
            onClick={() => setOpen(false)}
          >
            {m.header.manageSubscription}
          </Link>
          <button
            type="button"
            className="nav-menu-item"
            role="menuitem"
            title={m.header.signOutTitle}
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            {m.header.signOut}
          </button>
          <button
            type="button"
            className="nav-menu-item danger"
            role="menuitem"
            title={m.header.deleteAccountTitle}
            onClick={() => {
              setOpen(false);
              setDeleteError(null);
              setDeleteOpen(true);
            }}
          >
            {m.header.deleteAccount}
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
                title={m.common.close}
                aria-label={m.common.close}
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
              <h2 id="delete-account-title" className="serif modal-title">{m.header.deleteHeading}</h2>
              <p className="modal-sub">
                {email ? fmt(m.header.deleteBodyEmail, { email }) : m.header.deleteBody}
              </p>
              <label className="modal-field">
                <span>{rich(m.header.typeToConfirm, {}, { word: <strong>{m.header.confirmWord}</strong> })}</span>
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
                <button type="button" className="btn-pill ghost" title={m.header.keepAccount} onClick={closeDeleteAccount} disabled={deleting}>
                  {m.common.cancel}
                </button>
                <button
                  type="button"
                  className="btn-pill danger"
                  title={confirmTextMatches ? m.header.deleteAccountTitle : fmt(m.header.typeToEnable, { word: m.header.confirmWord })}
                  onClick={confirmDeleteAccount}
                  disabled={deleting || !confirmTextMatches}
                >
                  {deleting ? m.common.deleting : m.header.deleteAccount}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
