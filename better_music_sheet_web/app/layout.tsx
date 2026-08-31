import type { Metadata } from "next";
import "./globals.css";
import { Header } from "./header";

export const metadata: Metadata = {
  title: "Better Music Sheet",
  description: "Upload piano sheet music and get every note labeled with its letter name.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600;700&family=Work+Sans:wght@400;500;600&family=Caveat:wght@600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full antialiased">
        <div className="bg-glow" />
        <Header />
        <main>{children}</main>
      </body>
    </html>
  );
}
