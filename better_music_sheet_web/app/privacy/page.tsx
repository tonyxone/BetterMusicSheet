import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy | BetterMusicSheet.com",
  description: "What BetterMusicSheet collects, why, and how to get rid of it.",
};

export default function PrivacyPage() {
  return (
    <div className="wrap medium legal">
      <h1 className="serif">Privacy</h1>
      <div className="sub">Last updated 12 September 2026</div>

      <p>
        BetterMusicSheet annotates sheet music you upload. This page describes
        everything the site stores about you and how to remove it. It is written
        to be read, not to be impressive.
      </p>

      <h2>What is stored</h2>

      <h3>An anonymous id, if you are signed out</h3>
      <p>
        The first time you visit, your browser generates a random identifier and
        keeps it in a cookie named <code>guest_id</code> for one year. It exists
        so the site can show you your own uploads and nobody else&apos;s. It is
        not linked to your name, email, or any profile, and it is not shared with
        anyone. Clearing your cookies discards it — along with your ability to
        reach sheets uploaded under it.
      </p>

      <h3>An account, only if you create one</h3>
      <p>
        Signing in is optional; uploading works without it. If you do sign in,
        sign-in is handled by Amazon Cognito, and the site stores the account
        identifier it issues, your email address, and a display name. It is used
        to attach sheets to your account so they survive a change of browser.
      </p>

      <h3>The files you upload, and what is made from them</h3>
      <p>
        Uploaded PDFs and images are stored in Amazon S3, along with the
        annotated PDF and the playback data generated from them. A record of the
        job — the filename, the options you chose, timestamps, and whether it
        succeeded — is stored in Amazon DynamoDB. Everything is held in AWS&apos;s
        <code>us-west-1</code> region in the United States.
      </p>

      <h3>Analytics and advertising</h3>
      <p>
        The site loads Google Analytics, which records page views and general
        usage patterns. It also loads Google AdSense&apos;s script. Both are
        Google products and Google may set its own cookies through them; their
        handling is governed by{" "}
        <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer noopener">
          Google&apos;s privacy policy
        </a>
        . Neither receives your uploaded files.
      </p>

      <h2>What is not done</h2>
      <p>
        Your sheet music is not sold, shared, published, or used to train
        anything. Recognition runs on this site&apos;s own servers using
        Audiveris, an open-source engine; files are not sent to a third-party
        service for processing.
      </p>

      <h2>How long it is kept</h2>
      <p>
        Uploads and their results are kept until you delete them. Deleting a
        sheet from your history removes the original upload, the annotated PDF,
        and the playback data. There is currently no automatic expiry, so
        anything you leave stays until you remove it.
      </p>

      <h2>Removing your data</h2>
      <p>
        Delete individual sheets from the <a href="/history">History</a> page.
        To remove an account and everything attached to it, or to ask what is
        held about you, email{" "}
        <a href="mailto:privacy@bettermusicsheet.com">privacy@bettermusicsheet.com</a>.
      </p>

      <h2>Children</h2>
      <p>
        This site is not directed at children under 13 and accounts are not
        knowingly created for them.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes, the date at the top changes with it.
      </p>
    </div>
  );
}
