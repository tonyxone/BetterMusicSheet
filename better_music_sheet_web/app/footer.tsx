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
      </nav>
      <div className="footer-note">
        Note names are recognised automatically and are not always right — check
        against your original before you rely on them.
      </div>
    </footer>
  );
}
