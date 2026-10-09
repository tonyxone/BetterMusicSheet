// <title>, description and the hreflang links for a page, in the page's own
// language. Every public page lists its versions in all the languages, so a
// search engine shows each reader the one in theirs.

import type { Metadata } from "next";
import { SITE_URL } from "@/app/site";
import { LOCALES, LOCALE_TAGS, localePath } from "./config";
import { fmt } from "./format";
import type { Messages } from "./messages/en";
import { getI18n } from "./server";

type MetaKey = "about" | "support" | "privacy" | "terms" | "plans";

/** ``path`` with its trailing slash, as the static export serves it. */
export async function pageMetadata(path: string, page?: MetaKey): Promise<Metadata> {
  const { locale, m } = await getI18n();
  const meta: Messages["meta"] = m.meta;
  const languages: Record<string, string> = { "x-default": path };
  for (const l of LOCALES) languages[LOCALE_TAGS[l]] = localePath(l, path);
  return {
    metadataBase: new URL(SITE_URL),
    title: page ? fmt(meta.pageTitle, { page: meta[page] }) : meta.siteTitle,
    description: page ? meta[`${page}Description`] : meta.siteDescription,
    alternates: { canonical: localePath(locale, path), languages },
  };
}

/** The defaults every page starts from - its own pageMetadata adds to them. */
export async function rootMetadata(): Promise<Metadata> {
  const { m } = await getI18n();
  return { metadataBase: new URL(SITE_URL), title: m.meta.siteTitle, description: m.meta.siteDescription };
}
