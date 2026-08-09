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
  // FIRST after overview deliberately: this is the only page carrying REAL MONEY (the operator-directed
  // continuous cheap-early operation, 2026-08-09). Everything else on this bar is paper or analytics.
  ['/operation', 'operation'], // the LIVE lane — state, ledger, attribution, paper control (dash_operation, 0124)
  ['/efficiency', 'efficiency'], // THE VERDICT — the falsified-lever proof (reference idiom)
  ...(INCLUDE_SIGNALS ? ([['/signals', 'signals']] as const) : []), // the verdict explorer — flagship (N1), immediately after /efficiency
  ['/cities', 'cities'], // the CITIES PREDICTION TABLE — per-city pick + success rate + time to close (dash_city_predictions, 0106)
  ['/monitor', 'monitor'], // forward paper CONFIRMATION of C23/C24 — §9R-E gate over time (dash_efficiency_monitor, 0091)
  ['/convergence', 'google'], // "Test 2" — Google-picks-bucket taker forward-paper panel (dash_google_paper)
  ['/maker-exit', 'maker-exit'], // the maker-exit variant — first +EV config (dash_maker_exit)
  ['/cheap-early', 'cheap-early'], // the operator's buy-early/cap-3× forward paper test (dash_cheap_early, 0117)
  ['/trading', 'trading'], // LIVE-RAIL activation + risk console (dash_trading, 0082 staged dark)
  ['/amsterdam', 'amsterdam'], // the one-accurate-city paper-trade head-to-head
  ['/paper-trade', 'buy-table'], // per-city "$10 on our high, bought cheap" archive backtest (city-buy-table-results)
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
