import type { Metadata } from "next";
import Link from "next/link";
import { BackButton } from "../back-button";

export const metadata: Metadata = {
  title: "Privacy | BetterMusicSheet.com",
  description: "What BetterMusicSheet collects, why, and how to get rid of it.",
};

// Plain words for the people using the site, not a description of how it is
// built. Still complete: the App Store listing links here, so it has to
// cover what is collected, the ads and analytics, payments and deletion.
export default function PrivacyPage() {
  return (
    <div className="wrap medium legal">
      <div className="page-title-row">
        <BackButton />
        <h1 className="serif">Privacy</h1>
      </div>
      <div className="sub">Last updated 28 September 2026</div>

      <p>
        This page explains what BetterMusicSheet keeps about you, why, and how
        to remove it.
      </p>

      <h2>What we keep</h2>
      <ul>
        <li>
          <strong>Your account.</strong> Your email address and name, so you can
          sign in and your sheets stay with your account. You need an account to
          upload sheets.
        </li>
        <li>
          <strong>If you aren&apos;t signed in,</strong> a random ID saved in your
          browser, so you can see your own sheets. It isn&apos;t linked to who
          you are.
        </li>
        <li>
          <strong>Your sheets.</strong> The files you upload, the annotated
          copies and playback made from them, and your edits. In the iOS app,
          the camera and your photos are only used when you choose to add a
          sheet, and only the photo you pick is uploaded.
        </li>
        <li>
          <strong>Your subscription.</strong> Apple handles payments in the iOS
          app and Stripe on the website. We only keep your plan and its dates,
          never your card details.
        </li>
      </ul>
      <p>
        Your data is kept on servers in the United States. The iOS app also keeps
        your sign-in and copies of your sheets on your device.
      </p>

      <h2>Analytics and ads</h2>
      <p>
        The website uses Google Analytics to see how pages are used. It never
        receives your sheets.
      </p>
      <p>
        The free plan in the iOS app shows ads from Google. They aren&apos;t
        personalized and the app doesn&apos;t ask to track you, but Google may
        still collect things like your IP address, device information and how
        you interact with ads, to show and measure them. Your sheets are never
        shared with Google. Premium has no ads, and neither does the website.
        You can change your ad privacy choices from the Account screen in the
        app. Google handles this data under{" "}
        <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer noopener">
          Google&apos;s privacy policy
        </a>
        .
      </p>

      <h2>What we don&apos;t do</h2>
      <p>
        We don&apos;t sell, share or publish your sheet music, or use it to train
        AI. We read it ourselves; it isn&apos;t sent to anyone else to process.
      </p>

      <h2>Keeping and removing your data</h2>
      <p>
        Your sheets are kept until you delete them, which you can do from your{" "}
        <Link href="/history">Library</Link>. You can delete your account from the
        Account screen in the iOS app; delete your sheets first if you want them
        gone too. Deleting your account doesn&apos;t cancel an Apple subscription;
        cancel it in your iPhone or iPad Settings.
      </p>
      <p>
        To ask what we hold about you, or to have anything removed, email{" "}
        <a href="mailto:bettermusicsheet@gmail.com">bettermusicsheet@gmail.com</a>.
      </p>

      <h2>Changes</h2>
      <p>If this policy changes, the date at the top changes with it.</p>
    </div>
  );
}
