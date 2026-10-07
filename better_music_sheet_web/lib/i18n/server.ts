// The page's language for server components, from the [lang] root segment.
// English pages live under app/(en), a root layout without that segment,
// where lang() resolves to undefined.

import { lang } from "next/root-params";
import { DEFAULT_LOCALE, LOCALE_TAGS, isLocale, localePath, type Locale } from "./config";
import { MESSAGES } from "./messages";

export async function getLocale(): Promise<Locale> {
  const value = await lang();
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function getI18n() {
  const locale = await getLocale();
  return {
    locale,
    tag: LOCALE_TAGS[locale],
    m: MESSAGES[locale],
    path: (path: string) => localePath(locale, path),
  };
}
