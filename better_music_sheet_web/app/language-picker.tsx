"use client";

// Choosing a language reloads the same page in it - each language is its own
// root layout, so there is no client-side hop between them - and remembers
// the choice, so an English URL opened later goes straight to it (see the
// redirect script in app/root-shell.tsx). Choosing English is remembered too,
// which is what stops a browser set to Japanese from being sent back.

import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { LOCALES, LOCALE_NAMES, LOCALE_TAGS, LOCALE_STORAGE_KEY, localePath, splitLocale, type Locale } from "@/lib/i18n/config";

export function LanguagePicker() {
  const { locale, m } = useI18n();
  const pathname = usePathname();

  function choose(next: Locale) {
    if (next === locale) return;
    try { localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* still switches, just not remembered */ }
    const { path } = splitLocale(pathname);
    window.location.assign(localePath(next, path) + window.location.search + window.location.hash);
  }

  return (
    <label className="language-picker">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
      </svg>
      <select value={locale} onChange={(e) => choose(e.target.value as Locale)} aria-label={m.language.label}>
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={LOCALE_TAGS[l]}>{LOCALE_NAMES[l]}</option>
        ))}
      </select>
    </label>
  );
}
