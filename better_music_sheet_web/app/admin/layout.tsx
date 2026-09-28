import type { Metadata } from "next";

// Not linked from anywhere, not in the sitemap, and kept out of search results
// here. It is deliberately not in robots.ts either: a Disallow line there
// would advertise the path. The page itself holds no data - everything comes
// from /api/admin/*, which answers 404 to anyone but an admin.
export const metadata: Metadata = {
  title: "Admin | BetterMusicSheet.com",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return children;
}
