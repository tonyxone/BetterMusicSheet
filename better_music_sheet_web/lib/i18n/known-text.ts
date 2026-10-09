// Text that reaches the page in English from somewhere other than this app's
// own messages - the server's job stages and errors, and a few lib/ helpers
// that stay language-free so their tests can read them - shown in the page's
// language when it is recognised, and as it came when it isn't.
//
// The patterns are the English messages themselves (en.known): a {name} in
// one matches whatever stands there, which is then carried into the
// translation. So wording changed on the server only needs changing in
// en.ts, and something new simply shows in English until it is added.

import { en, type Messages } from "./messages/en";
import { fmt } from "./format";

type Section = keyof Messages["known"];
type Pattern = { regex: RegExp; names: string[]; section: Section; key: string; literal: number };

let patterns: Pattern[] | null = null;

function compile(): Pattern[] {
  const out: Pattern[] = [];
  for (const section of Object.keys(en.known) as Section[]) {
    for (const [key, template] of Object.entries(en.known[section])) {
      const names: string[] = [];
      const source = template
        .split(/(\{\w+\})/)
        .map((part) => {
          const name = /^\{(\w+)\}$/.exec(part)?.[1];
          if (name) {
            names.push(name);
            // Never across a " · ": a stage line is several messages joined
            // by it, and each is matched on its own.
            return "([^·]+?)";
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("");
      out.push({ regex: new RegExp(`^${source}$`), names, section, key, literal: template.replace(/\{\w+\}/g, "").length });
    }
  }
  // The most specific first: "re-reading them should take {time}" also fits
  // "{low}-{high} minutes" when the time is "2-4 minutes".
  return out.sort((a, b) => b.literal - a.literal);
}

function translateOne(text: string, m: Messages): string | null {
  patterns ??= compile();
  const trimmed = text.trim();
  for (const p of patterns) {
    const match = p.regex.exec(trimmed);
    if (!match) continue;
    const vars: Record<string, string> = {};
    // What fills a slot can be a message of its own ("about 3 minutes").
    p.names.forEach((name, i) => { vars[name] = translateOne(match[i + 1], m) ?? match[i + 1]; });
    return fmt((m.known[p.section] as Record<string, string>)[p.key], vars);
  }
  return null;
}

/** ``text`` in the language of ``m``, as far as it is recognised. */
export function translateKnown(text: string | null | undefined, m: Messages): string {
  if (!text) return "";
  if (m === en) return text;
  const whole = translateOne(text, m);
  if (whole !== null) return whole;
  // A job's stage is built up from parts: "Reading sheet music (page 2 of 5)
  // · about 3 minutes · 1,234 notes to read".
  return text.split(" · ").map((part) => {
    const page = /^(.*?) (\(page \d+ of \d+\))$/.exec(part);
    // No space between: each language's "page" message brings its own.
    if (page) return `${translateOne(page[1], m) ?? page[1]}${translateOne(page[2], m) ?? ` ${page[2]}`}`;
    return translateOne(part, m) ?? part;
  }).join(" · ");
}
