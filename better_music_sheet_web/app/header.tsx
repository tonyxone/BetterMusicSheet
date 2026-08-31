import Link from "next/link";
import { Logo } from "./logo";

export function Header() {
  return (
    <header className="site-header">
      <Link href="/" className="logo" title="Upload another sheet">
        <Logo />
      </Link>
      <nav className="flex items-center gap-3">
        <Link href="/history" className="nav-btn ghost">
          History
        </Link>
      </nav>
    </header>
  );
}
