"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

// gtag's own auto page_view (on the `config` call in the root layout) only
// fires once, on the first script load - it has no idea about client-side
// route changes in this SPA. That auto page_view is disabled
// (send_page_view: false) and this fires the page_view manually instead, on
// first mount and on every pathname/query change.
export function Analytics() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (typeof window.gtag !== "function") return;
    const query = searchParams.toString();
    window.gtag("event", "page_view", {
      page_path: query ? `${pathname}?${query}` : pathname,
    });
  }, [pathname, searchParams]);

  return null;
}
