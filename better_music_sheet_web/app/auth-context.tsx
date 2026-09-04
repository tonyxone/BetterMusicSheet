"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { clientApiFetch } from "@/lib/client-api";
import { getAccessToken, readSession, signIn, signOut } from "@/lib/auth";
import type { User } from "@/lib/api";

type AuthState = {
  user: User | null;
  /** True only until the first session check settles - the header uses it to
   * avoid flashing "Sign in" at someone who is already signed in. */
  loading: boolean;
  signIn: typeof signIn;
  signOut: typeof signOut;
  /** Re-read the session from scratch; the sign-in callback calls this so the
   * header updates without a full page reload. */
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
