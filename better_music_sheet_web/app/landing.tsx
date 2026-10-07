"use client";

import Link from "next/link";
import { UploadForm } from "./upload-form";
import { DemoSampleCard } from "./demo-sample-card";
import { useI18n } from "@/lib/i18n/client";
import { rich } from "@/lib/i18n/format";

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
  const { m, path } = useI18n();
  const t = m.landing;
  return (
    <div className="wrap medium landing">
      <h1 className="serif landing-title">{t.title}</h1>
      <p className="landing-lead">{t.lead}</p>

      <UploadForm heading={false} />

      <section className="landing-section">
        <h2>{t.tryHeading}</h2>
        <p>{t.tryBody}</p>
        <DemoSampleCard />
      </section>

      <section className="landing-section">
        <h2>{t.howHeading}</h2>
        <ol className="landing-steps">
          {t.steps.map((step) => (
            <li key={step.title}>
              <strong>{step.title}</strong>{t.stepSeparator}{step.body}
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section">
        <h2>{t.getHeading}</h2>
        <ul className="landing-list">
          {t.gets.map((item) => (
            <li key={item.title}>
              <strong>{item.title}</strong>{t.getSeparator}{item.body}
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-section">
        <h2>{t.relyHeading}</h2>
        <p>{rich(t.relyBody, { about: (text) => <Link href={path("/about")}>{text}</Link> })}</p>
      </section>

      <section className="landing-section">
        <h2>{t.costHeading}</h2>
        <p>
          {rich(t.costBody, {
            plans: (text) => <Link href={path("/subscription/plans")}>{text}</Link>,
            privacy: (text) => <Link href={path("/privacy")}>{text}</Link>,
          })}
        </p>
      </section>
    </div>
  );
}
