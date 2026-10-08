// The languages the site is written in, and how each one shows up in a URL.
//
// English keeps the unprefixed paths every link, bookmark, Cognito callback
// and Stripe return URL already uses; every other language lives under its
// own prefix (/ja/upload/, /zh-hans/sheets/?job=...). Both trees render the
// same pages - see app/(en) and app/[lang].
//
// Plain functions only, no React: imported by server components, client
// components and the inline redirect script alike.

export const LOCALES = ["en", "zh-hans", "zh-hant", "ja", "ko"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** The languages that live under a path prefix - every one but English. */
export const PREFIXED_LOCALES = LOCALES.filter((l) => l !== DEFAULT_LOCALE) as Exclude<Locale, "en">[];

/** BCP 47 tags, for <html lang>, hreflang and Intl formatting. The script
 * subtags are what make a browser pick Simplified or Traditional glyphs. */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: "en",
  "zh-hans": "zh-Hans",
  "zh-hant": "zh-Hant",
  ja: "ja",
  ko: "ko",
};

/** Each language named in itself, for the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-hans": "简体中文",
  "zh-hant": "繁體中文",
  ja: "日本語",
  ko: "한국어",
};

/** Where an explicit choice from the language picker is remembered. */
export const LOCALE_STORAGE_KEY = "bms_locale";

/** The language a social sign-in started from (sessionStorage). The callback
 * page is English-only - its URL is the one registered with Cognito - so this
 * is how it knows where to return to. */
export const SIGN_IN_LOCALE_KEY = "bms_signin_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** ``path`` ("/", "/sheets?job=1", "/subscription/upgrade") as it is reached
 * in ``locale``. */
export function localePath(locale: Locale, path: string) {
  if (locale === DEFAULT_LOCALE) return path;
  return path === "/" || path === "" ? `/${locale}/` : `/${locale}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** The language a pathname is in, and the pathname without its prefix. */
export function splitLocale(pathname: string): { locale: Locale; path: string } {
  const first = pathname.split("/")[1] ?? "";
  if (first !== DEFAULT_LOCALE && isLocale(first)) {
    return { locale: first, path: pathname.slice(first.length + 1) || "/" };
  }
  return { locale: DEFAULT_LOCALE, path: pathname || "/" };
}

/** The best of our languages for a browser's preference list, or null when
 * none of them is in it. Chinese goes by script when the tag names one
 * (zh-Hans-HK is Simplified), then by region: Taiwan, Hong Kong and Macau read
 * Traditional, everywhere else Simplified.
 *
 * Self-contained and written in plain ES5 on purpose: its source is inlined
 * into the redirect script in app/root-shell.tsx, which runs before any of
 * the app's code has loaded. */
export function matchLocale(languages: readonly string[]): Locale | null {
  for (let i = 0; i < languages.length; i++) {
    const tag = String(languages[i]).toLowerCase();
    const language = tag.split("-")[0];
    if (language === "zh") {
      if (/-hans\b/.test(tag)) return "zh-hans";
      return /-hant\b/.test(tag) || /-(tw|hk|mo)\b/.test(tag) ? "zh-hant" : "zh-hans";
    }
    if (language === "ja" || language === "ko" || language === "en") return language;
  }
  return null;
}
