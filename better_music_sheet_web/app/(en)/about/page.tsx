import { getI18n } from "@/lib/i18n/server";
import { pageMetadata } from "@/lib/i18n/metadata";
import type { Locale } from "@/lib/i18n/config";
import { AboutEn } from "./content/en";
import { AboutZhHans } from "./content/zh-hans";
import { AboutZhHant } from "./content/zh-hant";
import { AboutJa } from "./content/ja";
import { AboutKo } from "./content/ko";

export const generateMetadata = () => pageMetadata("/about/", "about");

// Prose, so each language has the page written out whole rather than pieced
// together from messages.
const CONTENT: Record<Locale, typeof AboutEn> = {
  en: AboutEn,
  "zh-hans": AboutZhHans,
  "zh-hant": AboutZhHant,
  ja: AboutJa,
  ko: AboutKo,
};

export default async function AboutPage() {
  const { locale, path } = await getI18n();
  const Content = CONTENT[locale];
  return <Content path={path} />;
}
