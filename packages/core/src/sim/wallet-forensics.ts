/**
 * core/sim/wallet-forensics — the PURE, deterministic analytics that reconstruct a Polymarket wallet's
 * TRUE realized performance from public `/activity` fills (WALLET-RECON-HANDOFF.md Build #2 — the
 * skill-vs-survivorship gate). The impure fetchers live in packages/io/src/polymarket-wallet.ts; this
 * module takes the parsed `WalletActivity[]` (and `MarketMeta`) and never touches the network.
 *
 * Why FIFO reconstruction (not `/closed-positions`): `/closed-positions` caps at the top ~50 PnL rows
 * (DESC), so it is winners-only — a survivorship lens. The honest lifetime number comes from replaying
 * EVERY fill: BUY adds to a per-(conditionId,outcome) cost-basis lot queue; SELL and REDEEM realize P&L
 * against the oldest lots (FIFO). Summing realized P&L over all fills reconstructs the cumulative curve
 * that `user-pnl-api` reports — the reconciliation line is the gate.
 *
 * Reuse, don't reimplement (the handoff §6 directive): the calibration math (brierScore,
 * expectedCalibrationError, reliabilityBins, pairedBootstrapPValue) comes from calibration/scores.ts; the
 * CI / edge math (wilsonInterval, armEdgeStats, the GradedBet {won, ask} type) from sim/stats.ts. A
 * wallet's realized bet IS a GradedBet ({won, ask=entryPrice}) — fed straight in.
 *
 * Idiom: pure + total. An empty fill list returns an empty/zero aggregate, never throws; a row with a
 * non-finite price/size is handled gracefully. Deterministic — the bootstrap p-value seeds mulberry32 via
 * scores.ts, so every run is byte-identical.
 */
import {
  brierScore,
  expectedCalibrationError,
  pairedBootstrapPValue,
  type Prediction,
  type ReliabilityBin,
  reliabilityBins,
} from '../calibration/scores.ts';
import { armEdgeStats, type ArmEdgeStats, type GradedBet, wilsonInterval } from './stats.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The structural fill shape this module reconstructs from — a deliberate STRUCTURAL SUBSET of
 * packages/io's `WalletActivity` (a parsed /activity row). Declared here (not imported) so @weather-edge/core
 * stays dependency-free of packages/io (core has no io dependency); the io `WalletActivity` is assignable to
 * this type structurally, so the script feeds parsed activity straight in with no adapter. Field names match
 * io's verbatim (the Deno/Node seam contract): `type` ('TRADE'|'REDEEM'|…), `side` ('BUY'|'SELL'|null),
 * `conditionId`, `outcome`, `sizeShares`, `usdcSize`, `timestamp` (unix s), `citySlug`, `targetDate`.
 */
export interface WalletFill {
  type: string;
  side: 'BUY' | 'SELL' | null;
  conditionId: string;
  outcome: string;
  sizeShares: number;
  usdcSize: number;
  timestamp: number;
  citySlug: string | null;
  targetDate: string | null;
}

/**
 * One reconstructed realized bet — a position (conditionId,outcome) that has settled (via REDEEM) or been
 * fully sold out. `won` = the position settled in the money (realized P&L > 0 net of its cost basis is the
 * proxy; for a REDEEM-settled YES leg this is "the bucket resolved YES"). `ask` = entryPrice = the
 * volume-weighted BUY price (the implied probability the wallet paid) — so the row is a GradedBet.
 */
export interface RealizedBet extends GradedBet {
  conditionId: string;
  outcome: string;
  /**
   * Volume-weighted entry (BUY) price in (0,1] — the implied probability paid; alias of GradedBet.ask.
   * NaN when the position has no BUY shares (a REDEEM/SELL-only graded market, or a zero-share BUY): there is
   * no implied probability to score, so every entry-price-keyed surface (roiByEntryBucket, aggregateRange,
   * brierVsOutcomes, armEdgeStats) skips it rather than mis-bucketing a priceless bet into [0,0.10).
   */
  entryPrice: number;
  /**
   * The MARKET-RESOLUTION outcome for the calibration lens, distinct from the trading-P&L `won`: `true` if a
   * real settlement payout was received (REDEEM/MERGE proceeds > 0 → resolved in the money), `false` if graded
   * as a past-resolution total loss (no payout), and `null` for a position closed by SELL before resolution
   * (the market's actual outcome is unobserved from /activity). brierVsOutcomes scores against THIS, not `won`
   * (which counts a profitable pre-resolution SELL as a "win" — a trading exit, not a resolution).
   */
  resolvedWon: boolean | null;
  /** Realized P&L on the position in USDC (proceeds − matched cost basis). */
  realizedUsd: number;
  /** Total USDC cost basis bought into the position (the staked notional). */
  stakedUsd: number;
  citySlug: string | null;
  targetDate: string | null;
  /** 'US' | 'INTL' | null (null when the city/country can't be resolved). */
  region: 'US' | 'INTL' | null;
}

/** The full reconstruction result — per-bet rows + the lifetime aggregates the reconciliation gate uses. */
export interface RealizedReconstruction {
  bets: RealizedBet[];
  /**
   * TRADING-ONLY realized P&L = Σ(SELL + REDEEM + MERGE) − Σ(BUY), EXCLUDING liquidity incentives
   * (MAKER_REBATE + REWARD). This is the principled like-for-like with user-pnl-api's realized-trading curve.
   * The per-bet RealizedBet rows are on this same trading-only basis.
   */
  realizedTotalUsd: number;
  /** Σ(MAKER_REBATE + REWARD) — liquidity INCOME, not trading P&L (not attributable to a single bet/bucket). */
  incentivesUsd: number;
  /** Convenience: realizedTotalUsd + incentivesUsd (trading P&L plus liquidity incentives). */
  tradingPlusIncentivesUsd: number;
  /** Σ BUY cost across all (resolved) positions — the proceeds decomposition, for the reconciliation print. */
  buyCostUsd: number;
  /** Σ SELL proceeds across all (resolved) positions. */
  sellProceedsUsd: number;
  /** Σ REDEEM proceeds (the $1/share winning payouts) across all (resolved) positions. */
  redeemProceedsUsd: number;
  /** Σ MERGE proceeds (a complete YES+NO set recombined to $1) across all (resolved) positions. */
  mergeProceedsUsd: number;
  /** Total BUY notional across all positions (the denominator for ROI-on-volume). */
  volumeUsd: number;
  nWins: number;
  nLosses: number;
  /** nWins / (nWins + nLosses); NaN when no decisive bets. */
  winRate: number;
  /** realizedTotalUsd / volumeUsd; NaN when volumeUsd = 0. */
  roiOnVolume: number;
  /**
   * AUDIT counters — graded markets whose cash is in realizedTotalUsd but that are deliberately held out of
   * one or more per-bet metrics, so any divergence between the win-rate denominator and the entry-keyed
   * denominators is visible rather than silent.
   *
   * `nUnattributed`: empty-conditionId merged-leg ('') blobs — cash kept in the total, never a win/loss/bet.
   * `nEntryUnpriced`: graded bets with no BUY shares (entryPrice NaN) — count in win/loss, skipped by entry-keyed surfaces.
   * `nUngradedNullTarget` / `ungradedNullTargetStakeUsd`: BUY-only markets with a null targetDate that a
   *   `resolvedBefore` cutoff cannot grade (unparseable slug) — the residual asymmetry of the survivorship
   *   control (a null-target winner still settles via REDEEM and counts; this loss leg can never be graded).
   *   After the `arch-`-archived-slug tolerance, this is the non-weather remainder; assert it negligible
   *   before trusting the win rate.
   */
  nUnattributed: number;
  nEntryUnpriced: number;
  nUngradedNullTarget: number;
  ungradedNullTargetStakeUsd: number;
}

/** One day of the reconstructed cumulative realized-PnL curve (the analog of user-pnl-api). */
export interface DailyPnlPoint {
  /** YYYY-MM-DD (UTC day of the settling fill). */
  date: string;
  /** Realized P&L booked on that day. */
  realizedUsd: number;
  /** Cumulative realized P&L through that day. */
  cumUsd: number;
}

/** Half-open entry-price cut [lo, hi) (the top cut is closed at 1). */
export interface BucketCut {
  lo: number;
  hi: number;
  label: string;
}

/** The decisive entry-price cuts (WALLET-RECON-HANDOFF.md §3 — the cheap-longshot signature). */
export const ENTRY_PRICE_CUTS: BucketCut[] = [
  { lo: 0, hi: 0.1, label: '[0.00,0.10)' },
  { lo: 0.1, hi: 0.25, label: '[0.10,0.25)' },
  { lo: 0.25, hi: 0.45, label: '[0.25,0.45)' },
  { lo: 0.45, hi: 0.75, label: '[0.45,0.75)' },
  { lo: 0.75, hi: 1, label: '[0.75,1.00]' },
];

/** ROI / P&L for one entry-price cut. */
export interface BucketRoi {
  label: string;
  lo: number;
  hi: number;
  nBets: number;
  nWins: number;
  realizedUsd: number;
  stakedUsd: number;
  /** realizedUsd / stakedUsd; NaN when nothing staked in the cut. */
  roi: number;
}

/** Attribution row (a city, a country, or a region). */
export interface AttributionRow {
  key: string;
  nBets: number;
  realizedUsd: number;
  stakedUsd: number;
  /** realizedUsd / stakedUsd; NaN when nothing staked. */
  roi: number;
}

/** by city → country → region (US vs international) realized P&L + ROI. */
export interface Attribution {
  byCity: AttributionRow[];
  byCountry: AttributionRow[];
  byRegion: AttributionRow[];
}

/** Calibration scoring of the revealed buys vs whether they resolved in the money. */
export interface BrierResult {
  n: number;
  /** Mean per-bet Brier of the wallet's revealed probabilities (entryPrice) vs the binary outcome. */
  walletBrier: number;
  /** Baseline Brier (the market-implied prob baseline — documented below). */
  marketBrier: number;
  ece: number;
  reliability: ReliabilityBin[];
  /** One-sided paired bootstrap p on (walletBrier − marketBrier) per bet — small p ⇒ wallet reliably sharper. */
  pairedBootstrapP: number;
}

/**
 * A regime change on the cumulative realized-PnL curve, reported on TWO complementary axes:
 *
 *  - `onsetDate` — the CAUSAL regime ONSET, measured from the LOCAL trend (not a global two-line split): the
 *    final trough crossing, i.e. the last day the cumulative curve is at/below its running minimum before it
 *    rises and never returns at/below that level again. This is the economically meaningful "when did the
 *    durable winning era begin" and is endpoint-STABLE (it does not migrate as the curve's right edge grows,
 *    the way a global min-SSE split does). Matches the handoff §6 directive ("flag where post-slope flips
 *    sign" = the onset).
 *  - `breakpointDate` — the BEST-FIT KINK: the min-SSE single two-segment split (the PELT objective). This is
 *    the best-fitting place to break the whole curve into a "before" line and an "after" line. On an
 *    accelerating tail it is dragged later than the onset (the steeper the late segment, the later the kink),
 *    so it is reported alongside the onset, not in place of it.
 */
export interface RegimeChange {
  /** The causal regime ONSET (final trough crossing); null when no durable rise is detected. */
  onsetDate: string | null;
  /** The min-SSE best-fit two-segment KINK date (first day of the post segment); null when no break flagged. */
  breakpointDate: string | null;
  /** OLS slope (USD/day) of the cumulative curve before the best-fit kink. */
  preSlope: number;
  /** OLS slope (USD/day) of the cumulative curve at/after the best-fit kink. */
  postSlope: number;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// region resolution — minimal, deterministic, no external table
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The US airport-city slugs in Polyweather's universe (WALLET-RECON-HANDOFF.md §3 lists the US winners).
 * Used only to split US vs international for attribution; an unrecognised city resolves to INTL (the
 * universe is ~80% non-US, and the §3 finding is explicitly "US share is flat ~20%" — defaulting unknown
 * to INTL is the safe, documented choice and never over-counts US).
 */
const US_CITY_SLUGS = new Set<string>([
  'new-york-city', 'new-york', 'nyc', 'los-angeles', 'chicago', 'houston', 'dallas', 'dallas-fort-worth',
  'san-francisco', 'seattle', 'boston', 'miami', 'atlanta', 'denver', 'phoenix', 'philadelphia',
  'washington-dc', 'washington', 'minneapolis', 'detroit', 'austin', 'portland', 'san-diego', 'las-vegas',
]);

/** US vs international for a parsed city slug. Unknown → INTL (documented default; never over-counts US). */
export function usRegionForCity(citySlug: string | null): 'US' | 'INTL' | null {
  if (citySlug === null || citySlug === '') return null;
  return US_CITY_SLUGS.has(citySlug) ? 'US' : 'INTL';
}

/** A coarse country key from a city slug (city slug itself when no mapping) — for the country attribution. */
function countryKeyForCity(citySlug: string | null): string {
  if (citySlug === null || citySlug === '') return '(unknown)';
  return usRegionForCity(citySlug) === 'US' ? 'US' : citySlug;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// FIFO realized-PnL reconstruction
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const isFiniteNum = (v: number): boolean => Number.isFinite(v);

/**
 * /activity event types that return USDC to the wallet (cash-in), verified live on badatmath 2026-06-22.
 * Split into two classes because they are NOT the same kind of money:
 *
 *  - TRADING_PROCEEDS_EVENT_TYPES (REDEEM, MERGE): real *trading* proceeds at resolution — REDEEM = the
 *    $1/share winning payout; MERGE = a complete YES+NO set recombined to $1. These net against BUY cost to
 *    give realized TRADING P&L, the principled like-for-like with user-pnl-api's realized-trading curve.
 *  - INCENTIVE_EVENT_TYPES (MAKER_REBATE, REWARD): liquidity INCOME, not trading P&L. The standard
 *    definition of realized trading PnL excludes liquidity incentives, so we book these SEPARATELY
 *    (incentivesUsd) and never fold them into a bet's realized P&L (they aren't attributable to one bucket).
 *
 * BUY/SELL are handled explicitly (a SELL is also cash-in but is matched by side, not type). SPLIT/CONVERSION
 * are net-zero cash and excluded. PROCEEDS_EVENT_TYPES (the union) is kept for callers that need "any cash-in".
 */
export const TRADING_PROCEEDS_EVENT_TYPES = new Set<string>(['REDEEM', 'MERGE']);
export const INCENTIVE_EVENT_TYPES = new Set<string>(['MAKER_REBATE', 'REWARD']);
export const PROCEEDS_EVENT_TYPES = new Set<string>([
  ...TRADING_PROCEEDS_EVENT_TYPES,
  ...INCENTIVE_EVENT_TYPES,
]);

/**
 * Per-market (conditionId) cash-flow accumulator. THE KEY MODELLING DECISION (verified against live
 * badatmath /activity 2026-06-22): a Polymarket REDEEM row carries the conditionId but an EMPTY outcome
 * (`outcome:''`, `side:''`, `price:0`) and `usdcSize == size` (the $1/share payout of the winning shares).
 * So a REDEEM CANNOT be matched to a specific (conditionId,outcome) leg — and, critically, a LOSING
 * position never emits any settlement event at all (you don't redeem worthless shares). FIFO-per-leg
 * therefore both (a) fails to match REDEEM payouts to their BUY cost basis and (b) silently drops every
 * loss — which is exactly how a naive reconstruction balloons to ~10× the truth at a ~100% win rate.
 *
 * The correct, reconcilable model for fully-resolved markets is the CASH-FLOW IDENTITY at the conditionId
 * (whole-market) level, on a TRADING-ONLY basis:
 *
 *     realizedPnL(market) = Σ(SELL + REDEEM + MERGE proceeds) − Σ(BUY cost)
 *
 * because at resolution every share is worth $0 or $1, so the net trading cash in/out IS the realized
 * trading P&L — no lot matching required. This is exactly what user-pnl-api's realized-trading curve accrues,
 * so summing it over markets reconciles. We group by conditionId (NOT by leg) and net all of that market's
 * BUYs (cost), SELLs/REDEEMs/MERGEs (trading proceeds). Liquidity incentives (MAKER_REBATE + REWARD) are
 * LIQUIDITY INCOME, not trading P&L — the standard realized-trading-PnL definition excludes them, so they are
 * tracked SEPARATELY (incentivesUsd) and never netted into a bet's realized P&L. A market is a "decisive bet"
 * once it has any settlement (REDEEM/MERGE) or any SELL; `won` = net trading cash-flow > 0. entryPrice = the
 * volume-weighted BUY price over the market's BUYs (the implied prob paid).
 */
interface MarketAcc {
  conditionId: string;
  /** The dominant outcome leg by BUY notional (for display / leg attribution; '' for the merged-leg rows). */
  outcome: string;
  /** Σ BUY usdcSize (cost basis / staked notional). */
  buyCostUsd: number;
  /** Σ SELL usdcSize (trading proceeds). */
  sellProceedsUsd: number;
  /** Σ REDEEM usdcSize (the $1/share winning payout — trading proceeds). */
  redeemProceedsUsd: number;
  /** Σ MERGE usdcSize (a complete YES+NO set recombined to $1 — trading proceeds). */
  mergeProceedsUsd: number;
  /** Σ MAKER_REBATE + REWARD usdcSize — liquidity incentives (NOT trading P&L; tracked, not netted into a bet). */
  incentivesUsd: number;
  /** Σ BUY shares + Σ BUY (price×shares) for the volume-weighted entry price. */
  buyShares: number;
  buyPriceShares: number;
  /** notional bought per outcome leg → pick the dominant leg label. */
  legNotional: Map<string, number>;
  /** A REDEEM, MERGE or SELL happened → the market is resolved/closed (a decisive bet). */
  settled: boolean;
  lastTs: number;
  citySlug: string | null;
  targetDate: string | null;
}

/**
 * Reconstruct realized P&L from a wallet's fills via the conditionId cash-flow identity (see MarketAcc).
 *
 *  - BUY            : add usdcSize to cost basis; accrue volume-weighted entry price + per-leg notional.
 *  - SELL           : add usdcSize to trading proceeds; marks the market closed.
 *  - REDEEM         : add usdcSize to trading proceeds (the $1/share winning payout); marks it resolved.
 *  - MERGE          : add usdcSize to trading proceeds (a YES+NO set recombined to $1); marks it resolved.
 *  - MAKER_REBATE / REWARD: add usdcSize to incentivesUsd (liquidity income — NOT netted into a bet's P&L).
 *  - SPLIT/CONVERSION: ignored (they move shares between legs at no net cash — cost basis preserved).
 *
 * realizedPnL(market) = (SELL+REDEEM+MERGE proceeds) − buyCost; `won` = realizedPnL > 0. Fills are filtered for finite fields;
 * order-independent (we aggregate, not replay). Pure + total — `[]`/zeroes on empty input.
 *
 * LOSERS HAVE NO SETTLEMENT EVENT. A losing position is never redeemed (worthless shares aren't redeemed),
 * so a market with BUYs and no SELL/REDEEM is EITHER still open OR resolved-as-a-total-loss — /activity
 * alone can't tell them apart. `opts.resolvedBefore` (YYYY-MM-DD) closes the gap: any unsettled market
 * whose `targetDate` is strictly before that date is booked as a RESOLVED TOTAL LOSS (proceeds 0 → realized
 * = −buyCost, a graded loss). Without it, unsettled markets stay open (excluded from win/loss + the total's
 * loss leg) — which under-counts the losses and inflates the reconstructed total. The script passes today's
 * UTC date so every past-resolution market is graded. Markets with a null targetDate (unparsed slug) are
 * always treated as open under this rule (we cannot date their resolution).
 */
export function reconstructRealizedPnl(
  fills: WalletFill[],
  opts: { resolvedBefore?: string } = {},
): RealizedReconstruction {
  const usable = fills.filter(
    (f) => isFiniteNum(f.timestamp) && isFiniteNum(f.sizeShares) && isFiniteNum(f.usdcSize),
  );

  const markets = new Map<string, MarketAcc>();

  const acc = (a: WalletFill): MarketAcc => {
    const key = a.conditionId; // group by MARKET, not by leg (REDEEM has no leg)
    let p = markets.get(key);
    if (!p) {
      p = {
        conditionId: a.conditionId,
        outcome: '',
        buyCostUsd: 0,
        sellProceedsUsd: 0,
        redeemProceedsUsd: 0,
        mergeProceedsUsd: 0,
        incentivesUsd: 0,
        buyShares: 0,
        buyPriceShares: 0,
        legNotional: new Map(),
        settled: false,
        lastTs: a.timestamp,
        citySlug: a.citySlug,
        targetDate: a.targetDate,
      };
      markets.set(key, p);
    }
    if (p.citySlug === null && a.citySlug !== null) p.citySlug = a.citySlug;
    if (p.targetDate === null && a.targetDate !== null) p.targetDate = a.targetDate;
    p.lastTs = Math.max(p.lastTs, a.timestamp);
    return p;
  };

  for (const f of usable) {
    const p = acc(f);
    const shares = Math.abs(f.sizeShares);
    const usd = Math.abs(f.usdcSize);

    if (f.type === 'TRADE' && f.side === 'BUY') {
      p.buyCostUsd += usd;
      if (shares > 0) {
        p.buyShares += shares;
        p.buyPriceShares += (usd / shares) * shares; // = usd, but kept explicit for the VWAP intent
      }
      if (f.outcome !== '') p.legNotional.set(f.outcome, (p.legNotional.get(f.outcome) ?? 0) + usd);
    } else if (f.type === 'TRADE' && f.side === 'SELL') {
      p.sellProceedsUsd += usd; // trading cash-in
      p.settled = true;
    } else if (TRADING_PROCEEDS_EVENT_TYPES.has(f.type)) {
      // Trading proceeds at resolution, verified live on badatmath /activity (2026-06-22), usdcSize == the
      // USDC returned: REDEEM (the $1/share winning payout) and MERGE (a complete YES+NO set recombined to
      // $1). These net against BUY cost to give realized TRADING P&L (the user-pnl-api like-for-like).
      if (usd > 0) {
        if (f.type === 'REDEEM') p.redeemProceedsUsd += usd;
        else p.mergeProceedsUsd += usd; // MERGE
        p.settled = true;
      }
    } else if (INCENTIVE_EVENT_TYPES.has(f.type)) {
      // Liquidity incentives (MAKER_REBATE / REWARD) — liquidity INCOME, NOT trading P&L. Tracked separately
      // (incentivesUsd) and never folded into a bet's realized P&L: the standard realized-trading-PnL
      // definition (which user-pnl-api's profile curve reports) excludes liquidity incentives.
      if (usd > 0) p.incentivesUsd += usd;
    }
    // SPLIT / CONVERSION (USDC → a share set, or NO-set → complementary YES): net-zero cash → ignored.
  }

  const bets: RealizedBet[] = [];
  let realizedTotalUsd = 0;
  let incentivesUsd = 0;
  let buyCostUsd = 0;
  let sellProceedsUsd = 0;
  let redeemProceedsUsd = 0;
  let mergeProceedsUsd = 0;
  let volumeUsd = 0;
  let nWins = 0;
  let nLosses = 0;
  let nUnattributed = 0;
  let nEntryUnpriced = 0;
  let nUngradedNullTarget = 0;
  let ungradedNullTargetStakeUsd = 0;

  const ordList = [...markets.values()].sort(
    (a, b) => a.lastTs - b.lastTs || a.conditionId.localeCompare(b.conditionId),
  );

  for (const p of ordList) {
    volumeUsd += p.buyCostUsd; // staked notional counts every BUY, resolved or not
    // Liquidity incentives are real cash the wallet received regardless of whether the position resolved
    // (a market can earn a maker rebate while still open) — accrue them across ALL markets, separately from
    // trading P&L. They are never netted into a bet's realized P&L (not attributable to a single bucket).
    incentivesUsd += p.incentivesUsd;
    const tradingProceeds = p.sellProceedsUsd + p.redeemProceedsUsd + p.mergeProceedsUsd;
    const realized = tradingProceeds - p.buyCostUsd;
    // A market is RESOLVED (and so contributes to realized P&L + win/loss) if it had a settlement event
    // (SELL/REDEEM/MERGE) OR it is a past-resolution unsettled market under resolvedBefore (a total loss).
    const resolvedLoss =
      !p.settled &&
      opts.resolvedBefore !== undefined &&
      p.targetDate !== null &&
      p.targetDate < opts.resolvedBefore;
    if (!p.settled && !resolvedLoss) {
      // Still-open OR ungradable-because-null-targetDate. Under a resolvedBefore cutoff, a BUY-only market with
      // a null targetDate (unparseable slug) can NEVER be graded as its loss leg — yet a null-target WINNER
      // still settles via REDEEM and counts. That asymmetry is a survivorship gap inside the survivorship
      // control; surface its magnitude (the `arch-` tolerance already recovers archived weather markets, so
      // this is the non-weather remainder) so the operator can confirm it is negligible before trusting winRate.
      if (opts.resolvedBefore !== undefined && p.targetDate === null && p.buyCostUsd > 0) {
        nUngradedNullTarget++;
        ungradedNullTargetStakeUsd += p.buyCostUsd;
      }
      continue; // not realized yet
    }
    realizedTotalUsd += realized;
    buyCostUsd += p.buyCostUsd;
    sellProceedsUsd += p.sellProceedsUsd;
    redeemProceedsUsd += p.redeemProceedsUsd;
    mergeProceedsUsd += p.mergeProceedsUsd;
    // An empty-conditionId accumulator is the merged-leg (outcomeIndex 999) blob: its cash is real and stays
    // in the trading total above (preserving the cash-conservation identity the reconciliation gate checks),
    // but it groups UNRELATED positions under one '' key — so it can never be a single attributable bet.
    // Never count it as a win/loss or push it as a bet (that would merge positions, delete losses, and emit a
    // meaningless blended entryPrice into the bucket-ROI / Brier blocks).
    if (p.conditionId === '') {
      nUnattributed++;
      continue;
    }
    const won = realized > 0;
    if (won) nWins++;
    else nLosses++;
    // dominant leg label (the side the wallet put the most money on) — for attribution/display.
    let outcome = '';
    let best = -1;
    for (const [leg, notional] of p.legNotional) {
      if (notional > best) {
        best = notional;
        outcome = leg;
      }
    }
    // No BUY shares (REDEEM/SELL-only, or zero-share BUY) → no implied entry probability. NaN so every
    // entry-keyed surface skips it instead of dumping a priceless bet into the [0,0.10) cut.
    const entryPrice = p.buyShares > 0 ? p.buyPriceShares / p.buyShares : NaN;
    if (!Number.isFinite(entryPrice)) nEntryUnpriced++;
    // Calibration truth (distinct from trading-P&L `won`): a real settlement payout = resolved in the money;
    // a graded total loss = resolved out of the money; a SELL-closed exit = resolution unobserved (null).
    const resolvedWon: boolean | null =
      p.redeemProceedsUsd > 0 || p.mergeProceedsUsd > 0 ? true : resolvedLoss ? false : null;
    bets.push({
      conditionId: p.conditionId,
      outcome,
      entryPrice,
      ask: entryPrice,
      won,
      resolvedWon,
      realizedUsd: realized,
      stakedUsd: p.buyCostUsd,
      citySlug: p.citySlug,
      targetDate: p.targetDate,
      region: usRegionForCity(p.citySlug),
    });
  }

  const nDecisive = nWins + nLosses;
  return {
    bets,
    realizedTotalUsd,
    incentivesUsd,
    tradingPlusIncentivesUsd: realizedTotalUsd + incentivesUsd,
    buyCostUsd,
    sellProceedsUsd,
    redeemProceedsUsd,
    mergeProceedsUsd,
    volumeUsd,
    nWins,
    nLosses,
    winRate: nDecisive === 0 ? NaN : nWins / nDecisive,
    roiOnVolume: volumeUsd === 0 ? NaN : realizedTotalUsd / volumeUsd,
    nUnattributed,
    nEntryUnpriced,
    nUngradedNullTarget,
    ungradedNullTargetStakeUsd,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// daily cumulative curve (the user-pnl-api analog)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** UTC YYYY-MM-DD for a unix-seconds timestamp. */
export function utcDay(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/**
 * Reconstruct the cumulative realized-PnL curve by day — the deterministic analog of user-pnl-api, via the
 * same conditionId cash-flow identity as reconstructRealizedPnl, on the SAME TRADING-ONLY basis: each day's
 * realized P&L is the net TRADING cash flow that day — trading proceeds (SELL + REDEEM + MERGE usdcSize)
 * MINUS cost (BUY usdcSize), EXCLUDING liquidity incentives (MAKER_REBATE + REWARD), which are not trading
 * P&L. Over fully-resolved markets the cumulative net trading cash flow IS the realized-trading-PnL curve
 * (every share ends worth $0 or $1), so the final cumUsd equals reconstructRealizedPnl's realizedTotalUsd
 * (the trading-only headline) and reconciles to user-pnl-api's realized-trading curve. Pure + total.
 *
 * Note: because a BUY books a negative cash flow on its OWN day and the matching REDEEM books the positive
 * payout on a LATER day, the intermediate curve can dip below the eventual total before recovering — that
 * is the honest realized-cash trajectory (the same convention as a cash-basis PnL chart); the ENDPOINT is
 * the invariant the gate checks.
 */
export function dailyPnlCurve(fills: WalletFill[]): DailyPnlPoint[] {
  const usable = fills.filter(
    (f) => isFiniteNum(f.timestamp) && isFiniteNum(f.sizeShares) && isFiniteNum(f.usdcSize),
  );
  const perDay = new Map<string, number>();

  for (const f of usable) {
    const usd = Math.abs(f.usdcSize);
    const day = utcDay(f.timestamp);
    if (f.type === 'TRADE' && f.side === 'BUY') {
      bump(perDay, day, -usd); // cash out
    } else if (f.type === 'TRADE' && f.side === 'SELL') {
      bump(perDay, day, usd); // trading cash in
    } else if (TRADING_PROCEEDS_EVENT_TYPES.has(f.type) && usd > 0) {
      bump(perDay, day, usd); // REDEEM / MERGE — trading cash in
    }
    // MAKER_REBATE / REWARD (liquidity incentives — not trading P&L) and SPLIT / CONVERSION (net-zero cash):
    // no entry on the trading-only realized-PnL curve.
  }

  const days = [...perDay.keys()].sort();
  let cum = 0;
  return days.map((date) => {
    const realizedUsd = perDay.get(date)!;
    cum += realizedUsd;
    return { date, realizedUsd, cumUsd: cum };
  });
}

function bump(m: Map<string, number>, k: string, delta: number): void {
  m.set(k, (m.get(k) ?? 0) + delta);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// ROI by entry-price bucket
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Which cut a price falls in (the top cut is closed at 1). −1 when out of [0,1]. */
function cutIndex(price: number): number {
  if (!isFiniteNum(price) || price < 0 || price > 1) return -1;
  for (let i = 0; i < ENTRY_PRICE_CUTS.length; i++) {
    const c = ENTRY_PRICE_CUTS[i]!;
    if (price >= c.lo && (price < c.hi || (i === ENTRY_PRICE_CUTS.length - 1 && price === 1))) return i;
  }
  return -1;
}

/**
 * ROI for each decisive entry-price cut [0,0.10),[0.10,0.25),[0.25,0.45),[0.45,0.75),[0.75,1]. The
 * cheap-longshot signature lives in the first two cuts (<0.25 positive) and the mid cut ([0.45,0.75)
 * negative). Helpers `roiBelow025` / `roiMid045to075` expose those two as first-class. Pure + total.
 */
export function roiByEntryBucket(bets: RealizedBet[]): BucketRoi[] {
  const rows: BucketRoi[] = ENTRY_PRICE_CUTS.map((c) => ({
    label: c.label,
    lo: c.lo,
    hi: c.hi,
    nBets: 0,
    nWins: 0,
    realizedUsd: 0,
    stakedUsd: 0,
    roi: NaN,
  }));
  for (const b of bets) {
    const idx = cutIndex(b.entryPrice);
    if (idx < 0) continue;
    const r = rows[idx]!;
    r.nBets++;
    if (b.won) r.nWins++;
    r.realizedUsd += b.realizedUsd;
    r.stakedUsd += b.stakedUsd;
  }
  for (const r of rows) r.roi = r.stakedUsd === 0 ? NaN : r.realizedUsd / r.stakedUsd;
  return rows;
}

/** Aggregate ROI over the cheap-longshot cut entryPrice < 0.25 (the [0,0.10)+[0.10,0.25) union). */
export function roiBelow025(bets: RealizedBet[]): BucketRoi {
  return aggregateRange(bets, 0, 0.25, '<0.25');
}

/** Aggregate ROI over the mid "No spray" cut [0.45,0.75) (the documented negative). */
export function roiMid045to075(bets: RealizedBet[]): BucketRoi {
  return aggregateRange(bets, 0.45, 0.75, '[0.45,0.75)');
}

function aggregateRange(bets: RealizedBet[], lo: number, hi: number, label: string): BucketRoi {
  let nBets = 0,
    nWins = 0,
    realizedUsd = 0,
    stakedUsd = 0;
  for (const b of bets) {
    if (!isFiniteNum(b.entryPrice) || b.entryPrice < lo || b.entryPrice >= hi) continue;
    nBets++;
    if (b.won) nWins++;
    realizedUsd += b.realizedUsd;
    stakedUsd += b.stakedUsd;
  }
  return { label, lo, hi, nBets, nWins, realizedUsd, stakedUsd, roi: stakedUsd === 0 ? NaN : realizedUsd / stakedUsd };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// attribution
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Realized P&L + ROI by city → country → region (US vs international). Pure + total. */
export function attribution(bets: RealizedBet[]): Attribution {
  return {
    byCity: rollup(bets, (b) => b.citySlug ?? '(unknown)'),
    byCountry: rollup(bets, (b) => countryKeyForCity(b.citySlug)),
    byRegion: rollup(bets, (b) => b.region ?? '(unknown)'),
  };
}

function rollup(bets: RealizedBet[], keyOf: (b: RealizedBet) => string): AttributionRow[] {
  const m = new Map<string, AttributionRow>();
  for (const b of bets) {
    const key = keyOf(b);
    let r = m.get(key);
    if (!r) {
      r = { key, nBets: 0, realizedUsd: 0, stakedUsd: 0, roi: NaN };
      m.set(key, r);
    }
    r.nBets++;
    r.realizedUsd += b.realizedUsd;
    r.stakedUsd += b.stakedUsd;
  }
  const rows = [...m.values()];
  for (const r of rows) r.roi = r.stakedUsd === 0 ? NaN : r.realizedUsd / r.stakedUsd;
  // descending by realized P&L (the §3 "top winner cities" view)
  return rows.sort((a, b) => b.realizedUsd - a.realizedUsd);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// calibration: Brier vs outcomes
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Score the wallet's revealed buys as a forecaster: each decisive bet's implied probability = entryPrice,
 * truth = the MARKET RESOLUTION (`resolvedWon`), NOT the trading-P&L `won`. A position closed by SELL before
 * resolution (resolvedWon === null) has an unobserved outcome and is excluded — scoring it by trading P&L
 * would credit/penalise a calibration the wallet never revealed. Bets with no implied entry price (entryPrice
 * NaN — REDEEM/SELL-only) are excluded too. We score the binary {q, hit} with a per-bet Brier (q−o)², ECE, and
 * a reliability diagram (scores.ts). The headline is a paired bootstrap p on (walletBrier − marketBrier) per bet.
 *
 * BASELINE (documented): the "market-implied prob baseline" we compare against is the SAME bet priced at
 * the market's revealed willingness to pay — but the cleanest market-implied probability for a
 * cheap-longshot bet IS its trade price (the price at which the market cleared the fill). To make the
 * comparison meaningful rather than self-referential, the baseline is the **degenerate uninformative
 * market prior** of 0.5 per outcome (a coin — "the market told you nothing about which side wins"). The
 * wallet's edge over this baseline is exactly its calibration skill: if buying cheap longshots that win
 * more than their price implies, walletBrier < 0.5-baseline Brier and the paired p is small. This is the
 * conservative, self-contained choice (the alternative — a live order-book mid per condition — is not in
 * the /activity spine and would require a second fetch per market). The baseline is named in the printout.
 */
export const MARKET_BASELINE_PROB = 0.5;

export function brierVsOutcomes(bets: RealizedBet[]): BrierResult {
  // Only bets with an implied entry price AND an OBSERVED market resolution (resolvedWon non-null) are
  // scoreable — SELL-closed exits have an unknown resolution, REDEEM/SELL-only bets have no entry price.
  const usable = bets.filter(
    (b) => isFiniteNum(b.entryPrice) && b.entryPrice >= 0 && b.entryPrice <= 1 && b.resolvedWon !== null,
  );
  const n = usable.length;
  if (n === 0) {
    return { n: 0, walletBrier: NaN, marketBrier: NaN, ece: NaN, reliability: [], pairedBootstrapP: 1 };
  }
  const preds: Prediction[] = usable.map((b) => ({ q: b.entryPrice, hit: b.resolvedWon === true }));

  // Per-bet binary Brier: brierScore([q, 1-q], outcomeIdx) where outcomeIdx=0 means "resolved YES" (q is P(win)).
  const walletPer = usable.map((b) => brierScore([b.entryPrice, 1 - b.entryPrice], b.resolvedWon === true ? 0 : 1));
  const marketPer = usable.map((b) =>
    brierScore([MARKET_BASELINE_PROB, 1 - MARKET_BASELINE_PROB], b.resolvedWon === true ? 0 : 1),
  );
  const mean = (xs: number[]): number => xs.reduce((a, x) => a + x, 0) / xs.length;
  const walletBrier = mean(walletPer);
  const marketBrier = mean(marketPer);

  // paired bootstrap on (wallet − market) per bet: pairedBootstrapPValue returns the fraction of resample
  // means >= 0, so a wallet reliably SHARPER (lower Brier than the baseline) yields negative diffs and a
  // small p — the same orientation as the go-live gate's (house − market) Brier test.
  const diffs = walletPer.map((w, i) => w - marketPer[i]!);
  const pairedBootstrapP = pairedBootstrapPValue(diffs);

  return {
    n,
    walletBrier,
    marketBrier,
    ece: expectedCalibrationError(preds),
    reliability: reliabilityBins(preds, 10),
    pairedBootstrapP,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// regime change — PELT-lite
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** OLS fit (slope + residual SSE) of y over integer x = 0..n−1. slope NaN / sse 0 for n < 2. */
function olsFit(ys: number[]): { slope: number; sse: number } {
  const n = ys.length;
  if (n < 2) return { slope: NaN, sse: 0 };
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, y) => a + y, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (ys[i]! - meanY);
    den += (i - meanX) ** 2;
  }
  if (den === 0) return { slope: NaN, sse: 0 };
  const slope = num / den;
  const intercept = meanY - slope * meanX;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i]! - (intercept + slope * i);
    sse += r * r;
  }
  return { slope, sse };
}

/** OLS slope only (USD/day for a daily curve). NaN for n < 2. */
function olsSlope(ys: number[]): number {
  return olsFit(ys).slope;
}

/**
 * The CAUSAL regime ONSET — the FINAL TROUGH CROSSING of the cumulative curve.
 *
 * Definition (one principled choice, parameter-free, documented): scan the curve once and find the GLOBAL
 * MINIMUM (the trough). The onset is the date of the LAST day whose cumulative value is at/below that global
 * minimum — i.e. the last day the curve sits at its all-time low before it rises away and never comes back
 * to/below that level. After that day the curve is in the new (durably-rising) regime by construction.
 *
 * Why this method (and why it beats the min-SSE split for "when did it start"):
 *   - It is CAUSAL / measured from the LOCAL trend: it depends only on the curve up to the trough and the
 *     fact it never returns there — NOT on how steep the later tail becomes.
 *   - It is endpoint-STABLE: appending more accelerating days to the right edge cannot move the trough, so
 *     the onset does not migrate (the documented instability of the global two-segment kink, which the
 *     skeptics showed drifts May 07→May 26 as the right edge grows).
 *   - It matches the handoff §6 directive ("flag where post-slope flips sign" = the ONSET) and the economic
 *     reading of badatmath's curve: a 4-month flat/losing era bottoming at the trough, then vertical.
 *
 * Returns the onset date, or null when the curve never leaves its trough durably (the last point IS the
 * global min → no sustained rise) or there are too few points. `minSeg` (default 3) is the minimum number of
 * post-trough days required to call the rise "durable" — too short a tail is not a regime.
 */
export function regimeOnset(series: DailyPnlPoint[], opts: { minSeg?: number } = {}): string | null {
  const minSeg = Math.max(2, opts.minSeg ?? 3);
  const n = series.length;
  if (n < minSeg + 1) return null;
  const cum = series.map((p) => p.cumUsd);
  if (cum.some((v) => !isFiniteNum(v))) return null;

  // Global minimum (the trough). The onset is the LAST day at/below that minimum.
  let minVal = Infinity;
  for (const v of cum) minVal = Math.min(minVal, v);
  let lastAtMin = -1;
  const eps = 1e-9;
  for (let i = 0; i < n; i++) if (cum[i]! <= minVal + eps) lastAtMin = i;

  // No durable rise if the trough is the final point (or within minSeg of the end) — too short a tail to be
  // a new regime — or if the curve never rises above the trough afterward.
  if (lastAtMin < 0 || lastAtMin > n - 1 - minSeg) return null;
  let rises = false;
  for (let i = lastAtMin + 1; i < n; i++) if (cum[i]! > minVal + eps) { rises = true; break; }
  if (!rises) return null;

  return series[lastAtMin]!.date;
}

/**
 * Single-regime-change detector on the cumulative realized-PnL curve, reporting BOTH the causal ONSET and
 * the best-fit kink (see RegimeChange). Deterministic.
 *
 * BEST-FIT KINK (the min-SSE two-segment split, PELT's objective): scan every candidate split (min segment
 * length each side), fit two OLS lines (pre vs post), and pick the split that MINIMISES the total residual
 * SSE. We prefer a SIGN-FLIP split (pre slope ≤ 0, post slope > 0 — a genuine flat/losing → rising change)
 * and only fall back to a min-SSE acceleration split (post > ~2× pre, both positive) if no sign-flip exists.
 * NOTE: on an accelerating tail the min-SSE kink is dragged later than the onset (the skeptics' endpoint
 * instability) — that is why we ALSO report the causal onset, which does not have that bias.
 *
 * ONSET (`onsetDate`): the final trough crossing via `regimeOnset` — the causal, endpoint-stable "when did
 * the durable winning era begin". Reported alongside, clearly labeled, not in place of the kink.
 *
 * Returns onsetDate + breakpointDate (first day of the post segment) + the two kink slopes. Either date is
 * null when its respective rule finds no qualifying change. `minSeg` defaults to 3 days/side.
 */
export function regimeChange(series: DailyPnlPoint[], opts: { minSeg?: number } = {}): RegimeChange {
  const minSeg = Math.max(2, opts.minSeg ?? 3);
  const n = series.length;
  const onsetDate = regimeOnset(series, { minSeg });
  if (n < minSeg * 2) {
    return { onsetDate, breakpointDate: null, preSlope: NaN, postSlope: NaN };
  }
  const cum = series.map((p) => p.cumUsd);

  let bestFlip: { idx: number; pre: number; post: number; sse: number } | null = null;
  let bestAccel: { idx: number; pre: number; post: number; sse: number } | null = null;
  for (let k = minSeg; k <= n - minSeg; k++) {
    const a = olsFit(cum.slice(0, k));
    const b = olsFit(cum.slice(k));
    if (!isFiniteNum(a.slope) || !isFiniteNum(b.slope)) continue;
    const sse = a.sse + b.sse; // total residual of the two-segment fit (PELT objective)
    if (a.slope <= 0 && b.slope > 0) {
      if (bestFlip === null || sse < bestFlip.sse) bestFlip = { idx: k, pre: a.slope, post: b.slope, sse };
    } else if (a.slope > 1e-9 && b.slope > 2 * a.slope && b.slope > a.slope) {
      if (bestAccel === null || sse < bestAccel.sse) bestAccel = { idx: k, pre: a.slope, post: b.slope, sse };
    }
  }

  const best = bestFlip ?? bestAccel; // a real regime onset (sign flip) beats a pure acceleration
  if (best === null) {
    return { onsetDate, breakpointDate: null, preSlope: NaN, postSlope: NaN };
  }
  return {
    onsetDate,
    breakpointDate: series[best.idx]!.date,
    preSlope: best.pre,
    postSlope: best.post,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// convenience: full per-arm edge stats over the realized bets (reuses armEdgeStats / wilsonInterval)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The wallet's overall edge/EV bundle over all decisive realized bets ({won, ask=entryPrice}). */
export function walletEdgeStats(bets: RealizedBet[]): ArmEdgeStats {
  return armEdgeStats(bets);
}

/** Win-rate Wilson CI over the decisive realized bets. */
export function winRateCi(recon: RealizedReconstruction): { lo: number; hi: number } {
  return wilsonInterval(recon.nWins, recon.nWins + recon.nLosses);
}
