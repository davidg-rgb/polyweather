/**
 * core/polymarket/insider — the PURE insider-shape scorer shared by the whale-insider scan
 * (`scripts/research/whale-insider-scan.ts`) and the forward one-off grader (`scripts/whale-grade.ts`).
 *
 * The thesis (WHALE-INSIDER-SCAN.md): net profit + a high win rate do NOT imply information — buying a
 * near-certainty at 0.97 and winning is skill-free, and live in-game sports trading (bet the favorite at
 * 0.85 during the match) wins ~85% on PUBLIC information. The insider signature is the opposite shape: a
 * large bet at non-obvious odds, on a NON-sports resolvable event, placed with LEAD TIME before
 * resolution, that wins — and under an efficient market a bet entered at price p wins with probability p,
 * so an excess of such wins (high z over Σ entry-price) is the only thing that can't be explained by
 * "paid for what they got." This module is the pure, total, network-free core of that judgement.
 *
 * Pure + deterministic: no network, no DB, no clock. []/NaN-safe.
 */

export type MarketCategory = 'sports' | 'crypto' | 'politics' | 'weather' | 'macro' | 'other';

export interface InsiderThresholds {
  /** Entries this near 0 carry ~no information (pure microstructure) — excluded from the insider lens. */
  extremeLo: number;
  /** Entries this near 1 carry ~no information (already decided) — excluded from the insider lens. */
  extremeHi: number;
  /** Max entry odds for an "informative" bet; above this the outcome is near-priced-in, not a tell. */
  infoOddsHi: number;
  /** Lead (days, bet→resolution) at/under which a win is live/last-minute (e.g. in-game), not early info. */
  liveLeadDays: number;
}

export const INSIDER_DEFAULTS: InsiderThresholds = {
  extremeLo: 0.02,
  extremeHi: 0.98,
  infoOddsHi: 0.9,
  liveLeadDays: 1,
};

/**
 * Coarse market category from title (+ optional slug). The point is to separate SPORTS (huge,
 * live-tradeable — a high win rate there is skill/live-betting, not material non-public info) from the
 * markets where "insider" information is the natural explanation (a crypto move, a political/appointment
 * outcome, a world event). Best-effort regex, total. Mirrors the scan's tagger.
 */
export function categorizeMarket(title: string, slug = ''): MarketCategory {
  const t = `${title ?? ''} ${slug ?? ''}`.toLowerCase();
  if (/temperature-in-|highest temperature|lowest temperature/.test(t)) return 'weather';
  if (
    /\bvs\.?\b|spread:|o\/u|moneyline|\b(nba|nfl|nhl|mlb|epl|ufc|atp|wta|cfb|laliga|serie a|bundesliga)\b|\bwin on \d{4}-\d{2}-\d{2}|\bopen:|\bgrand prix\b|dota|valorant|counter-strike|league of legends|\bcs2\b/.test(
      t,
    )
  )
    return 'sports';
  if (/bitcoin|ethereum|\bbtc\b|\beth\b|solana|\bxrp\b|crypto|dogecoin|price of|\$\d+k? by|reach \$/.test(t)) return 'crypto';
  if (
    /election|president|nominee|congress|senate|\btrump\b|\bbiden\b|government|prime minister|cabinet|resign|impeach|parliament|\bfed\b|appoint/.test(
      t,
    )
  )
    return 'politics';
  if (/\b(cpi|inflation|rate cut|interest rate|gdp|jobs report|recession|tariff)\b/.test(t)) return 'macro';
  return 'other';
}

/**
 * Held-to-resolution P&L of a single fill, given the market's winning outcome. Inventory-correct: each
 * fill is a cash↔shares exchange marked to settlement. A BUY of outcome O: `shares × ((O won?1:0) − price)`;
 * a SELL is the inverse (you received `price` now, owe $1 if O wins). `winningOutcome == null`
 * (unresolved/unknown) → 0. This is the right measure for the directional question "did the big bet's side
 * win", independent of any later early exit.
 */
export function fillHeldPnl(
  side: 'BUY' | 'SELL' | null,
  outcome: string,
  sizeShares: number,
  price: number,
  winningOutcome: string | null,
): number {
  if (winningOutcome == null) return 0;
  if (!Number.isFinite(sizeShares) || !Number.isFinite(price)) return 0;
  const won = outcome === winningOutcome ? 1 : 0;
  return side === 'SELL' ? sizeShares * (price - won) : sizeShares * (won - price);
}

/** P(this fill profits) under an efficient market: a BUY profits if its outcome wins (prob `price`); a SELL if it loses (prob `1−price`). */
export function impliedWinProb(side: 'BUY' | 'SELL' | null, price: number): number {
  return side === 'SELL' ? 1 - price : price;
}

/**
 * Is this bet INSIDER-SHAPED? — i.e. the subset where information, not live-trading or favorite-backing,
 * is the natural read of a win: a NON-sports market, entered at non-trivial / non-near-decided odds
 * (`extremeLo < price ≤ infoOddsHi`), and placed with lead time (`leadDays > liveLeadDays`, or lead
 * unknown). Total; thresholds default to INSIDER_DEFAULTS.
 */
export function isInformativeBet(
  category: MarketCategory,
  entryPrice: number,
  leadDays: number | null,
  t: InsiderThresholds = INSIDER_DEFAULTS,
): boolean {
  if (entryPrice <= t.extremeLo || entryPrice >= t.extremeHi) return false;
  if (category === 'sports') return false;
  if (entryPrice > t.infoOddsHi) return false;
  if (leadDays != null && leadDays <= t.liveLeadDays) return false;
  return true;
}
