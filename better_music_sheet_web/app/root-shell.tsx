import { Suspense } from "react";
import "./globals.css";
import { Header } from "./header";
import { Footer } from "./footer";
import { Analytics } from "./analytics";
import { AuthProvider } from "./auth-context";
import { I18nProvider } from "@/lib/i18n/client";
import { LOCALE_STORAGE_KEY, LOCALE_TAGS, PREFIXED_LOCALES, matchLocale, type Locale } from "@/lib/i18n/config";
import { MESSAGES } from "@/lib/i18n/messages";

// Sends a visitor who lands on an English page to their own language: the one
// they chose in the footer's picker, or else the first of the browser's that
// the site is written in. Inline in <head>, so it runs before the English page
// paints. An explicit choice of English is remembered too, and stays put.
//
// /auth/ and /admin/ exist in English only: the sign-in callback's URL is
// registered with Cognito as it is, and the admin page isn't translated.
const REDIRECT_SCRIPT = `(function () {
  try {
    var path = location.pathname;
    if (/^\\/(auth|admin)(\\/|$)/.test(path)) return;
    var chosen = null;
    try { chosen = localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)}); } catch (e) {}
    var match = ${matchLocale.toString()};
    var target = chosen || match(navigator.languages || [navigator.language || ""]);
    if (${JSON.stringify(PREFIXED_LOCALES)}.indexOf(target) < 0) return;
    location.replace("/" + target + path + location.search + location.hash);
  } catch (e) {}
})();`;

/** <html> for one language - shared by the English root layout, app/(en),
 * and the one for every other language, app/[lang]. */
export function RootShell({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return (
    <html lang={LOCALE_TAGS[locale]} className="h-full">
      <head>
        {locale === "en" && <script>{REDIRECT_SCRIPT}</script>}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600;700&family=Work+Sans:wght@400;500;600&family=Caveat:wght@600&display=swap"
          rel="stylesheet"
        />
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-RDB4K5MC4D" />
        <script>{`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-RDB4K5MC4D', { send_page_view: false });
        `}</script>
      </head>
      <body className="min-h-full antialiased">
        <div className="bg-glow" />
        <Suspense fallback={null}>
          <Analytics />
        </Suspense>
        <I18nProvider locale={locale} messages={MESSAGES[locale]}>
          <AuthProvider>
            <Header />
            <main>{children}</main>
            <Footer />
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
