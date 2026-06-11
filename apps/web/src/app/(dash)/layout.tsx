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

const NAV = [
  ['/', 'today'],
  ['/calibration', 'calibration'],
  ['/bets', 'bets'],
  ['/system', 'system'],
  ['/admin', 'admin'],
] as const;

export default async function DashLayout({ children }: { children: ReactNode }): Promise<ReactElement> {
  const email = await requireOperator();
  return (
    <div className="shell">
      <nav className="topnav">
        <span className="brand">⛅ Weather Edge</span>
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
