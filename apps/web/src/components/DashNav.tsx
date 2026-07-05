/**
 * DashNav — the shared compact top nav for every (dash) page (N6 consistency sweep, 2026-07-04).
 *
 * The dashboard surfaces were islands: the nav had been trimmed to a subset, so the two canonical
 * Terminal-Glass reference pages (/ overview, /efficiency verdict) and /rewards were unreachable from
 * the nav on the pages that omitted them. This lifts the nav into ONE shared server component so all
 * ten active analytics surfaces share a single compact bar, rendered once by (dash)/layout.tsx.
 *
 * Pure presentation: NO data fetching here — the layout still owns requireOperator() and passes the
 * email in as a prop. Server component (no client hooks), matching the pages' own server-rendered idiom.
 */
import Link from 'next/link';
import type { ReactElement } from 'react';

// ── /signals TOGGLE ────────────────────────────────────────────────────────────────────────────────
// Flipped to `true` at N1 integration (2026-07-04): app/(dash)/signals/page.tsx exists — the verdict-explorer
// flagship, placed right after /efficiency. Kept as a greppable switch (INCLUDE_SIGNALS) in case the route
// is ever pulled from nav.
const INCLUDE_SIGNALS = true;

/**
 * The shared route list — [href, label]. Order: the two canonical Terminal-Glass reference pages first
 * (overview, efficiency), then the forward-paper plays (convergence, maker-exit, amsterdam, paper-trade),
 * then the analytics surfaces (accuracy, sharps, rewards, whales). Labels kept short so the bar stays
 * compact and wraps gracefully (nav.topnav is flex-wrap). The brand also links home; the explicit
 * "overview" entry gives / a labeled, discoverable link from every page (the N6 brief lists / in the set).
 */
export const DASH_NAV: ReadonlyArray<readonly [string, string]> = [
  ['/', 'overview'], // the analytics front door — forecast skill vs. market (reference idiom)
  ['/efficiency', 'efficiency'], // THE VERDICT — the falsified-lever proof (reference idiom)
  ...(INCLUDE_SIGNALS ? ([['/signals', 'signals']] as const) : []), // the verdict explorer — flagship (N1)
  ['/convergence', 'convergence'], // the 12th signal — opening-convergence forward-paper (dash_convergence)
  ['/maker-exit', 'maker-exit'], // the maker-exit variant — first +EV config (dash_maker_exit)
  ['/trading', 'trading'], // LIVE-RAIL activation + risk console (dash_trading, 0082 staged dark)
  ['/amsterdam', 'amsterdam'], // the one-accurate-city paper-trade head-to-head
  ['/paper-trade', 'paper-trade'], // the multi-city generalization — Singapore + Karachi (dash_city_sim)
  ['/data', 'accuracy'], // forecast accuracy by market — best/worst stations + the Brier gap (dash_data)
  ['/sharps', 'sharps'], // SPORTS-sharps roster + fingerprints (9th signal DORMANT)
  ['/rewards', 'rewards'], // funded-weather liquidity-reward pool tracker (dash_market_rewards)
  ['/whaletracker', 'whales'], // ≥$100k Polymarket whale-trade tracker (whale-watch feed)
] as const;

export function DashNav({ email }: { email: string }): ReactElement {
  return (
    <nav className="topnav">
      <Link href="/" className="brand">
        ⛅ Weather Edge
      </Link>
      {DASH_NAV.map(([href, label]) => (
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
  );
}
