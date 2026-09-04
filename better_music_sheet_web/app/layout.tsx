import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { Header } from "./header";
import { Analytics } from "./analytics";
import { AuthProvider } from "./auth-context";

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
        <script
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3606656264491246"
          crossOrigin="anonymous"
        />
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-RDB4K5MC4D" />
        <script>{`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-RDB4K5MC4D', { send_page_view: false });
        `}</script>
      </head>
      <body className="min-h-full antialiased">
        <div className="bg-glow" />
        <Suspense fallback={null}>
          <Analytics />
        </Suspense>
        <AuthProvider>
          <Header />
          <main>{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
