import Link from "next/link";
import { BackButton } from "../../../back-button";

// About the website only (owner decision): the plans, billing, getting good
// results, and deleting data.
export function SupportEn({ path }: { path: (p: string) => string }) {
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
        Please say which browser you use, and attach the sheet if it was read
        badly.
      </p>

      <h2>Free and Premium</h2>
      <p>
        A free account keeps one sheet at a time - to upload another, delete the
        one you have - and practice mode plays the first two lines of a sheet.
        Premium keeps as many sheets as you like and unlocks the full practice
        mode.
      </p>

      <h2>Managing or cancelling a subscription</h2>
      <p>
        Change your plan or cancel from your{" "}
        <Link href={path("/subscription")}>subscription page</Link>. Cancelling keeps
        Premium until the end of the period you paid for.
      </p>

      <h2>Premium isn&apos;t showing after I paid</h2>
      <p>
        A subscription belongs to the account that bought it, so make sure you
        are signed in to that account, then reload the page. If it still
        doesn&apos;t show, email us.
      </p>

      <h2>Getting the best results</h2>
      <p>
        Upload a PDF where you can: note names are read far more reliably from a
        PDF than from a photo, and some photos can&apos;t be read at all. For a
        photo, lay the page flat in even light and fill the frame with it. Note
        names are recognised automatically, so check them against your original;
        you can correct a name on the sheet page.
      </p>

      <h2>Deleting your data</h2>
      <p>
        Delete sheets from your <Link href={path("/history")}>Library</Link>. To delete
        your account, choose Delete account from the menu under your name at the
        top of the page. Deleting your account doesn&apos;t cancel a
        subscription, so cancel it first. The{" "}
        <Link href={path("/privacy")}>privacy policy</Link> explains what is kept and how
        to ask for anything else to be removed.
      </p>

      <p>
        See also the <Link href={path("/terms")}>terms of use</Link>.
      </p>
    </div>
  );
}
