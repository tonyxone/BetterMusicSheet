import type { Metadata } from "next";
import Link from "next/link";
import { BackButton } from "../back-button";

export const metadata: Metadata = {
  title: "Privacy | BetterMusicSheet.com",
  description: "What BetterMusicSheet collects, why, and how to get rid of it.",
};

// Plain words for the people using the website, not a description of how it
// is built - and about the website only (owner decision).
export default function PrivacyPage() {
  return (
    <div className="wrap medium legal">
      <div className="page-title-row">
        <BackButton />
        <h1 className="serif">Privacy</h1>
      </div>
      <div className="sub">Last updated 6 October 2026</div>

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
          copies and playback made from them, and your edits.
        </li>
        <li>
          <strong>Your subscription.</strong> Stripe handles payments. We only
          keep your plan and its dates, never your card details.
        </li>
      </ul>
      <p>
        Your data is kept on servers in the United States.
      </p>

      <h2>Analytics</h2>
      <p>
        We use Google Analytics to see how pages are used. It never receives
        your sheets, and there are no ads. Google handles this data under{" "}
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
      <p>
        When someone else uploads exactly the same file, their copy is made
        from the note names and playback already worked out for it, instead of
        being read again. Nothing about you goes with it, and they get only
        what their own file would have given them.
      </p>

      <h2>Keeping and removing your data</h2>
      <p>
        Your sheets are kept until you delete them, which you can do from your{" "}
        <Link href="/history">Library</Link>. To delete your account, choose Delete
        account from the menu under your name at the top of the page. Delete your
        sheets first if you want them gone too, and cancel any subscription
        first: deleting your account doesn&apos;t cancel it.
      </p>
      <p>
        Deleting a sheet means nothing made from it is offered for anyone
        else&apos;s uploads any more. A copy someone already received from their
        own upload of the same file is theirs, and stays with them.
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
