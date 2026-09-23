import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Go Premium | BetterMusicSheet.com",
  description:
    "Compare the monthly and yearly BetterMusicSheet Premium plans, with a 7-day free trial for new subscribers.",
};

export default function PlansPage() {
  return (
    <div className="wrap medium subscription-page">
      <div className="subscription-hero">
        <p className="subscription-kicker">Premium</p>
        <h1 className="serif">Go Premium</h1>
        <p>Unlock full practice mode on web and iOS, with no ads, synced across your devices.</p>
      </div>
      <div className="subscription-plans">
        <article className="subscription-card">
          <h2>Monthly</h2>
          <p className="subscription-price">$1.99 <small>/ month</small></p>
          <p>Billed monthly. 7-day free trial for new subscribers.</p>
          <Link className="btn-pill mt-4 w-full text-center" href="/subscription/upgrade?plan=monthly">Get Started</Link>
        </article>
        <article className="subscription-card">
          <h2>
            Yearly <span style={{ color: "var(--success)", fontSize: 11, fontWeight: 700, marginLeft: 4 }}>Save 20%</span>
          </h2>
          <p className="subscription-price">$19.99 <small>/ year</small></p>
          <p>About $1.67/month, billed yearly. 7-day free trial for new subscribers.</p>
          <Link className="btn-pill mt-4 w-full text-center" href="/subscription/upgrade?plan=yearly">Get Started</Link>
        </article>
      </div>
      <div className="text-left max-w-md mx-auto mt-10">
        <h2 className="serif" style={{ fontSize: "1.1rem", margin: "0 0 12px" }}>What you get</h2>
        <ul className="landing-list">
          <li>Full practice mode on web and iOS — every note lit up as you play</li>
          <li>An ad-free experience across the site</li>
          <li>Access on any device, synced to your account</li>
          <li>Cancel anytime, no long-term commitment</li>
        </ul>
      </div>
    </div>
  );
}
