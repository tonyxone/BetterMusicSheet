"use client";

// The page's language for client components. Each root layout hands its own
// language's messages to the provider, so a page only ever ships the one
// dictionary it is written in.

import { createContext, useContext, useMemo } from "react";
import { LOCALE_TAGS, localePath, type Locale } from "./config";
import type { Messages } from "./messages/en";

type I18n = {
  locale: Locale;
  /** BCP 47 tag, for Intl and toLocaleString. */
  tag: string;
  m: Messages;
  /** An app path ("/sheets?job=1") as it is reached in this language. */
  path: (path: string) => string;
};

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ locale, messages, children }: {
  locale: Locale;
  messages: Messages;
  children: React.ReactNode;
}) {
  const value = useMemo<I18n>(() => ({
    locale,
    tag: LOCALE_TAGS[locale],
    m: messages,
    path: (path: string) => localePath(locale, path),
  }), [locale, messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
