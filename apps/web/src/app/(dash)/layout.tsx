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

// Nav trimmed to the active surfaces (2026-06-29): the opening-convergence paper play + the four kept analytics
// pages. The rest (overview, verdict, replica, rewards, events, calibration, system, bets, admin) are HIDDEN from
// nav but their routes are intentionally kept reachable by direct URL (non-destructive — operator's call).
const NAV = [
  ['/convergence', 'convergence'], // the 12th signal — opening-convergence forward-paper overview (dash_convergence, 0069)
  ['/amsterdam', 'amsterdam'], // the one-accurate-city paper-trade head-to-head (analytics deliverable)
  ['/whaletracker', 'whales'], // ≥$100k Polymarket whale-trade tracker (analytics; whale-watch feed, 0055)
  ['/data', 'accuracy'], // forecast accuracy by market — best/worst stations + the Brier gap (dash_data, 0065)
  ['/sharps', 'sharps'], // SPORTS-sharps roster + fingerprints (analytics; 9th signal DORMANT)
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
