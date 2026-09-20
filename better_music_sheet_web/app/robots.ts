import type { MetadataRoute } from "next";

import { SITE_URL } from "./site";

// Emitted as a real /robots.txt file by the static export, which had none at
// all - the deployed site answered 404 for it.
// Emitted as a real /robots.txt file by the static export, which had none at
// all - the deployed site answered 404 for it.
//
// force-static is required, not decorative: a metadata route is a Route
// Handler, and `output: "export"` refuses to build one without it. Dropping it
// as redundant fails the build with "export const dynamic = force-static not
// configured on route /robots.txt".
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Per-sheet routes are one person's own uploads behind a query string,
      // and /auth/callback is a redirect target. Neither is a page anyone
      // should reach from a search result.
      disallow: ["/sheets/", "/play/", "/history/", "/auth/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
