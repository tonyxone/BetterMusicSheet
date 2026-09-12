import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About | BetterMusicSheet.com",
  description:
    "How BetterMusicSheet reads sheet music, what the annotations mean, and what the recognition can and cannot do.",
};

export default function AboutPage() {
  return (
    <div className="wrap medium legal">
      <h1 className="serif">About</h1>
      <div className="sub">What this does, and what it cannot do</div>

      <p>
        Reading sheet music means turning a dot on a line into a note name, and
        then into a key under your finger. Experienced players stop noticing that
        step. Everyone else is doing arithmetic in the middle of a piece.
      </p>
      <p>
        BetterMusicSheet does that step for you. Upload a PDF or a photo of
        piano music and you get the same score back with every note labelled,
        plus a playback mode that lights the notes up on a keyboard as they
        sound.
      </p>

      <h2>What the labels mean</h2>
      <p>
        Each notehead is labelled with its letter name — <code>C</code>,{" "}
        <code>F♯</code>, <code>B♭</code> — printed close enough to be read at
        playing distance without burying the notation underneath. Notes that
        sound together are grouped, so a chord reads as one label rather than a
        stack of them.
      </p>
      <p>
        You can switch between sharp and flat spellings, add octave numbers if
        you are learning where middle C sits, and set the label size to suit how
        far away the music sits.
      </p>

      <h2>How it works</h2>
      <p>
        Recognition uses{" "}
        <a href="https://github.com/Audiveris/audiveris" target="_blank" rel="noreferrer noopener">
          Audiveris
        </a>
        , an open-source optical music recognition engine. It finds staves,
        clefs, key signatures, and noteheads, and works out each note&apos;s
        pitch. The site then draws the labels onto a copy of your PDF and builds
        a timeline for playback. Your file is processed on this site&apos;s own
        servers; it is not sent to a third-party service.
      </p>
      <p>
        Pages that come back badly recognised are automatically retried at a
        higher resolution, which helps with dense engraving and with photos.
      </p>

      <h2>What it struggles with</h2>
      <p>
        Optical music recognition is genuinely hard, and it is better to know the
        limits than to be surprised by them:
      </p>
      <ul>
        <li>
          <strong>Photographs</strong> work, but a flat, evenly lit, straight-on
          shot works far better than one at an angle. A real PDF is always best.
        </li>
        <li>
          <strong>Handwritten music</strong> is mostly beyond it.
        </li>
        <li>
          <strong>Dense passages</strong> — fast runs, tight ledger lines, heavy
          ornamentation — lose notes more often than plain writing does.
        </li>
        <li>
          <strong>Playback rhythm is an approximation.</strong> Where a time
          signature cannot be read, timing is guessed, and the result may drift.
        </li>
      </ul>
      <p>
        Check the output against the original before you rely on it. It is a
        reading aid, not a proofreader.
      </p>

      <h2>Cost and accounts</h2>
      <p>
        The site is free and needs no account. Signing in is optional and only
        attaches your sheets to you so they survive a change of browser. What
        happens to your files is set out in the{" "}
        <a href="/privacy">privacy policy</a>.
      </p>

      <h2>Getting in touch</h2>
      <p>
        Corrections, bug reports, and sheets it read badly are all welcome at{" "}
        <a href="mailto:bettermusicsheet@gmail.com">bettermusicsheet@gmail.com</a>.
        A sheet that comes out wrong is genuinely useful to see.
      </p>
    </div>
  );
}
