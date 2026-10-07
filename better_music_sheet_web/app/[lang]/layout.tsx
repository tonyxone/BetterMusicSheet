import { notFound } from "next/navigation";
import { RootShell } from "../root-shell";
import { PREFIXED_LOCALES, isLocale } from "@/lib/i18n/config";
import { rootMetadata } from "@/lib/i18n/metadata";

// Every language but English, each under its own prefix (/ja/, /zh-hans/...).
// The pages here are the English tree's own, re-exported - they read the
// language from this segment (lib/i18n/server.ts) - so the two trees can't
// drift apart. /admin and /auth/callback stay English-only.

// A static export builds exactly these; anything else is not a page.
export const dynamicParams = false;

export function generateStaticParams() {
  return PREFIXED_LOCALES.map((lang) => ({ lang }));
}

export const generateMetadata = rootMetadata;

export default async function LocaleLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang) || lang === "en") notFound();
  return <RootShell locale={lang}>{children}</RootShell>;
}
