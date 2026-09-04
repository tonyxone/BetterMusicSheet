"use client";

// Cognito sign-in for a static-export SPA: authorization code + PKCE,
// entirely in the browser. There is no Node server in this deployment (see
// next.config.ts), so there's no backend-for-frontend to hold a client
// secret - the Cognito app client is therefore a PUBLIC client with no
// secret, which is exactly what PKCE exists for.
//
// Two tokens are in play, deliberately:
//   - Cognito's ID token, which this module obtains and immediately trades
//     in at POST /api/auth/token. It is never sent to our API again.
//   - Our own backend's JWT, which every other API call carries. See the
//     module docstring in ../../auth.py.
//
// Signing in is optional everywhere - a signed-out visitor uploads under an
// anonymous guest id instead (see guest-id.ts).
import { API_BASE, type User } from "./api";

const DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;

// `profile` is what makes Cognito include a `name` claim (when the pool has
// that attribute); the backend degrades to the email's local part if not.
const SCOPES = "openid email profile";

const SESSION_KEY = "bms_auth";
const PKCE_KEY = "bms_pkce";
const RETURN_TO_KEY = "bms_return_to";

// Refresh a little before the backend token actually expires, so a request
// in flight can't land on the far side of the boundary.
const REFRESH_SKEW_SECONDS = 60;

/** False when no Cognito app is configured (e.g. plain local dev) - the UI
 * hides sign-in entirely rather than offering a button that can't work. */
export const isAuthConfigured = Boolean(DOMAIN && CLIENT_ID);

export type Session = {
  token: string; // our backend's JWT, not Cognito's
  expiresAt: number; // epoch seconds, for the token above
  refreshToken: string | null; // Cognito's, to re-mint without another sign-in
  user: User;
};

// Cognito matches redirect_uri by exact string. next.config.ts sets
// trailingSlash, so the exported callback page really is /auth/callback/ -
// the trailing slash here is load-bearing and must match what's registered
// in the user pool client (see infra/cognito.tf).
function callbackUrl() {
  return `${window.location.origin}/auth/callback/`;
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function s256(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

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

// ---- the flow ----

/** Step 1: bounce to Cognito's hosted UI. Never returns - the page navigates. */
export async function signIn(returnTo?: string) {
  if (!isAuthConfigured) throw new Error("Cognito is not configured");
  const verifier = randomString();
  const state = randomString(16);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  sessionStorage.setItem(RETURN_TO_KEY, returnTo ?? window.location.pathname);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID!,
    redirect_uri: callbackUrl(),
    scope: SCOPES,
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
  });
  // Leaving the app entirely for Cognito's hosted UI - not a Next.js route,
  // so the router can't (and shouldn't) handle it.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`${DOMAIN}/oauth2/authorize?${params}`);
}

async function cognitoToken(body: Record<string, string>) {
  const res = await fetch(`${DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID!, ...body }),
  });
  if (!res.ok) throw new Error(`Cognito token request failed (${res.status})`);
  return (await res.json()) as { id_token: string; refresh_token?: string };
}

/** Trade a Cognito ID token for our backend's own token + the user row it
 * creates on first sign-in. */
async function exchangeWithBackend(idToken: string, refreshToken: string | null): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: idToken }),
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

/** Step 2, run by /auth/callback: turn the ?code= back into a session. */
export async function completeSignIn(code: string, state: string): Promise<{ session: Session; returnTo: string }> {
  const stashed = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  if (!stashed) throw new Error("no sign-in in progress");
  const { verifier, state: expectedState } = JSON.parse(stashed);
  // The state check is the CSRF defense for the redirect: a code delivered
  // to this page that we didn't ask for won't carry our one-time state.
  if (state !== expectedState) throw new Error("state mismatch");

  const tokens = await cognitoToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
    code_verifier: verifier,
  });
  const session = await exchangeWithBackend(tokens.id_token, tokens.refresh_token ?? null);

  const returnTo = sessionStorage.getItem(RETURN_TO_KEY) || "/";
  sessionStorage.removeItem(RETURN_TO_KEY);
  return { session, returnTo };
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
    const tokens = await cognitoToken({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    });
    // Cognito doesn't return a new refresh token on this grant - keep ours.
    const refreshed = await exchangeWithBackend(tokens.id_token, session.refreshToken);
    return refreshed.token;
  } catch {
    // Refresh token expired or revoked: drop back to guest rather than
    // trapping the user on a broken session.
    clearSession();
    return null;
  }
}

/** Clear the local session, then end the Cognito session too - otherwise the
 * hosted UI would silently sign the same user straight back in. */
export function signOut() {
  clearSession();
  if (!isAuthConfigured) {
    // Can't have been signed in without Cognito configured; just re-render
    // the current page as a guest.
    window.location.reload();
    return;
  }
  const params = new URLSearchParams({
    client_id: CLIENT_ID!,
    logout_uri: `${window.location.origin}/`,
  });
  // External, like the authorize redirect above.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`${DOMAIN}/logout?${params}`);
}
