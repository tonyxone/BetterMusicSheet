import Link from "next/link";
import { UploadForm } from "./upload-form";
import { DemoSampleCard } from "./demo-sample-card";

// What a first-time visitor - and a crawler, which is always a first-time
// visitor - gets at "/". It has to be real content in the served HTML rather
// than something the browser fills in later: this page is a static export, so
// whatever the root route renders at build time IS the page anyone fetching
// the domain receives. It once rendered nothing at all while the session check
// settled, which meant the site's own front page served a logo and three
// footer links and no description of what any of it was for.
//
// Deliberately not a copy of /about. That page is the long answer - how
// recognition works, where it fails, what the labels mean. This is the short
// one, and the two should not read as the same text twice.
export function Landing() {
  return (
    <div className="wrap medium landing">
      <h1 className="serif landing-title">
        Every note on your sheet music, labelled
      </h1>
      <p className="landing-lead">
        Upload a PDF or a photo of piano music and get the same score back with
        the letter name printed above every note. Then practise with it, played
        back on an on-screen keyboard with the notes lighting up as they sound.
      </p>

      <UploadForm heading={false} />

      <section className="landing-section">
        <h2>Or try it first</h2>
        <p>No file to hand? Play a sample sheet right away - no upload, no account.</p>
        <DemoSampleCard />
      </section>

      <section className="landing-section">
        <h2>How it works</h2>
        <ol className="landing-steps">
          <li>
            <strong>Upload your music.</strong> A PDF works best. A photo of a
            page works too, if it is flat and evenly lit.
          </li>
          <li>
            <strong>It gets read.</strong> Optical music recognition finds the
            staves, clefs, key signatures and noteheads, and works out what each
            note is. Pages that come back badly read are automatically read
            again.
          </li>
          <li>
            <strong>You get it back annotated.</strong> The same engraving, same
            layout, with a letter name over each note — and a practice mode that
            plays it.
          </li>
        </ol>
      </section>

      <section className="landing-section">
        <h2>What you get</h2>
        <ul className="landing-list">
          <li>
            <strong>Note names where you are already looking</strong> — printed
            over the noteheads, close enough to read at playing distance without
            burying the notation.
          </li>
          <li>
            <strong>Spelling and size you choose</strong> — sharps or flats,
            octave numbers if you are still learning where middle C sits, and
            label size to suit how far away the music sits.
          </li>
          <li>
            <strong>A practice mode</strong> — the annotated sheet above an
            88-key keyboard, playing back with each hand in its own colour and a
            playhead following the music. Click any bar to start there.
          </li>
          <li>
            <strong>Your original, untouched</strong> — the labels are drawn on
            a copy. You can switch back to the unannotated sheet at any time.
          </li>
        </ul>
      </section>

      <section className="landing-section">
        <h2>Before you rely on it</h2>
        <p>
          Optical music recognition is genuinely hard, and this is a reading aid
          rather than a proofreader. Handwritten music is mostly beyond it, and
          dense passages — fast runs, heavy ornamentation — lose notes more
          often than plain writing does. Check the result against your original.{" "}
          <Link href="/about">What it struggles with, in full</Link>.
        </p>
      </section>

      <section className="landing-section">
        <h2>Cost</h2>
        <p>
          Free, and no account needed. Signing in is optional and only attaches
          your sheets to you so they survive a change of browser — see the{" "}
          <Link href="/privacy">privacy policy</Link> for what is stored.
        </p>
      </section>
    </div>
  );
}
