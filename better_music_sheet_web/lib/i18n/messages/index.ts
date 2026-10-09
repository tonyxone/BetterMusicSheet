// Every language's messages, for server components and the root layouts -
// which pass only the page's own language on to the client (lib/i18n/client).

import type { Locale } from "../config";
import { en, type Messages } from "./en";
import { zhHans } from "./zh-hans";
import { zhHant } from "./zh-hant";
import { ja } from "./ja";
import { ko } from "./ko";

export const MESSAGES: Record<Locale, Messages> = {
  en,
  "zh-hans": zhHans,
  "zh-hant": zhHant,
  ja,
  ko,
};
