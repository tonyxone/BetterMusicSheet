import Link from "next/link";
import { getI18n } from "@/lib/i18n/server";
import { pageMetadata } from "@/lib/i18n/metadata";

export const generateMetadata = () => pageMetadata("/subscription/plans/", "plans");

export default async function PlansPage() {
  const { m, path } = await getI18n();
  const t = m.subscription;
  const p = m.paywall;
  return (
    <div className="wrap medium subscription-page">
      <div className="subscription-hero">
        <p className="subscription-kicker">{p.kicker}</p>
        <h1 className="serif">{p.goPremium}</h1>
        <p>{t.plansBody}</p>
      </div>
      <div className="subscription-plans">
        <article className="subscription-card">
          <h2>{p.monthly}</h2>
          <p className="subscription-price">{p.amountMonthly} <small>{p.perMonth}</small></p>
          <p className="flex-1">{t.plansMonthly}</p>
          <Link className="btn-pill mt-4 w-full text-center" href={path("/subscription/upgrade?plan=monthly")}>{t.getStarted}</Link>
        </article>
        <article className="subscription-card">
          <h2>
            {p.yearly} <span style={{ color: "var(--success)", fontSize: 11, fontWeight: 700, marginLeft: 4 }}>{p.save}</span>
          </h2>
          <p className="subscription-price">{p.amountYearly} <small>{p.perYear}</small></p>
          <p className="flex-1">{t.plansYearly}</p>
          <Link className="btn-pill mt-4 w-full text-center" href={path("/subscription/upgrade?plan=yearly")}>{t.getStarted}</Link>
        </article>
      </div>
      <div className="text-left max-w-md mx-auto mt-10">
        <h2 className="serif" style={{ fontSize: "1.1rem", margin: "0 0 12px" }}>{t.whatYouGet}</h2>
        <ul className="landing-list">
          {t.plansPoints.map((point) => <li key={point}>{point}</li>)}
        </ul>
        <p className="subscription-muted" style={{ marginTop: 16 }}>{t.plansFree}</p>
      </div>
    </div>
  );
}
