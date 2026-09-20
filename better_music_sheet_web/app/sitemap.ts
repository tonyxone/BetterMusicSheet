import type { MetadataRoute } from "next";

import { SITE_URL } from "./site";

// Only the pages that are the same for everyone. The library, a single sheet
// and the practice view are all per-visitor and are excluded here and in
// robots.ts alike.
// Only the pages that are the same for everyone. The library, a single sheet
// and the practice view are all per-visitor and are excluded here and in
// robots.ts alike.
//
// force-static for the same reason as robots.ts - the static export will not
// build a metadata route without it.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const updated = new Date("2026-09-18");
  return [
    { url: `${SITE_URL}/`, lastModified: updated, priority: 1 },
    { url: `${SITE_URL}/upload/`, lastModified: updated, priority: 0.8 },
    { url: `${SITE_URL}/about/`, lastModified: updated, priority: 0.6 },
    { url: `${SITE_URL}/privacy/`, lastModified: updated, priority: 0.3 },
    { url: `${SITE_URL}/terms/`, lastModified: updated, priority: 0.3 },
  ];
}
