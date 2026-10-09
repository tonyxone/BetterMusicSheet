import { getI18n } from "@/lib/i18n/server";
import { LOCALE_TAGS } from "@/lib/i18n/config";

/** Above the Privacy and Terms pages in every language but English: the
 * policy itself isn't translated, and this says which text applies. */
export async function EnglishOnly() {
  const { locale, m } = await getI18n();
  if (locale === "en") return null;
  return <p className="english-only" lang={LOCALE_TAGS[locale]}>{m.language.englishOnly}</p>;
}
