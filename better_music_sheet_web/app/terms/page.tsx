import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms | BetterMusicSheet.com",
  description: "The terms you accept by using BetterMusicSheet.",
};

export default function TermsPage() {
  return (
    <div className="wrap medium legal">
      <h1 className="serif">Terms of use</h1>
      <div className="sub">Last updated 12 September 2026</div>

      <p>
        By using BetterMusicSheet you accept these terms. They are short on
        purpose.
      </p>

      <h2>What the site does</h2>
      <p>
        You upload sheet music; the site reads it with optical music recognition
        and returns a copy with note names printed on it, plus data for playing
        it back on an on-screen keyboard.
      </p>

      <h2>Copyright in what you upload</h2>
      <p>
        Most sheet music is copyrighted, and a great deal of it is explicitly
        marked against copying. By uploading a file you confirm you have the
        right to do so — because you own it, because it is out of copyright,
        because it is licensed to you, or because your use is otherwise
        permitted. You keep whatever rights you already held; uploading grants
        this site no ownership, and the only use made of your file is producing
        your annotated copy.
      </p>
      <p>
        Please do not upload material you have no right to, and do not use this
        site to redistribute copyrighted music. If you believe something here
        infringes your copyright, email{" "}
        <a href="mailto:copyright@bettermusicsheet.com">copyright@bettermusicsheet.com</a>{" "}
        with enough detail to identify the work and it will be removed.
      </p>

      <h2>Accuracy</h2>
      <p>
        Optical music recognition is imperfect. Notes are misread, ornaments and
        unusual notation are missed, and rhythm in the playback is an
        approximation. <strong>Check the output against the original before
        relying on it</strong>, particularly for performance, teaching, or
        examination. It is a reading aid, not an authority.
      </p>

      <h2>Availability</h2>
      <p>
        The site is offered as-is and free of charge, with no guarantee of
        uptime, of your files being retained, or of it continuing to exist.
        Keep your own copy of anything you care about. Processing capacity is
        limited, so uploads may queue at busy times, and abusive or automated
        use may be blocked.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, the site and its author are not liable for
        losses arising from using it — including misread notation, lost uploads,
        or interruptions. Nothing here removes rights you have that cannot be
        waived under the law where you live.
      </p>

      <h2>Changes</h2>
      <p>
        These terms may change; the date above will say when. Continuing to use
        the site after a change means accepting it.
      </p>
    </div>
  );
}
