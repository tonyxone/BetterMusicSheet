import { RootShell } from "../root-shell";
import { rootMetadata } from "@/lib/i18n/metadata";

// The English site, at the unprefixed URLs. Every other language has the same
// pages under its own prefix - see app/[lang], which re-exports these.
export const generateMetadata = rootMetadata;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <RootShell locale="en">{children}</RootShell>;
}
