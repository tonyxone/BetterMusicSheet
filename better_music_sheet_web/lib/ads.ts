// Google's documented mechanism for keeping the AdSense script present
// site-wide (required) while telling Auto ads not to actually request/show
// ads on a specific screen - meant for "thank you pages, under-construction
// pages" (https://support.google.com/adsense/answer/9261307), which is
// exactly what our loading/empty/no-content screens are.
declare global {
  interface Window {
    adsbygoogle?: unknown[] & { pauseAdRequests?: 0 | 1 };
  }
}

export function setAdsPaused(paused: boolean) {
  if (typeof window === "undefined") return;
  const adsbygoogle = (window.adsbygoogle = window.adsbygoogle || []) as unknown[] & { pauseAdRequests?: 0 | 1 };
  adsbygoogle.pauseAdRequests = paused ? 1 : 0;
}
