"use client";

// Session handling for the app's own sign-in modal.
//
// Two tokens are in play, deliberately:
//   - Cognito's ID token, obtained by cognito.ts and immediately traded in
//     at POST /api/auth/token. It is never sent to our API again.
//   - Our own backend's JWT, which every other API call carries. See the
//     module docstring in ../../auth.py.
//
// The password itself never touches this project's backend - cognito.ts
// posts it straight to Cognito over TLS.
//
// Signing in is optional everywhere - a signed-out visitor uploads under an
// anonymous guest id instead (see guest-id.ts).
import { API_BASE, type User } from "./api";
import { isCognitoConfigured, refreshTokens, signInWithPassword } from "./cognito";

const SESSION_KEY = "bms_auth";

// Refresh a little before the backend token actually expires, so a request
// in flight can't land on the far side of the boundary.
const REFRESH_SKEW_SECONDS = 60;

/** False when no Cognito app is configured (e.g. plain local dev) - the UI
 * hides sign-in entirely rather than offering a form that can't work. */
export const isAuthConfigured = isCognitoConfigured;

export type Session = {
  token: string; // our backend's JWT, not Cognito's
  expiresAt: number; // epoch seconds, for the token above
  refreshToken: string | null; // Cognito's, to re-mint without another sign-in
  user: User;
};

// ---- session storage (per-browser, survives reloads) ----

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function writeSession(session: Session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/** POST to one of the backend's two sign-in-completion routes and return its
 * parsed body. Shared because a password sign-in and a social one converge
 * here: same request shape, same errors. What differs is where each one's
 * refresh token comes from, so building the Session is left to the caller
 * (see the two functions below) rather than folded in here too. */
async function postForSession(path: string, body: Record<string, unknown>): Promise<{
  access_token: string; expires_in?: number; refresh_token?: string; user: User;
}> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Same reasoning as cognito.ts: a transport failure surfaces only as
    // "Failed to fetch". Naming the address makes the usual local cause -
    // the backend simply isn't running - obvious.
    throw new Error(`Couldn't reach the app backend at ${API_BASE}. Is it running?`);
  }
  if (!res.ok) {
    // The backend explains itself (an unconfigured user pool, Cognito
    // unreachable); pass that through rather than just the status code.
    const detail = await res
      .json()
      .then((d) => (typeof d?.detail === "string" ? d.detail : null))
      .catch(() => null);
    throw new Error(detail || `Sign-in failed (${res.status}).`);
  }
  return res.json();
}

function storeSession(data: { access_token: string; expires_in?: number; user: User }, refreshToken: string | null): Session {
  const session: Session = {
    token: data.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    refreshToken,
    user: data.user,
  };
  writeSession(session);
  return session;
}

/** Sign in with email + password and establish a session. */
export async function signIn(email: string, password: string): Promise<Session> {
  if (!isAuthConfigured) throw new Error("Cognito is not configured");
  const tokens = await signInWithPassword(email, password);
  const data = await postForSession("/api/auth/token", { id_token: tokens.IdToken });
  return storeSession(data, tokens.RefreshToken ?? null);
}

/** Finish a social sign-in: the callback page has an authorization code from
 * the hosted-UI redirect, and the backend does the rest (see POST
 * /api/auth/social). Unlike the password flow, this browser never sees a
 * Cognito token of its own - the refresh token comes back IN this response
 * instead, since that exchange is the only place either side of this ever
 * sees one. */
export async function signInWithSocialCode(code: string, redirectUri: string): Promise<Session> {
  if (!isAuthConfigured) throw new Error("Cognito is not configured");
  const data = await postForSession("/api/auth/social", { code, redirect_uri: redirectUri });
  return storeSession(data, data.refresh_token ?? null);
}

/** The current backend token, refreshed if it's expired or about to be.
 * null means "not signed in" - callers fall back to the guest id. */
export async function getAccessToken(): Promise<string | null> {
  const session = readSession();
  if (!session) return null;
  if (session.expiresAt - REFRESH_SKEW_SECONDS > Date.now() / 1000) return session.token;

  if (!session.refreshToken) {
    clearSession();
    return null;
  }
  try {
    // Cognito's refresh grant works the same regardless of how the refresh
    // token was originally issued - password sign-in or a social one - so
    // this one path covers both.
    const tokens = await refreshTokens(session.refreshToken);
    const data = await postForSession("/api/auth/token", { id_token: tokens.IdToken });
    // Cognito doesn't return a new refresh token on this grant - keep ours.
    const refreshed = storeSession(data, session.refreshToken);
    return refreshed.token;
  } catch {
    // Refresh token expired or revoked: drop back to guest rather than
    // trapping the user on a broken session.
    clearSession();
    return null;
  }
}

/** Local-only: there's no hosted-UI session to end, since the app never
 * redirected to Cognito in the first place. */
export function signOut() {
  clearSession();
  window.location.reload();
}
