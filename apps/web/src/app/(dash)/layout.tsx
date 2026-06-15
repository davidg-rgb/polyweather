/**
 * The dashboard shell (§5 layout.tsx): nav + the session/allow-list guard —
 * every page below this layout requires the single OPERATOR_EMAIL session
 * (requireOperator redirects to /login otherwise). A route group keeps
 * /login outside the guard at unchanged URLs.
 */
import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';
import { requireOperator } from '../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

// Analytics-first nav (2026-06-15 pivot): the overview is the default landing; the (dormant) bet ledger
// is demoted to the end. Order = analytics → ops → dormant trading → admin.
const NAV = [
  ['/', 'overview'], // analytics home — forecast skill vs. market + the measured-efficiency verdict
  ['/events', 'events'], // open events + collection health (WEB-4 / ADR-21)
  ['/calibration', 'calibration'],
  ['/system', 'system'],
  ['/bets', 'bets'], // dormant — trading thesis closed; kept for the historical ledger
  ['/admin', 'admin'],
] as const;

export default async function DashLayout({ children }: { children: ReactNode }): Promise<ReactElement> {
  const email = await requireOperator();
  return (
    <div className="shell">
      <nav className="topnav">
        <Link href="/" className="brand">
          ⛅ Weather Edge
        </Link>
        {NAV.map(([href, label]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
        <span className="session">
          <span>{email}</span>
          <form action="/auth/signout" method="post">
            <button type="submit">sign out</button>
          </form>
        </span>
      </nav>
      <main>{children}</main>
    </div>
  );
}
