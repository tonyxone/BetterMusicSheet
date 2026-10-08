// Filling in a translated string. No React hooks, so server and client
// components share it.
//
//   fmt("{count} notes labeled", { count: 3 })       -> "3 notes labeled"
//   plural(locale, n, { one: "...", other: "..." })   -> the form for n
//   rich("No sheets yet. <link>Upload one</link>.", { link: (text) => <Link>{text}</Link> })
//
// Markup in a string is how a link or bold run keeps its place when a
// translation reorders the sentence around it - Japanese and Korean put the
// verb last, so a link can't be glued on at the end.

import { Fragment, createElement, type ReactNode } from "react";
import { LOCALE_TAGS, type Locale } from "./config";

export type Vars = Record<string, string | number>;

/** One message in the forms a count can take. Chinese, Japanese and Korean
 * have only ``other``, but ``one`` is still required so every language has
 * the same shape as English. */
export type Plural = { one: string; other: string };

export function fmt(template: string, vars: Vars = {}) {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole);
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

export function plural(locale: Locale, count: number, forms: Plural, vars: Vars = {}) {
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, rules = new Intl.PluralRules(LOCALE_TAGS[locale]));
  const form = rules.select(count) === "one" ? forms.one : forms.other;
  return fmt(form, { count, ...vars });
}

/** ``template`` with each ``<tag>text</tag>`` replaced by ``tags[tag](text)``
 * and each ``{name}`` by ``vars[name]`` (which may itself be an element).
 * Tags don't nest - none of the messages need them to. */
export function rich(
  template: string,
  tags: Record<string, (chunk: ReactNode) => ReactNode> = {},
  vars: Record<string, ReactNode> = {},
): ReactNode {
  const out: ReactNode[] = [];
  const pattern = /<(\w+)>(.*?)<\/\1>|\{(\w+)\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template))) {
    if (match.index > last) out.push(template.slice(last, match.index));
    const [whole, tag, inner, name] = match;
    if (tag) out.push(tags[tag] ? tags[tag](inner) : inner);
    else out.push(name in vars ? vars[name] : whole);
    last = match.index + whole.length;
  }
  if (last < template.length) out.push(template.slice(last));
  return out.map((part, i) => createElement(Fragment, { key: i }, part));
}

export function formatNumber(locale: Locale, value: number) {
  return value.toLocaleString(LOCALE_TAGS[locale]);
}
