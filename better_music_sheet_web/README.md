This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Playback verification

`npm test` covers timing through a 300 ms UI stall, unison deduplication,
all 88 piano keys at every sample layer, and pause/seek cancellation against
the installed sampler. `node tests/prepare-audio-browser.mjs` creates a
temporary `/__audio-qa/index.html` page for real Web Audio checks; remove
`public/__audio-qa` after testing.

`smplr` is pinned to 1.0.0 with `patches/smplr+1.0.0.patch`, applied by
`postinstall`. Its original voice implementation ignores stop requests once
a note's duration has scheduled a future release. The patch permits an earlier
release, fades interrupted notes over 20 ms, and cancels future attacks.
Keep the patch until these cancellation tests pass with an upstream fix.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
