// pdf.js runs its parser in a Web Worker, and the worker file has to be
// fetchable at a stable URL at runtime. Under `output: "export"` there is no
// server to resolve it, and bundler URL tricks
// (new URL(..., import.meta.url)) don't emit assets out of node_modules
// reliably - so copy the worker into public/ and load it from the site root.
//
// Copied from node_modules rather than committed so it can never drift from
// the installed pdfjs-dist version.
//
// The worker is also where pdf.js calls Uint8Array.prototype.toHex, which
// Safari only shipped in 18.2. A worker shares no globals with the page, so
// importing the polyfill in sheet-canvas.tsx cannot reach it - prepend the
// same file here instead, and it stays in step with the page's copy.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require.resolve("pdfjs-dist/package.json");
const src = join(dirname(pkg), "build", "pdf.worker.min.mjs");
const destDir = join(process.cwd(), "public");
const dest = join(destDir, "pdf.worker.min.mjs");
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

const polyfill = readFileSync(join(process.cwd(), "lib", "binary-polyfill.js"), "utf8");
writeFileSync(dest, `${polyfill}\n${readFileSync(dest, "utf8")}`);
console.log("copied pdf.worker.min.mjs -> public/ (with binary polyfill)");
