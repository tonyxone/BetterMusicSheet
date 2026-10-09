import Link from "next/link";
import { getI18n } from "@/lib/i18n/server";
import { LanguagePicker } from "./language-picker";

// Server component on purpose: it is static links, so it adds nothing to the
// client bundle on any route. Only the language picker runs in the browser.
export async function Footer() {
  const { m, path } = await getI18n();
  return (
    <footer className="site-footer">
      <nav className="footer-links">
        <Link href={path("/about")}>{m.footer.about}</Link>
        <Link href={path("/privacy")}>{m.footer.privacy}</Link>
        <Link href={path("/terms")}>{m.footer.terms}</Link>
        <Link href={path("/support")}>{m.footer.support}</Link>
        {/* Reachable from every page rather than only from inside About: a
            visitor who wants to report a badly-read sheet should not have to
            go looking for the address. */}
        <a href="mailto:bettermusicsheet@gmail.com">{m.footer.contact}</a>
      </nav>
      <LanguagePicker />
      <div className="footer-note">{m.footer.disclaimer}</div>
    </footer>
  );
}
