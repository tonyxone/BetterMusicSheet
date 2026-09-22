import Link from "next/link";

export default function CheckoutCancelled() {
  return <div className="wrap medium subscription-page subscription-return"><h1 className="serif">Checkout cancelled — no charge</h1><p>You can start a trial whenever you&apos;re ready.</p><Link className="btn-pill ghost" href="/subscription/upgrade">See plans</Link></div>;
}
