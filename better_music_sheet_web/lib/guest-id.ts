"use client";

// An anonymous per-browser id, generated once and persisted in a cookie on
// THIS app's own origin (never sent cross-origin automatically - the API is
// on a different origin, so this is attached as a request header instead,
// see client-api.ts). Lets the backend separate one visitor's uploads/
// history/quota from another's without any real sign-in.
const COOKIE_NAME = "guest_id";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function getOrCreateGuestId(): string {
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
  if (match) return decodeURIComponent(match[1]);

  const id = crypto.randomUUID();
  document.cookie = `${COOKIE_NAME}=${id}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
  return id;
}
