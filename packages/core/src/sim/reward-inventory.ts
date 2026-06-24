/**
 * core/sim/reward-inventory — REC-10: the MEASURED two-sided maker fill+inventory cost of
 * forecast-free liquidity-reward farming on weather (REWARD-INVENTORY-BACKTEST.md). The decisive
 * follow-up to the REC-8 first-pass (`core/sim/reward-farming.ts`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. The REC-8 first-pass returned a PASS-per-criterion (+$28/market) but flagged it
 * NOT actionable, load-bearing on a GUESSED parameter: it models the adverse-selection / inventory
 * cost of the fills a near-mid quote implies as a reduced-form `τ` (a tax per $ filled, swept over a
 * range). The whole verdict rides on that guess. This module REPLACES the guess with a MEASUREMENT —
 * an event-driven simulation of a two-sided maker quote over the REAL `market_snapshots` best-bid/ask
 * series of RESOLVED weather buckets, carrying the resulting inventory to the REAL win/lose outcome.
 * Fictive capital, real odds. It is the Phase-C "exact two-sided fill simulation over the real
 * market_snapshots series" the handoff (§4.C) named.
 *
 * THE DECISIVE REDUCTION. A small operator's gross reward YIELD ≈ pool / in-band-competing-capital
 * (their stake cancels when small) ≈ the ~6.5%/day "implied" headline, INDEPENDENT of stake. So the
 * entire net-profit question collapses to one measurable quantity:
 *
 *     is the realized two-sided maker fill+inventory P&L (per $ resting capital, per ~1-day market)
 *     a smaller loss than the ~6.5%/day reward income?
 *
 * If the measured fill cost exceeds the reward yield → forecast-free farming is net-negative → FAIL.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FILL MODEL (the novel piece; the two-sided generalisation of `maker-spray.simulateFill`). Each
 * epoch (consecutive snapshot pair) the farmer rests a two-sided quote re-centred on the current mid:
 * a BUY `restOffsetCents` below mid and a SELL `restOffsetCents` above mid (both inside `max_spread`).
 * A resting BUY at `bidPx` fills when the book's best ASK comes DOWN to it (`next.ask ≤ bidPx`); a
 * resting SELL at `askPx` fills when the best BID comes UP to it (`next.bid ≥ askPx`). This EMBEDS
 * adverse selection with no free parameter: on a bucket drifting to LOSE the ask collapses → your BID
 * fills → you are long a loser; on a bucket drifting to WIN the bid rises → your ASK fills → you are
 * short a winner. You round-trip the spread only when the book oscillates through both quotes. Fills
 * accumulate signed inventory; a simple inventory cap (`invCapMult × size`, the minimal risk control a
 * farmer applies — stop quoting the side that would breach the cap) bounds it; residual inventory is
 * marked to the REAL resolution (win → YES pays 1, lose → 0). The maker earns the live `weather_fees`
 * rebate (`rebateRate × takerFee`) on every fill. Net cash = spread captured + rebate − adverse
 * inventory loss. Pure, deterministic, total — junk/empty input → a skipped/zeroed result, never throws.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * HONEST CIs. Each weather-day is the unit of independence (all stations on a day share one synoptic
 * state), so per-regime fill-yield CIs are CLUSTER-MEAN t-intervals over weather-days (reuse
 * `selector-learn.clusterMeanTCi`), never per-bucket (which would over-state n). The binding regime is
 * MID-RANGE (0.10–0.90): 93% of the live reward pool sits there, so that is where the verdict is
 * decided; cheap/rich are reported alongside.
 *
 * Imports ONLY pure core siblings (`fees`, `selector-learn`, `stats`) — NEVER `packages/trading`
 * (analytics-only; the live rail stays DORMANT). The frozen verdict is pre-registered below.
 */
import { takerFeePerShare } from '../fees.ts';
import { clusterMeanTCi, type Ci } from './selector-learn.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// inputs
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One row of a resolved bucket's order-book time-series (the cost side; real `market_snapshots`). */
export interface QuoteSnapshot {
  /** Unix seconds (market_snapshots.captured_at). */
  capturedAt: number;
  /** best_bid in (0,1) or null. */
  bid: number | null;
  /** best_ask in (0,1) or null. */
  ask: number | null;
}

/** A resolved weather bucket: its book series + the REAL win/lose outcome + its independence cluster. */
export interface ResolvedBucketSeries {
  /** condition_id|bucket — for dedup / reporting. */
  key: string;
  /** Station ICAO (reporting / secondary clustering). */
  station: string;
  /** The weather-day 'YYYY-MM-DD' (the CLUSTER of independence — synoptic state). */
  weatherDay: string;
  /** Did the YES side resolve in the money (resolved_outcome === 'win'). */
  won: boolean;
  /** The book snapshots, ASCENDING by capturedAt (caller-sorted). */
  snapshots: QuoteSnapshot[];
}

/** A live funded market (the income side; real `market_rewards`). */
export interface FundedMarket {
  conditionId: string;
  /** rewards daily pool (USDC/day). */
  dailyPoolUsd: number;
  /** competing maker capital ALREADY resting in-band (bid_depth_usd + ask_depth_usd). */
  competingCapitalUsd: number;
  /** mid (for the regime split). */
  mid: number | null;
}

/** The price regime — the verdict is decided in MID; cheap/rich reported alongside. */
export type Regime = 'cheap' | 'mid' | 'rich';

/** Regime cut points (docs-verbatim two-sidedness thresholds). */
export const REGIME_LO = 0.1;
export const REGIME_HI = 0.9;

/** Classify a price into its regime. NaN/degenerate → 'mid' (the dominant, conservative default). */
export function regimeOf(mid: number | null | undefined): Regime {
  if (mid == null || !Number.isFinite(mid)) return 'mid';
  if (mid < REGIME_LO) return 'cheap';
  if (mid > REGIME_HI) return 'rich';
  return 'mid';
}

/** The swept parameters of the hypothetical two-sided quote. Honest, conservative defaults. */
export interface InventoryParams {
  /** Resting size per side, in shares. Capital deployed ≈ this (≈$1 two-sided collateral/share). Default 100. */
  sizeShares: number;
  /** How far INSIDE max_spread to rest, in cents from mid (smaller = closer = higher reward score). Default 1. */
  restOffsetCents: number;
  /** Program max_spread (cents) — the reward band; a quote outside it earns nothing. Default 4.5. */
  maxSpreadCents: number;
  /** Price tick the quote is rounded to (cent grid). Default 0.01. */
  tickSize: number;
  /** Inventory cap as a multiple of size: stop quoting the side that would push |inv| past this. Default 1. */
  invCapMult: number;
  /** Maker rebate as a share of the taker fee on each fill (live weather_fees = 0.25). Default 0.25. */
  rebateRate: number;
  /** Taker fee rate (weather_fees rate, for the rebate credit). Default 0.05. */
  feeRate: number;
  /** Minimum usable epochs (snapshot pairs) for a bucket to be modelled. Default 8. */
  minEpochs: number;
}

export const DEFAULT_INVENTORY_PARAMS: InventoryParams = {
  sizeShares: 100,
  restOffsetCents: 1,
  maxSpreadCents: 4.5,
  tickSize: 0.01,
  invCapMult: 1,
  rebateRate: 0.25,
  feeRate: 0.05,
  minEpochs: 8,
};

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// per-bucket inventory simulation (the measurement)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The realized two-sided maker outcome on one resolved bucket. */
export interface BucketInventoryResult {
  key: string;
  station: string;
  weatherDay: string;
  regime: Regime;
  won: boolean;
  /** Median mid over the modelled epochs — the bucket's characteristic price. */
  medianMid: number;
  /**
   * PRIMARY realized fill+inventory P&L in USDC: residual inventory marked to the REAL win/lose
   * resolution (the purely-passive farmer who quotes two-sided and never flattens — settlement P&L).
   */
  fillPnlUsd: number;
  /**
   * Realized fill+inventory P&L marking residual inventory to the LAST observed mid instead of the
   * binary resolution — the farmer who flattens at end-of-day at the prevailing price (mark-to-market,
   * the gentler "I actively close out" variant; reported alongside to show the conclusion is robust to
   * the marking choice and is NOT a hold-to-binary-resolution artifact).
   */
  fillPnlFlattenUsd: number;
  /** Nominal capital deployed (USDC) ≈ the resting two-sided collateral = sizeShares × ~$1/share-pair. */
  capitalUsd: number;
  /** PRIMARY: fillPnlUsd / capitalUsd — measured fill yield per $ capital over the market's life. */
  fillYield: number;
  /** fillPnlFlattenUsd / capitalUsd — the flatten-at-last-mid variant. */
  fillYieldFlatten: number;
  /** Net signed inventory carried to resolution (shares; + long YES, − short YES). */
  finalInventoryShares: number;
  nBidFills: number;
  nAskFills: number;
  nEpochs: number;
  /** Observed window length (days) of the modelled series — coverage diagnostic. */
  windowDays: number;
  /** True when the bucket could not be modelled (too few usable epochs) — excluded from aggregates. */
  skipped: boolean;
}

const usable = (p: number | null | undefined): p is number =>
  p != null && Number.isFinite(p) && p > 0 && p < 1;

const usableMid = (s: QuoteSnapshot): number | null =>
  usable(s.bid) && usable(s.ask) && (s.bid as number) <= (s.ask as number)
    ? ((s.bid as number) + (s.ask as number)) / 2
    : null;

/** Round to the tick grid (nearest), guarding float drift. */
function roundTick(px: number, tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return px;
  return Math.round(px / tick + 1e-9) * tick;
}

const median = (xs: number[]): number => {
  const a = xs.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};

/**
 * Simulate a continuously re-centred two-sided maker quote over ONE resolved bucket's real book
 * series, carrying inventory to the real resolution. The SOLE measurement of the fill cost. Pure +
 * total: a series with < minEpochs usable epochs → a skipped result (NaN yield), never throws.
 */
export function simulateBucketInventory(
  b: ResolvedBucketSeries,
  params: InventoryParams = DEFAULT_INVENTORY_PARAMS,
): BucketInventoryResult {
  const p = { ...DEFAULT_INVENTORY_PARAMS, ...params };
  const snaps = (Array.isArray(b.snapshots) ? b.snapshots : [])
    .filter((s) => s && Number.isFinite(s.capturedAt) && usableMid(s) != null)
    .sort((x, y) => x.capturedAt - y.capturedAt);

  const skipped: BucketInventoryResult = {
    key: b.key,
    station: b.station,
    weatherDay: b.weatherDay,
    regime: 'mid',
    won: b.won === true,
    medianMid: NaN,
    fillPnlUsd: 0,
    fillPnlFlattenUsd: 0,
    capitalUsd: NaN,
    fillYield: NaN,
    fillYieldFlatten: NaN,
    finalInventoryShares: 0,
    nBidFills: 0,
    nAskFills: 0,
    nEpochs: 0,
    windowDays: 0,
    skipped: true,
  };
  // need at least minEpochs epochs ⇒ minEpochs+1 snapshots
  if (snaps.length < Math.max(2, p.minEpochs + 1)) return skipped;

  const o = b.won === true ? 1 : 0;
  const S = p.sizeShares > 0 ? p.sizeShares : DEFAULT_INVENTORY_PARAMS.sizeShares;
  const off = Math.min(Math.max(p.restOffsetCents, 0), p.maxSpreadCents) / 100;
  const invCapShares = Math.max(0, p.invCapMult) * S;
  const tick = p.tickSize > 0 ? p.tickSize : 0.01;

  let inv = 0; // signed YES shares held
  let cash = 0; // realized USDC cashflow (starts flat)
  let nEpochs = 0;
  let nBidFills = 0;
  let nAskFills = 0;
  let lastMid = NaN;
  const mids: number[] = [];

  const rebateOf = (px: number): number => p.rebateRate * takerFeePerShare(px, p.feeRate) * S;

  for (let i = 0; i < snaps.length - 1; i++) {
    const s = snaps[i]!;
    const next = snaps[i + 1]!;
    const mid = usableMid(s);
    if (mid == null) continue;
    const bidPx = roundTick(mid - off, tick);
    const askPx = roundTick(mid + off, tick);
    // valid two-sided quote: strictly inside (0,1) and bid < ask
    if (!(bidPx > 0 && askPx < 1 && bidPx < askPx)) continue;
    mids.push(mid);
    lastMid = mid;

    // inventory-aware quoting: only quote the side that does not breach the cap.
    const quoteBid = inv < invCapShares;
    const quoteAsk = inv > -invCapShares;
    nEpochs++;

    // fills against the book's move INTO the next snapshot (maker-spray ask-touch / bid-touch).
    if (quoteBid && usable(next.ask) && (next.ask as number) <= bidPx) {
      inv += S;
      cash -= S * bidPx;
      cash += rebateOf(bidPx);
      nBidFills++;
    }
    if (quoteAsk && usable(next.bid) && (next.bid as number) >= askPx) {
      inv -= S;
      cash += S * askPx;
      cash += rebateOf(askPx);
      nAskFills++;
    }
    // also fold the LAST snapshot's mid into the flatten reference (no epoch/fill there).
    const lastSnapMid = usableMid(snaps[snaps.length - 1]!);
    if (i === snaps.length - 2 && lastSnapMid != null) lastMid = lastSnapMid;
  }

  if (nEpochs === 0) return skipped;
  // PRIMARY: residual inventory marked to the real resolution (the passive-farmer settlement P&L).
  const fillPnlResolution = cash + inv * o;
  // VARIANT: residual inventory flattened at the last observed mid (mark-to-market end-of-day).
  const fillPnlFlatten = cash + inv * (Number.isFinite(lastMid) ? lastMid : o);

  // capital deployed ≈ resting two-sided collateral ≈ size × $1/share-pair (consistent with the
  // reward-income base). Fixed nominal so income and cost share one denominator.
  const capitalUsd = S;
  const medianMid = median(mids);
  const windowDays = (snaps[snaps.length - 1]!.capturedAt - snaps[0]!.capturedAt) / 86_400;
  return {
    key: b.key,
    station: b.station,
    weatherDay: b.weatherDay,
    regime: regimeOf(medianMid),
    won: b.won === true,
    medianMid,
    fillPnlUsd: fillPnlResolution,
    fillPnlFlattenUsd: fillPnlFlatten,
    capitalUsd,
    fillYield: capitalUsd > 0 ? fillPnlResolution / capitalUsd : NaN,
    fillYieldFlatten: capitalUsd > 0 ? fillPnlFlatten / capitalUsd : NaN,
    finalInventoryShares: inv,
    nBidFills,
    nAskFills,
    nEpochs,
    windowDays,
    skipped: false,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// per-regime fill-yield aggregation (cluster-mean t-CI over weather-days)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The measured fill cost for one regime — the headline of the cost side. */
export interface RegimeFillCost {
  regime: Regime;
  /** Modelled buckets in this regime. */
  nBuckets: number;
  /** Distinct weather-days (the independence clusters → the CI's effective n). */
  nDays: number;
  /** Mean fill yield per $ resting capital (cluster-mean over weather-days), with its 95% t-CI. */
  meanFillYield: number;
  ciLo: number;
  ciHi: number;
  /** Median per-bucket fill yield (concentration check). */
  medianFillYield: number;
  /** Mean fill rate per side (diagnostic). */
  bidFillsPerBucket: number;
  askFillsPerBucket: number;
}

const meanOf = (xs: number[]): number =>
  xs.length === 0 ? NaN : xs.reduce((a, v) => a + v, 0) / xs.length;

/** Aggregate per-bucket results into one regime's fill cost (cluster-mean t-CI over weather-days). */
export function regimeFillCost(results: BucketInventoryResult[], regime: Regime): RegimeFillCost {
  const rows = (Array.isArray(results) ? results : []).filter(
    (r) => !r.skipped && r.regime === regime && Number.isFinite(r.fillYield),
  );
  const yields = rows.map((r) => r.fillYield);
  const clusters = rows.map((r) => r.weatherDay);
  const ci: Ci = clusterMeanTCi(yields, clusters);
  const nDays = new Set(clusters).size;
  return {
    regime,
    nBuckets: rows.length,
    nDays,
    meanFillYield: ci.mean,
    ciLo: ci.lo,
    ciHi: ci.hi,
    medianFillYield: median(yields),
    bidFillsPerBucket: meanOf(rows.map((r) => r.nBidFills)),
    askFillsPerBucket: meanOf(rows.map((r) => r.nAskFills)),
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// reward income (capital-share on the live funded universe)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A small operator's gross reward yield per day on $K of deployed capital in one market:
 *   share = K / (K + κ·competing) ; gross = share·pool ; yield = gross/K = pool / (K + κ·competing).
 * κ scales the competing in-band capital (1 = realistic/full book; →0 = alone-in-market ceiling).
 * Pure; degenerate inputs → 0.
 */
export function rewardYieldPerDay(
  poolUsd: number,
  competingUsd: number,
  capitalUsd: number,
  kappa: number = 1,
): number {
  const pool = Number.isFinite(poolUsd) && poolUsd > 0 ? poolUsd : 0;
  const comp = Number.isFinite(competingUsd) && competingUsd > 0 ? competingUsd : 0;
  const k = Number.isFinite(capitalUsd) && capitalUsd > 0 ? capitalUsd : 0;
  const kap = Number.isFinite(kappa) && kappa >= 0 ? kappa : 1;
  const denom = k + kap * comp;
  return denom > 0 ? pool / denom : 0;
}

/** The reward yield for one regime aggregated over the live funded markets in it. */
export interface RegimeRewardYield {
  regime: Regime;
  nMarkets: number;
  totalPoolUsd: number;
  totalCompetingUsd: number;
  /** Capital-weighted mean reward yield/day (= Σpool / (Σcapital + κ·Σcompeting)). */
  meanRewardYield: number;
}

/** Aggregate the live funded universe into one regime's reward yield (capital-weighted). */
export function regimeRewardYield(
  markets: FundedMarket[],
  regime: Regime,
  capitalPerMarketUsd: number,
  kappa: number = 1,
): RegimeRewardYield {
  const rows = (Array.isArray(markets) ? markets : []).filter((m) => regimeOf(m.mid) === regime);
  const totalPool = rows.reduce((a, m) => a + (Number.isFinite(m.dailyPoolUsd) ? m.dailyPoolUsd : 0), 0);
  const totalComp = rows.reduce(
    (a, m) => a + (Number.isFinite(m.competingCapitalUsd) ? Math.max(0, m.competingCapitalUsd) : 0),
    0,
  );
  const totalCap = rows.length * (capitalPerMarketUsd > 0 ? capitalPerMarketUsd : 0);
  const kap = Number.isFinite(kappa) && kappa >= 0 ? kappa : 1;
  const denom = totalCap + kap * totalComp;
  return {
    regime,
    nMarkets: rows.length,
    totalPoolUsd: totalPool,
    totalCompetingUsd: totalComp,
    meanRewardYield: denom > 0 ? totalPool / denom : 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// net synthesis + the frozen verdict
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The net (income + measured cost) for one regime, per $ capital per ~1-day market. */
export interface RegimeNet {
  regime: Regime;
  rewardYield: number;
  fillYield: number;
  fillCi: { lo: number; hi: number };
  /** net = rewardYield + fillYield (fillYield is the measured cost, typically < 0). */
  netYield: number;
  /** net CI propagating the fill-cost uncertainty (reward treated as a near-deterministic snapshot mean). */
  netLo: number;
  netHi: number;
  nBuckets: number;
  nDays: number;
  nMarkets: number;
}

/** Combine one regime's reward yield + measured fill cost into its net. */
export function regimeNet(reward: RegimeRewardYield, cost: RegimeFillCost): RegimeNet {
  const rewardYield = reward.meanRewardYield;
  const fillYield = cost.meanFillYield;
  const net = Number.isFinite(rewardYield) && Number.isFinite(fillYield) ? rewardYield + fillYield : NaN;
  return {
    regime: reward.regime,
    rewardYield,
    fillYield,
    fillCi: { lo: cost.ciLo, hi: cost.ciHi },
    netYield: net,
    netLo: Number.isFinite(rewardYield) && Number.isFinite(cost.ciLo) ? rewardYield + cost.ciLo : NaN,
    netHi: Number.isFinite(rewardYield) && Number.isFinite(cost.ciHi) ? rewardYield + cost.ciHi : NaN,
    nBuckets: cost.nBuckets,
    nDays: cost.nDays,
    nMarkets: reward.nMarkets,
  };
}

/** PASS / PROMISING / FAIL per the frozen REC-10 kill-criterion. */
export type InventoryVerdictLabel = 'PASS' | 'PROMISING' | 'FAIL';

/** Below this many independent weather-days a clustered CI cannot CERTIFY a positive result. */
export const MIN_CI_DAYS = 8;

export interface InventoryVerdict {
  label: InventoryVerdictLabel;
  /** The binding regime adjudicated (MID-RANGE — 93% of the live pool). */
  binding: RegimeNet;
  /** True when the binding regime spans < MIN_CI_DAYS independent weather-days (CI not certifiable). */
  dataLimited: boolean;
  reason: string;
}

/**
 * Adjudicate the binding MID-RANGE net against the PRE-REGISTERED REC-10 kill-criterion
 * (REWARD-INVENTORY-BACKTEST.md §4, frozen BEFORE the measured fill cost was seen — do NOT move to
 * fit a result, WO-5 discipline):
 *
 *   binding regime = MID-RANGE (0.10–0.90): 93% of the live reward pool, so the verdict is decided there.
 *   net yield = reward yield (capital-share, realistic κ=1) + MEASURED two-sided fill+inventory yield.
 *
 *   PASS      = net yield > 0 AND its 95% CI lower bound (fill-cost uncertainty) > 0.
 *   PROMISING = net yield > 0 but the CI straddles 0.
 *   FAIL      = net yield ≤ 0 → the measured two-sided fill+inventory cost erases the reward share;
 *               forecast-free farming is net-negative for a small operator. Rail stays DORMANT.
 */
export function rewardInventoryVerdict(binding: RegimeNet): InventoryVerdict {
  const pctf = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%/day` : '—');
  const net = binding.netYield;
  const dataLimited = !(binding.nDays >= MIN_CI_DAYS);
  const ciNote = dataLimited
    ? ` (CI spans only ${binding.nDays} independent weather-day(s) < ${MIN_CI_DAYS} — DIRECTIONAL, not CI-certified)`
    : '';
  if (!Number.isFinite(net) || net <= 0) {
    return {
      label: 'FAIL',
      binding,
      dataLimited,
      reason:
        `FAIL — mid-range net ${pctf(net)} ≤ 0: reward yield ${pctf(binding.rewardYield)} + ` +
        `MEASURED two-sided fill yield ${pctf(binding.fillYield)} [${pctf(binding.fillCi.lo)}, ${pctf(
          binding.fillCi.hi,
        )}]. The fills erase the reward share — forecast-free farming is net-negative${ciNote}. Rail stays DORMANT.`,
    };
  }
  // A positive net cannot be CERTIFIED below the cluster floor — downgrade PASS → PROMISING.
  if (!dataLimited && Number.isFinite(binding.netLo) && binding.netLo > 0) {
    return {
      label: 'PASS',
      binding,
      dataLimited,
      reason:
        `PASS — mid-range net ${pctf(net)} > 0, 95% CI lower bound ${pctf(binding.netLo)} > 0 ` +
        `(reward ${pctf(binding.rewardYield)} + measured fill ${pctf(binding.fillYield)}). ` +
        `The reward share survives the measured fill cost; a two-sided MM bot design is justified.`,
    };
  }
  return {
    label: 'PROMISING',
    binding,
    dataLimited,
    reason:
      `PROMISING — mid-range net ${pctf(net)} > 0 but ${
        dataLimited
          ? `it cannot be certified${ciNote}`
          : `the 95% CI [${pctf(binding.netLo)}, ${pctf(binding.netHi)}] straddles 0 (measured fill-cost uncertainty)`
      }. Needs more resolved-market coverage before capital.`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the end-to-end study (one call → the full picture at a κ corner)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The full reward-inventory study at one competition corner. */
export interface InventoryStudy {
  kappa: number;
  capitalPerMarketUsd: number;
  /** Per-regime measured fill cost. */
  cost: Record<Regime, RegimeFillCost>;
  /** Per-regime reward yield (live funded universe). */
  reward: Record<Regime, RegimeRewardYield>;
  /** Per-regime net (income + measured cost). */
  net: Record<Regime, RegimeNet>;
  /** The frozen verdict (binding = mid-range). */
  verdict: InventoryVerdict;
  /** Buckets modelled / skipped (coverage). */
  nModelled: number;
  nSkipped: number;
}

/**
 * Run the whole study at one corner: simulate every resolved bucket, aggregate fill cost by regime,
 * compute reward yield by regime on the live funded universe, synthesise the net, adjudicate the
 * frozen verdict on the binding mid-range regime. Pure (the per-bucket sim is deterministic). The
 * `results` are pre-computed once by the caller and reused across κ corners (the sim does not depend
 * on κ — only the reward side does), so this takes results, not raw series.
 */
export function runInventoryStudy(
  results: BucketInventoryResult[],
  markets: FundedMarket[],
  opts: { kappa?: number; capitalPerMarketUsd?: number } = {},
): InventoryStudy {
  const kappa = opts.kappa ?? 1;
  const capital = opts.capitalPerMarketUsd ?? DEFAULT_INVENTORY_PARAMS.sizeShares; // ≈ size in $ (≈$1/share)
  const regimes: Regime[] = ['cheap', 'mid', 'rich'];
  const cost = {} as Record<Regime, RegimeFillCost>;
  const reward = {} as Record<Regime, RegimeRewardYield>;
  const net = {} as Record<Regime, RegimeNet>;
  for (const r of regimes) {
    cost[r] = regimeFillCost(results, r);
    reward[r] = regimeRewardYield(markets, r, capital, kappa);
    net[r] = regimeNet(reward[r], cost[r]);
  }
  const modelled = (Array.isArray(results) ? results : []).filter((r) => !r.skipped);
  return {
    kappa,
    capitalPerMarketUsd: capital,
    cost,
    reward,
    net,
    verdict: rewardInventoryVerdict(net.mid),
    nModelled: modelled.length,
    nSkipped: (Array.isArray(results) ? results.length : 0) - modelled.length,
  };
}
