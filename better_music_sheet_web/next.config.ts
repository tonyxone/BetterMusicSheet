import { execSync } from "node:child_process";
import type { NextConfig } from "next";

function git(args: string) {
  try {
    return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

// Shown on the About page: the release this was built from - the newest
// release tag (v0.0.65 and so on) at or before the commit being built. Read
// once here because a static export has nowhere to look it up later.
const release = git("describe --tags --abbrev=0").replace(/^v/, "") || "dev";

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
  env: { NEXT_PUBLIC_RELEASE: release },
};

export default nextConfig;
