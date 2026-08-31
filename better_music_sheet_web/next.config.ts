import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static HTML/JS/CSS only - no Node server, deployed straight to S3/CloudFront
  // (see infra/). Every page here is already "use client" or a thin server
  // wrapper with no server-side data fetching, so nothing needs Node at
  // request time.
  output: "export",
  // S3 (fronted by CloudFront) serves a "folder" request by looking for
  // <path>/index.html, not <path>.html - trailingSlash makes next export
  // emit sheets/index.html instead of sheets.html, and makes Link/router.push
  // generate matching URLs.
  trailingSlash: true,
};

export default nextConfig;
