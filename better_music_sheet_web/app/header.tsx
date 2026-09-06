"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Logo } from "./logo";
import { KeyboardIcon } from "./keyboard-icon";
import { useAuth } from "./auth-context";
import { isAuthConfigured } from "@/lib/auth";

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
          title="Play with the keyboard"
          aria-label="Play with the keyboard"
        >
          <KeyboardIcon size={44} />
        </Link>
        <Link href="/history" className="nav-btn ghost">
          History
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
          <button type="button" className="nav-btn primary" onClick={openSignIn}>
            Sign in
          </button>
        ) : null}
      </nav>
    </header>
  );
}

function UserMenu({ name, email, onSignOut }: { name: string; email: string | null; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
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

  return (
    <div className="nav-menu-root" ref={rootRef}>
      <button
        type="button"
        className="nav-btn ghost nav-user-btn"
        title={email ?? undefined}
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
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
