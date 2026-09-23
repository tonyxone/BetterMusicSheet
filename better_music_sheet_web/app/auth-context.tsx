"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { clientApiFetch } from "@/lib/client-api";
import { getAccessToken, readSession, signOut } from "@/lib/auth";
import { refreshSubscription } from "@/lib/subscription";
import { SignInModal } from "./sign-in-modal";
import type { User } from "@/lib/api";

type AuthState = {
  user: User | null;
  /** True only until the first session check settles - the header uses it to
   * avoid flashing "Sign in" at someone who is already signed in. */
  loading: boolean;
  /** Open the sign-in modal. `onSuccess`, if given, runs once sign-in
   * completes - only for the in-place password/confirm-code flows, which
   * close the modal without navigating; a social sign-in redirects the
   * whole page instead and never comes back to call it. */
  openSignIn: (onSuccess?: () => void) => void;
  signOut: typeof signOut;
  /** Re-read the session from scratch. */
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  // Written as a promise chain rather than a plain `async` body so every
  // setState below is lexically inside a callback: the mount effect calls
  // this, and a setState reachable synchronously from an effect cascades
  // renders (React's set-state-in-effect rule rejects it).
  const refresh = useCallback(() => {
    return getAccessToken().then(async (token) => {
      if (!token) {
        setUser(null);
        setLoading(false);
        return;
      }
      // Paint the stored name right away and stop blocking the header on
      // it - /api/me still confirms or corrects it, but in the background.
      // loading used to stay true until that call returned, so a signed-in
      // visitor saw no header button at all for a whole network round trip
      // (header.tsx renders nothing while loading), despite the user state
      // already being known from the cached session.
      const stored = readSession();
      if (stored) {
        setUser(stored.user);
        setLoading(false);
      }
      try {
        const res = await clientApiFetch("/api/me");
        if (res.ok) {
          const fetched = (await res.json()) as User;
          // A row the backend had to recreate (a local restart, or a table
          // wiped between deploys) comes back with no name or email - the
          // token only carries the id. Keep what this browser's own sign-in
          // stored rather than dropping the header back to "Account".
          const same = stored?.user.user_id === fetched.user_id;
          setUser({
            ...fetched,
            display_name: fetched.display_name ?? (same ? stored.user.display_name : null),
            email: fetched.email ?? (same ? stored.user.email : null),
          });
        }
        else if (res.status === 401) setUser(null);
        // Any other status is a server-side blip, not proof of a bad session -
        // keep whatever the stored session said rather than signing them out.
      } catch {
        // Network error - same reasoning as above.
      } finally {
        setLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    // localStorage/crypto are browser-only, and this is a static export, so
    // the first read has to wait for mount rather than happening in render.
    refresh();
  }, [refresh]);

  // The subscription is cached per page load, not per account. Signing in
  // through the modal doesn't reload the page, so without this a visitor who
  // opened a page signed out keeps the "free" answer after signing in.
  // undefined = session not settled yet; the first settled account is the
  // one the initial fetch already asked about.
  const userId = loading ? undefined : (user?.user_id ?? null);
  const lastUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (userId === undefined) return;
    if (lastUserId.current !== undefined && lastUserId.current !== userId) {
      void refreshSubscription();
    }
    lastUserId.current = userId;
  }, [userId]);

  // A ref, not state: it's read once from an event handler (handleSignedIn),
  // never rendered, so it doesn't need to trigger a re-render on its own.
  const onSignInSuccess = useRef<(() => void) | null>(null);

  const openSignIn = useCallback((onSuccess?: () => void) => {
    onSignInSuccess.current = onSuccess ?? null;
    setModalOpen(true);
  }, []);
  const closeSignIn = useCallback(() => {
    onSignInSuccess.current = null;
    setModalOpen(false);
  }, []);

  const handleSignedIn = useCallback(() => {
    setModalOpen(false);
    refresh();
    const onSuccess = onSignInSuccess.current;
    onSignInSuccess.current = null;
    onSuccess?.();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, loading, openSignIn, signOut, refresh }}>
      {children}
      {modalOpen && <SignInModal onClose={closeSignIn} onSignedIn={handleSignedIn} />}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
