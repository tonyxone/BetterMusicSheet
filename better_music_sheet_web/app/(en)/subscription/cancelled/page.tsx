import Link from "next/link";
import { getI18n } from "@/lib/i18n/server";

export default async function CheckoutCancelled() {
  const { m, path } = await getI18n();
  const t = m.subscription;
  return <div className="wrap medium subscription-page subscription-return"><h1 className="serif">{t.cancelledTitle}</h1><p>{t.cancelledBody}</p><Link className="btn-pill ghost" href={path("/subscription/upgrade")}>{t.seePlans}</Link></div>;
}
