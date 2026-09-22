import Link from "next/link";
import { DEMO_JOB_ID } from "@/lib/api";

/** A standing, no-commitment invite to try Play - no upload, no account, no
 * subscription. Shown on both the landing page (signed out) and the library
 * (signed in), since it's for anyone who hasn't tried practice mode yet, not
 * just a first-time visitor. The backend's demo read carve-out (see
 * server.py's DEMO_JOB_ID) is what makes the link work for everyone. */
export function DemoSampleCard() {
  return (
    <Link
      href={`/play?job=${DEMO_JOB_ID}`}
      className="history-row"
      title="Try practice mode with a sample sheet - free, no account needed"
    >
      <div className="history-icon">🎼</div>
      <div className="history-info">
        <div className="history-title">Try a sample</div>
        <div className="history-meta">Ode to Joy · Beethoven · free, no account needed</div>
      </div>
      <span className="history-badge done">Play</span>
    </Link>
  );
}
