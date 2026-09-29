import type { Metadata } from "next";
import Link from "next/link";
import { BackButton } from "../back-button";

export const metadata: Metadata = {
  title: "Support | BetterMusicSheet.com",
  description: "Help with BetterMusicSheet on the web, iPhone and iPad, and how to reach us.",
};

// The App Store listing's Support URL points here, so it answers what App
// Store customers ask: billing, restoring, the free plan, and deleting data.
export default function SupportPage() {
  return (
    <div className="wrap medium legal">
      <div className="page-title-row">
        <BackButton />
        <h1 className="serif">Support</h1>
      </div>
      <div className="sub">Last updated 28 September 2026</div>

      <h2>Contact us</h2>
      <p>
        Questions, bug reports, and sheets that came out wrong are all welcome
        at <a href="mailto:bettermusicsheet@gmail.com">bettermusicsheet@gmail.com</a>.
        Please say which device you use, and attach the sheet if it was read
        badly.
      </p>

      <h2>Free and Premium</h2>
      <p>
        With a free account in the iOS app you can keep one sheet at a time and
        use every feature, with ads. To upload another sheet, delete the one you
        have. Premium removes the limit and the ads. One Premium subscription
        works on the website, iPhone, and iPad when you sign in to the same
        account.
      </p>

      <h2>Managing or cancelling a subscription</h2>
      <p>
        If you subscribed in the iOS app, Apple bills you: open Settings on your
        iPhone or iPad, tap your name, then Subscriptions. Cancelling there keeps
        Premium until the end of the period you paid for. If you subscribed on
        the website, manage it from your <Link href="/subscription">subscription page</Link>.
      </p>

      <h2>Premium isn&apos;t showing after I paid</h2>
      <p>
        In the iOS app, open the Account screen and tap Restore Purchases. It
        checks your Apple Account for purchases and adds them to the account
        you are signed in to. A subscription belongs to the account that bought
        it, so sign in to that account first.
      </p>

      <h2>Getting the best results</h2>
      <p>
        Upload a PDF where you can: note names are read far more reliably from a
        PDF than from a photo, and some photos can&apos;t be read at all. For a
        photo, lay the page flat in even light and fill the frame with it. Note
        names are recognised automatically, so check them against your original;
        you can correct a name on the sheet page in the app.
      </p>

      <h2>Deleting your data</h2>
      <p>
        Delete sheets from your library. To delete your account, open the Account
        screen in the iOS app and tap Delete Account. The{" "}
        <Link href="/privacy">privacy policy</Link> explains what is kept and how
        to ask for anything else to be removed. Deleting your account does not
        cancel an Apple subscription; cancel it in Settings as described above.
      </p>

      <p>
        See also the <Link href="/terms">terms of use</Link>.
      </p>
    </div>
  );
}
