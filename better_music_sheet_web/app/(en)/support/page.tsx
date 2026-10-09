import { getI18n } from "@/lib/i18n/server";
import { pageMetadata } from "@/lib/i18n/metadata";
import type { Locale } from "@/lib/i18n/config";
import { SupportEn } from "./content/en";
import { SupportZhHans } from "./content/zh-hans";
import { SupportZhHant } from "./content/zh-hant";
import { SupportJa } from "./content/ja";
import { SupportKo } from "./content/ko";

export const generateMetadata = () => pageMetadata("/support/", "support");

// Prose, so each language has the page written out whole (see about/page.tsx).
const CONTENT: Record<Locale, typeof SupportEn> = {
  en: SupportEn,
  "zh-hans": SupportZhHans,
  "zh-hant": SupportZhHant,
  ja: SupportJa,
  ko: SupportKo,
};

export default async function SupportPage() {
  const { locale, path } = await getI18n();
  const Content = CONTENT[locale];
  return <Content path={path} />;
}
