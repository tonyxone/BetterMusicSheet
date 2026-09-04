"use client";

import Link from "next/link";
import { Logo } from "./logo";
import { useAuth } from "./auth-context";
import { isAuthConfigured } from "@/lib/auth";

export function Header() {
  const { user, loading, signIn, signOut } = useAuth();

  return (
    <header className="site-header">
      <Link href="/" className="logo" title="Upload another sheet">
        <Logo />
      </Link>
      <nav className="flex items-center gap-3">
        <Link href="/history" className="nav-btn ghost">
          History
        </Link>
        {/* Nothing until the session check settles, so someone who is already
            signed in never sees "Sign in" flash first. Sign-in is optional -
            uploading works signed out - so this is the only auth UI. */}
        {loading ? null : user ? (
          <>
            <span className="nav-user" title={user.email ?? undefined}>
              {user.display_name}
            </span>
            <button type="button" className="nav-btn ghost" onClick={() => signOut()}>
              Sign out
            </button>
          </>
        ) : isAuthConfigured ? (
          <button type="button" className="nav-btn primary" onClick={() => signIn()}>
            Sign in
          </button>
        ) : null}
      </nav>
    </header>
  );
}
