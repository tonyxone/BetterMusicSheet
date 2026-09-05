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
import { isCognitoConfigured, refreshTokens, signInWithPassword, type CognitoTokens } from "./cognito";

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

/** Trade a Cognito ID token for our backend's own token, plus the user row
 * it creates on first sign-in. */
async function exchangeWithBackend(tokens: CognitoTokens, refreshToken: string | null): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: tokens.IdToken }),
  });
  if (!res.ok) throw new Error(`sign-in failed (${res.status})`);
  const data = await res.json();
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
  return exchangeWithBackend(tokens, tokens.RefreshToken ?? null);
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
    const tokens = await refreshTokens(session.refreshToken);
    // Cognito doesn't return a new refresh token on this grant - keep ours.
    const refreshed = await exchangeWithBackend(tokens, session.refreshToken);
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
