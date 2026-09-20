import Link from "next/link";

// Server component on purpose: it is static links, so it adds nothing to the
// client bundle on any route.
export function Footer() {
  return (
    <footer className="site-footer">
      <nav className="footer-links">
        <Link href="/about">About</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        {/* Reachable from every page rather than only from inside About: a
            visitor who wants to report a badly-read sheet should not have to
            go looking for the address. */}
        <a href="mailto:bettermusicsheet@gmail.com">Contact</a>
      </nav>
      <div className="footer-note">
        Note names are recognised automatically and are not always right — check
        against your original before you rely on them.
      </div>
    </footer>
  );
}
