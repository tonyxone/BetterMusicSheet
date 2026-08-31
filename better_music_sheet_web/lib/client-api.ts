"use client";

import { getOrCreateGuestId } from "./guest-id";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE!;

export function clientApiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Guest-Id", getOrCreateGuestId());
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}
