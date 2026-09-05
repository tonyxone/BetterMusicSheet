"use client";

import { API_BASE } from "./api";
import { getAccessToken } from "./auth";
import { getOrCreateGuestId } from "./guest-id";

export { API_BASE };

/** Every API call goes through here so identity is attached consistently:
 * the signed-in user's backend token when there is one (refreshed on the
 * way out if it was stale), and the anonymous per-browser guest id
 * otherwise. Only ever one of the two - the backend prefers the token and
 * would ignore the guest id anyway (see ../../auth.py). */
export async function clientApiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const token = await getAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    headers.set("X-Guest-Id", getOrCreateGuestId());
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}
