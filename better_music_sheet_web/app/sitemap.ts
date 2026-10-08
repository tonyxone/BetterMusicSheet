import type { MetadataRoute } from "next";

import { SITE_URL } from "./site";
import { LOCALES, LOCALE_TAGS, localePath } from "@/lib/i18n/config";

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

//
// Each page is listed once per language, every entry naming all of its
// versions, which is how a search engine learns they are one page.
export default function sitemap(): MetadataRoute.Sitemap {
  const updated = new Date("2026-10-06");
  const pages = [
    { path: "/", lastModified: updated, priority: 1 },
    { path: "/upload/", lastModified: updated, priority: 0.8 },
    { path: "/about/", lastModified: updated, priority: 0.6 },
    { path: "/subscription/plans/", lastModified: updated, priority: 0.5 },
    { path: "/privacy/", lastModified: new Date("2026-09-28"), priority: 0.3 },
    { path: "/terms/", lastModified: new Date("2026-09-28"), priority: 0.3 },
    { path: "/support/", lastModified: updated, priority: 0.4 },
  ];
  return pages.flatMap(({ path, ...entry }) => {
    const languages = Object.fromEntries(LOCALES.map((l) => [LOCALE_TAGS[l], `${SITE_URL}${localePath(l, path)}`]));
    return LOCALES.map((locale) => ({
      url: `${SITE_URL}${localePath(locale, path)}`,
      ...entry,
      alternates: { languages },
    }));
  });
}
