/**
 * core/sim/sports-copytrade — PURE, deterministic analytics for "who are the best SPORTS traders on
 * Polymarket, and can we MIRROR (copy-trade) them?" This is the sports sibling of sim/copy-trade.ts
 * (the weather/badatmath mirror) and reuses its tested machinery rather than reimplementing it.
 *
 * THE QUESTION. The whale-insider scan (WHALE-INSIDER-SCAN.md) established that Polymarket's top whales
 * are SPORTS specialists and that their edge is LIVE-TRADING skill (betting during the match, reacting
 * to game state faster/better than the book) — not material non-public information. A copy-trader is by
 * construction a LATE follower: they only learn of the sharp's bet once the fill is public, then must
 * cross to the book to guarantee a fill. So the only question that matters for "can we mimic them" is:
 * by the time a follower can act (a realistic detection lag after the fill), how much of the price move
 * that justified the bet has ALREADY happened — and is the residual edge, net of the taker fee, still
 * positive? That is exactly what sim/copy-trade.ts::simulateMirror measures; this module supplies the
 * SPORTS-side inputs and the descriptive fingerprints.
 *
 * WHY THIS REUSES copy-trade.ts (handoff §6 "reuse, don't reimplement"). simulateMirror already encodes
 * the conservative follower model (first book at/after fill+lag, take the ask, charge the taker fee,
 * bootstrap-CI the fee-net EV, adjudicate against a pre-registered 0 lower-bound). The ONLY weather-isms
 * are its input types — `market_snapshots` book rows and the cheap-longshot (<0.25) cut. For sports the
 * book series comes from the CLOB /prices-history of the EXACT token the sharp bought, and entries are
 * at any odds (sports sharps buy at ~0.5 in size, not cheap tails). So this module builds those
 * snapshots, determines resolution from the token's own settled price, and the caller raises
 * `cheapMaxPrice` to admit the full odds range. The EV math, the fee, the CIs, the verdict — all reused.
 *
 * THE SNAPSHOT TRICK (sign convention). We always pass the bought token's OWN price series and set the
 * MirrorFill outcome to 'Yes'. The token's price → 1 iff the leg the sharp bought won, so "price up =
 * toward the sharp's outcome" holds regardless of whether the raw outcome label was Yes/No/Under — and
 * simulateMirror's drift sign (which negates for outcome==='no') stays correct without special-casing
 * multi-outcome sports legs.
 *
 * THE OPTIMISM DIAL (spreadHaircut). /prices-history gives ONE price per timestamp (a mark/mid), not the
 * book — so a naive follower "ask = p" UNDERSTATES the real cost (a taker pays above the mid). We model
 * the spread at the snapshot boundary: ask = p + spreadHaircut. haircut=0 is the OPTIMISTIC follower
 * (pays the mark) — a KILL test: if even that follower cannot capture the edge, copying is dead for any
 * realistic spread. haircut>0 models a real taker. Both are reported; simulateMirror stays untouched.
 *
 * Pure + total: empty/degenerate inputs return empty/zeroed structures, never throw. Deterministic — all
 * CIs seed mulberry32 via stats.ts, so every run is byte-identical.
 */
import type { PricePoint } from '../polymarket/clob.ts';
import type { BucketSnapshot, MirrorFill } from './copy-trade.ts';
import { armEdgeStats, type GradedBet, wilsonInterval, Z_95 } from './stats.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// market categorisation (ported VERBATIM from core/polymarket/insider.ts — keep behaviourally identical
// if that module merges; sports detection is the load-bearing filter for this whole study)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

export type MarketCategory = 'sports' | 'crypto' | 'politics' | 'weather' | 'macro' | 'other';

/** Coarse market category from title (+ optional slug). Best-effort regex, total. */
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

export type SportsSubcategory =
  | 'soccer'
  | 'basketball'
  | 'football'
  | 'baseball'
  | 'hockey'
  | 'mma'
  | 'tennis'
  | 'motorsport'
  | 'esports'
  | 'other-sport';

/** Best-effort sport bucket for the fingerprint (only meaningful when category==='sports'). Total. */
export function sportsSubcategory(title: string, slug = ''): SportsSubcategory {
  const t = `${title ?? ''} ${slug ?? ''}`.toLowerCase();
  if (/\b(nba|wnba|euroleague|basketball)\b/.test(t)) return 'basketball';
  if (/\b(nfl|cfb|ncaaf|super bowl)\b|american football/.test(t)) return 'football';
  if (/\b(mlb|baseball|world series)\b/.test(t)) return 'baseball';
  if (/\b(nhl|hockey|stanley cup)\b/.test(t)) return 'hockey';
  if (/\b(ufc|mma|bellator|boxing)\b/.test(t)) return 'mma';
  if (/\b(atp|wta|tennis|wimbledon|roland garros|us open|australian open)\b/.test(t)) return 'tennis';
  if (/\b(f1|grand prix|nascar|motogp|formula)\b/.test(t)) return 'motorsport';
  if (/\b(dota|valorant|counter-strike|cs2|league of legends|esports|lol)\b/.test(t)) return 'esports';
  if (/\b(epl|laliga|serie a|bundesliga|fifwc|fifa|uefa|champions league|soccer|football club|\bfc\b)\b|world cup/.test(t))
    return 'soccer';
  return 'other-sport';
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// CLOB history → snapshots + resolution
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const clampPrice = (p: number): number => Math.min(1, Math.max(0, p));

/**
 * Build a copy-trade BucketSnapshot[] series from a CLOB /prices-history of the EXACT token the sharp
 * bought (ascending by t). mid = the mark p; ask = clamp(p + spreadHaircut) (the optimism dial — see the
 * file header); bid = p. Pure; an empty history → []. Points are kept in input (ascending) order.
 */
export function buildSnapshotsFromHistory(
  history: PricePoint[],
  opts: { spreadHaircut?: number } = {},
): BucketSnapshot[] {
  const haircut = opts.spreadHaircut ?? 0;
  return history.map((pt) => {
    const mid = clampPrice(pt.p);
    return {
      capturedAt: pt.t,
      bid: mid,
      ask: clampPrice(pt.p + haircut),
      mid,
    };
  });
}

/**
 * Resolve whether the bought leg WON from its own settled price series. A resolved Polymarket token
 * settles to ~1 (won) or ~0 (lost); we read the LAST point and threshold. Returns null (→ dropped as
 * unresolved) when the last price is in the ambiguous middle band — the market has not clearly settled,
 * so we refuse to grade it rather than guess. Pure.
 */
export function resolveOutcomeFromHistory(
  history: PricePoint[],
  opts: { wonAtOrAbove?: number; lostAtOrBelow?: number } = {},
): boolean | null {
  const wonAt = opts.wonAtOrAbove ?? 0.9;
  const lostAt = opts.lostAtOrBelow ?? 0.1;
  if (history.length === 0) return null;
  const last = history[history.length - 1]!.p;
  if (!Number.isFinite(last)) return null;
  if (last >= wonAt) return true;
  if (last <= lostAt) return false;
  return null;
}

/**
 * One sharp BUY fill plus the bought token's price history — the raw input the caller turns into a
 * copy-trade MirrorFill. (SELL fills are out of scope for the mirror — a follower mirrors entries.)
 */
export interface SportsFillInput {
  conditionId: string;
  /** The ERC-1155 token id the sharp bought (the series is THIS token's /prices-history). */
  asset: string;
  fillPrice: number;
  sizeShares: number;
  usdcSize: number;
  /** Unix seconds of the fill. */
  timestamp: number;
  /** The bought token's CLOB /prices-history (ascending). */
  history: PricePoint[];
  feeRate: number;
  /**
   * AUTHORITATIVE resolution of the bought leg, when known (e.g. from CLOB /markets/{conditionId}'s
   * per-token `winner` flag). Prefer this over the price-tail heuristic — a market that is still OPEN can
   * sit at an extreme price without having settled. `undefined` (the default) falls back to
   * resolveOutcomeFromHistory; pass `null` to force "unresolved" (drop from the scored set).
   */
  outcomeWon?: boolean | null;
}

/**
 * Convert a sports BUY fill + its bought-token history into a copy-trade MirrorFill. Sets outcome='Yes'
 * (the sign trick — see header). Resolution prefers the explicit authoritative `fill.outcomeWon` when
 * provided, else falls back to the bought token's settled price (resolveOutcomeFromHistory). spreadHaircut
 * threads through to the snapshot asks. Pure.
 */
export function toMirrorFill(
  fill: SportsFillInput,
  opts: { spreadHaircut?: number; wonAtOrAbove?: number; lostAtOrBelow?: number } = {},
): MirrorFill {
  const outcomeWon =
    fill.outcomeWon !== undefined ? fill.outcomeWon : resolveOutcomeFromHistory(fill.history, opts);
  return {
    conditionId: fill.conditionId,
    outcome: 'Yes',
    fillPrice: fill.fillPrice,
    sizeShares: fill.sizeShares,
    usdcSize: fill.usdcSize,
    timestamp: fill.timestamp,
    citySlug: null,
    targetDate: null,
    outcomeWon,
    feeRate: fill.feeRate,
    snapshots: buildSnapshotsFromHistory(fill.history, opts),
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// fill-aligned drift curve — WHEN does the price move relative to the fill?
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One point of the average price path relative to the fill instant (t=0). */
export interface DriftPoint {
  /** Relative offset in seconds from the fill (negative = before). */
  offsetSec: number;
  /** Mean (over fills) of the bought token's price at this offset, MINUS each fill's price at t=0. */
  meanDeltaFromFill: number;
  /** Number of fills that had a usable price sample at this offset. */
  n: number;
}

/** The price at-or-before t in an ascending PricePoint[] (the book a snapshot-poller would see), or null. */
export function priceAtOrBefore(history: PricePoint[], t: number): number | null {
  let out: number | null = null;
  for (const pt of history) {
    if (pt.t <= t) out = pt.p;
    else break;
  }
  return out;
}

/**
 * Align many (fill, history) pairs at the fill instant and average the bought-token price path around it,
 * expressed as a DELTA from each fill's at-fill price. A curve that is ~flat for the first few minutes and
 * then rises is the "the move comes AFTER the fill" signature (a slow follower can still catch it); a curve
 * that has already jumped by +1–5min is the "priced in before you can act" kill signature. Pure + total.
 *
 * `offsetsSec` are the relative sample points (e.g. [-600,-300,-60,0,60,300,900,1800]); for each, every
 * fill contributes (priceAtOrBefore(fill.ts+offset) − priceAtOrBefore(fill.ts)) when both are defined.
 */
export function alignDriftCurve(
  fills: { timestamp: number; history: PricePoint[] }[],
  offsetsSec: number[],
): DriftPoint[] {
  return offsetsSec.map((offset) => {
    const deltas: number[] = [];
    for (const f of fills) {
      const atFill = priceAtOrBefore(f.history, f.timestamp);
      const atOffset = priceAtOrBefore(f.history, f.timestamp + offset);
      if (atFill != null && atOffset != null) deltas.push(atOffset - atFill);
    }
    const n = deltas.length;
    const mean = n ? deltas.reduce((a, v) => a + v, 0) / n : NaN;
    return { offsetSec: offset, meanDeltaFromFill: mean, n };
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// trader fingerprint — the descriptive "who is this sharp" profile
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A single graded fill for the fingerprint (resolution optional — win-rate only over the resolved subset). */
export interface FingerprintFill {
  title: string;
  slug: string;
  side: 'BUY' | 'SELL' | null;
  /** Entry price in (0,1). */
  price: number;
  /** USD notional of the fill. */
  notionalUsd: number;
  /** Unix seconds. */
  timestamp: number;
  /** Did the bought leg win? null when unknown (excluded from win-rate). */
  won: boolean | null;
}

export interface OddsBin {
  label: string;
  lo: number;
  hi: number;
  count: number;
  notionalUsd: number;
}

export interface TraderFingerprint {
  nFills: number;
  totalNotionalUsd: number;
  meanNotionalUsd: number;
  medianNotionalUsd: number;
  /** Share of fills (by count) that are BUYs. */
  buyFraction: number;
  /** Entry-odds histogram (count + notional per band). */
  oddsBins: OddsBin[];
  /** Volume-weighted mean entry price. */
  vwapEntry: number;
  /** Category mix by notional (sports/crypto/…); sums to ~1. */
  categoryMix: Record<MarketCategory, number>;
  /** Sports sub-category mix by notional over the sports fills; sums to ~1 (empty when no sports). */
  sportsMix: Partial<Record<SportsSubcategory, number>>;
  /** Fraction of BUY notional placed at mid-ish odds (0.2–0.8) — the live-trading band, not cheap tails. */
  midOddsBuyNotionalFraction: number;
  /**
   * Burst/sweep signature: fraction of fills that land within `burstWindowSec` of another fill in the
   * SAME market (book-sweeping in size — the mintblade pattern). Pure structural, no resolution needed.
   */
  sweepFraction: number;
  /** Win rate over the resolved subset, with a Wilson 95% interval and the volume-weighted implied prob. */
  resolved: {
    n: number;
    wins: number;
    winRate: number;
    winRateLo: number;
    winRateHi: number;
    /** Mean implied win prob (BUY→price, SELL→1−price) — the bar an efficient market sets. */
    meanImpliedProb: number;
    /** winRate − meanImpliedProb: positive ⇒ wins MORE than entry odds implied (true edge). */
    edgeOverImplied: number;
  };
}

const DEFAULT_ODDS_BINS: { label: string; lo: number; hi: number }[] = [
  { label: '0.00–0.10', lo: 0, hi: 0.1 },
  { label: '0.10–0.25', lo: 0.1, hi: 0.25 },
  { label: '0.25–0.40', lo: 0.25, hi: 0.4 },
  { label: '0.40–0.60', lo: 0.4, hi: 0.6 },
  { label: '0.60–0.75', lo: 0.6, hi: 0.75 },
  { label: '0.75–0.90', lo: 0.75, hi: 0.9 },
  { label: '0.90–1.00', lo: 0.9, hi: 1.0001 },
];

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Build the descriptive fingerprint of a trader from their fills. Pure + total — an empty list returns a
 * zeroed fingerprint (NaN means/rates, empty bins populated with zero counts). `burstWindowSec` controls
 * the sweep detector (default 120s); two fills in the same conditionId within the window each count toward
 * the sweep fraction.
 */
export function traderFingerprint(
  fills: FingerprintFill[],
  opts: { burstWindowSec?: number } = {},
): TraderFingerprint {
  const burstWindow = opts.burstWindowSec ?? 120;
  const n = fills.length;
  const notionals = fills.map((f) => f.notionalUsd).filter((v) => Number.isFinite(v) && v > 0);
  const totalNotional = notionals.reduce((a, v) => a + v, 0);
  const buys = fills.filter((f) => f.side === 'BUY');

  // odds histogram (count + notional)
  const oddsBins: OddsBin[] = DEFAULT_ODDS_BINS.map((b) => ({ ...b, count: 0, notionalUsd: 0 }));
  for (const f of fills) {
    if (!Number.isFinite(f.price)) continue;
    const bin = oddsBins.find((b) => f.price >= b.lo && f.price < b.hi);
    if (bin) {
      bin.count++;
      bin.notionalUsd += Number.isFinite(f.notionalUsd) ? f.notionalUsd : 0;
    }
  }

  const vwapEntry =
    totalNotional > 0
      ? fills.reduce((a, f) => a + (Number.isFinite(f.price) && f.notionalUsd > 0 ? f.price * f.notionalUsd : 0), 0) /
        totalNotional
      : NaN;

  // category + sports mix (by notional)
  const catNotional: Record<MarketCategory, number> = {
    sports: 0,
    crypto: 0,
    politics: 0,
    weather: 0,
    macro: 0,
    other: 0,
  };
  const sportsNotional: Partial<Record<SportsSubcategory, number>> = {};
  let sportsTotal = 0;
  for (const f of fills) {
    const w = Number.isFinite(f.notionalUsd) ? f.notionalUsd : 0;
    const cat = categorizeMarket(f.title, f.slug);
    catNotional[cat] += w;
    if (cat === 'sports') {
      const sub = sportsSubcategory(f.title, f.slug);
      sportsNotional[sub] = (sportsNotional[sub] ?? 0) + w;
      sportsTotal += w;
    }
  }
  const categoryMix = Object.fromEntries(
    Object.entries(catNotional).map(([k, v]) => [k, totalNotional > 0 ? v / totalNotional : 0]),
  ) as Record<MarketCategory, number>;
  const sportsMix: Partial<Record<SportsSubcategory, number>> = {};
  for (const [k, v] of Object.entries(sportsNotional)) {
    sportsMix[k as SportsSubcategory] = sportsTotal > 0 ? v / sportsTotal : 0;
  }

  // mid-odds BUY notional fraction (0.2–0.8) — the live-trading band
  const buyNotional = buys.reduce((a, f) => a + (Number.isFinite(f.notionalUsd) ? f.notionalUsd : 0), 0);
  const midBuyNotional = buys
    .filter((f) => f.price >= 0.2 && f.price <= 0.8)
    .reduce((a, f) => a + (Number.isFinite(f.notionalUsd) ? f.notionalUsd : 0), 0);

  // sweep detector: a fill is "in a burst" if another fill in the SAME market is within burstWindow.
  const byMarket = new Map<string, number[]>();
  for (const f of fills) {
    const key = f.slug || f.title;
    const arr = byMarket.get(key) ?? [];
    arr.push(f.timestamp);
    byMarket.set(key, arr);
  }
  let burstCount = 0;
  for (const f of fills) {
    const key = f.slug || f.title;
    const times = byMarket.get(key)!;
    const inBurst = times.some((t) => t !== f.timestamp && Math.abs(t - f.timestamp) <= burstWindow);
    // (ties at the exact same timestamp also count — same-second book sweeps)
    const sameSecond = times.filter((t) => t === f.timestamp).length > 1;
    if (inBurst || sameSecond) burstCount++;
  }

  // resolved win-rate + edge over implied
  const resolvedFills = fills.filter((f) => f.won !== null);
  const wins = resolvedFills.filter((f) => f.won === true).length;
  const rn = resolvedFills.length;
  const winRate = rn ? wins / rn : NaN;
  const wilson = rn ? wilsonInterval(wins, rn, Z_95) : { lo: NaN, hi: NaN };
  const meanImpliedProb = rn
    ? resolvedFills.reduce((a, f) => a + (f.side === 'SELL' ? 1 - f.price : f.price), 0) / rn
    : NaN;

  return {
    nFills: n,
    totalNotionalUsd: totalNotional,
    meanNotionalUsd: notionals.length ? totalNotional / notionals.length : NaN,
    medianNotionalUsd: median(notionals),
    buyFraction: n ? buys.length / n : NaN,
    oddsBins,
    vwapEntry,
    categoryMix,
    sportsMix,
    midOddsBuyNotionalFraction: buyNotional > 0 ? midBuyNotional / buyNotional : NaN,
    sweepFraction: n ? burstCount / n : NaN,
    resolved: {
      n: rn,
      wins,
      winRate,
      winRateLo: wilson.lo,
      winRateHi: wilson.hi,
      meanImpliedProb,
      edgeOverImplied: rn ? winRate - meanImpliedProb : NaN,
    },
  };
}

/**
 * Convenience: grade a trader's resolved BUY fills as the sharp's OWN edge (won, ask=fillPrice), reusing
 * armEdgeStats — the same Wilson-hit + bootstrap-EV the mirror uses for the follower. This is the sharp's
 * realized per-$1 edge BEFORE any follower lag/spread; the gap between this and the follower's net EV is
 * the cost of being late. Pure.
 */
export function sharpOwnEdge(fills: FingerprintFill[], opts: { bootstrapSeed?: number } = {}) {
  const bets: GradedBet[] = fills
    .filter((f) => f.side === 'BUY' && f.won !== null && Number.isFinite(f.price) && f.price > 0 && f.price <= 1)
    .map((f) => ({ won: f.won === true, ask: f.price }));
  return armEdgeStats(bets, { bootstrapSeed: opts.bootstrapSeed ?? 42 });
}
