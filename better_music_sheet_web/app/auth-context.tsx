"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { clientApiFetch } from "@/lib/client-api";
import { getAccessToken, readSession, signOut } from "@/lib/auth";
import { SignInModal } from "./sign-in-modal";
import type { User } from "@/lib/api";

type AuthState = {
  user: User | null;
  /** True only until the first session check settles - the header uses it to
   * avoid flashing "Sign in" at someone who is already signed in. */
  loading: boolean;
  /** Open the sign-in modal. */
  openSignIn: () => void;
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
      // Paint the stored name right away; /api/me confirms or corrects it.
      const stored = readSession();
      if (stored) setUser(stored.user);
      try {
        const res = await clientApiFetch("/api/me");
        if (res.ok) setUser(await res.json());
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

  const openSignIn = useCallback(() => setModalOpen(true), []);
  const closeSignIn = useCallback(() => setModalOpen(false), []);

  const handleSignedIn = useCallback(() => {
    setModalOpen(false);
    refresh();
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
