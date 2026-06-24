/**
 * core/sim/reward-farming — REC-8: the PURE economics of forecast-free Polymarket liquidity-reward
 * farming on weather (REWARD-FARMING-HANDOFF.md). The first money path this whole investigation has
 * surfaced that is INDEPENDENT of the forecast axis: Polymarket turned on FUNDED liquidity rewards on
 * weather (REC-4, 2026-06-24 — 471 funded temperature markets, ~$31k/day total pool), which pay a maker
 * for resting two-sided near the mid REGARDLESS of fill or outcome. The question (PASS-gate,
 * REWARD-FARMING-HANDOFF §4.D): does a realistically-achievable reward SHARE, net of the
 * adverse-selection / inventory cost of the fills it implies, clear zero on deployed capital?
 *
 * This module is the pure, deterministic economics. It does NOT fetch — the live `/sampling-markets`
 * pools and `/book` depth are pulled by `scripts/research/reward-farming-firstpass.ts` and passed in as
 * `MarketRewardInputs`. Pure + total: junk / empty input → a zeroed estimate (NaN point estimates where
 * undefined), never throws. Deterministic — the only randomness is the across-market bootstrap, seeded.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE SCORING FORMULA (Polymarket liquidity rewards, docs verbatim — docs.polymarket.com/market-makers
 * /liquidity-rewards). Per resting order at spread `s` cents from the (size-adjusted) midpoint, with the
 * market's max_spread `v` cents:
 *
 *     S(v, s) = ((v − s) / v)^2     for 0 ≤ s ≤ v ;  0 otherwise          [spreadScore]
 *
 * (The universal `b`/scaling multiplier cancels in the share RATIO — every order in a market shares it —
 * so we set it to 1.) Each side aggregates size-weighted: Qone = Σ_bids size·S, Qtwo = Σ_asks size·S.
 * The two are combined into a single maker score by the two-sidedness rule (c = 3.0):
 *
 *     mid ∈ [0.10, 0.90]  →  Qmin = max( min(Qone,Qtwo), max(Qone/c, Qtwo/c) )   (one-sided allowed, /3)
 *     mid < 0.10 or > 0.90 →  Qmin = min(Qone, Qtwo)                              (STRICT two-sided)
 *
 * Per epoch (sampled each minute) a maker's share = their Σ Qmin ÷ Σ over all makers of Σ Qmin, times the
 * market's daily pool. For a SNAPSHOT first-pass we treat the instantaneous Qmin ratio as the steady-state
 * share (the maker rests continuously). MOST weather buckets sit < 0.10 (cheap longshots) → the STRICT
 * two-sided regime: a one-sided quote earns ZERO, and you are forced to also quote the expensive NO side.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE COMPETITION DENOMINATOR (the dominant unknown, §0.2). `/book` gives EVERY resting order (price,size)
 * but NOT which maker owns it, and Qmin is per-maker + non-linear (the min/max couples the two sides), so a
 * clean per-maker decomposition is impossible from the book alone. We therefore model the existing book as a
 * single aggregate "competition maker" and combine its summed side-scores via the SAME rule. Because
 * Σ_i min(aᵢ,bᵢ) ≤ min(Σaᵢ,Σbᵢ), treating competitors as one aggregate OVERSTATES their Qmin → UNDERSTATES
 * my share → this is the CONSERVATIVE (pessimistic-for-us) direction. A `kappa` knob scales competition for
 * the sweep (κ=1 realistic/aggregate; κ<1 = decomposed/thin pros; κ→0 = I am alone, the optimistic ceiling).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FILL COST (the killer, §0.3 / §4.C). Resting near mid WILL fill, adversely (the §12 maker-spray + the
 * badatmath-replica finding: filled volume realizes a NEGATIVE edge — adverse-selection tax ≫ spread tax).
 * Unlike §12 (one-sided cheap-longshot resting) this is TWO-SIDED MM, so we model fills on BOTH legs via a
 * transparent reduced-form: a fraction `phi` of my resting notional fills over the market's life and realizes
 * a loss of `adverseTaxPerDollar` per $ filled (anchored to the §12 −1.7pp floor … the replica 32.8pp tail),
 * less the live `weather_fees` maker rebate (rebateRate·takerFee, a small + credit on fills). The exact
 * two-sided fill simulation over the real `market_snapshots` series is Phase C of the full study; this
 * reduced-form is the FIRST-PASS screen — its job is to answer "is the gross reward even in the same league
 * as the fill cost?" and is swept across phi × tax so the verdict never rides one fragile point.
 */
import { takerFeePerShare } from '../fees.ts';
import { bootstrapMeanCi } from './stats.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// scoring primitives (the docs-verbatim formula)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The single-sidedness penalty divisor (Polymarket `c`, docs-verbatim). */
export const SCORING_C = 3.0;
/** Mid thresholds below/above which STRICT two-sided quoting is required (docs-verbatim). */
export const TWO_SIDED_LO = 0.1;
export const TWO_SIDED_HI = 0.9;

/** One resting order on the book: price in (0,1), size in shares (>0). */
export interface BookOrder {
  price: number;
  size: number;
}

/**
 * Per-order spread score S(v,s) = ((v−s)/v)² for 0 ≤ s ≤ v, else 0. `v`/`s` in CENTS (max_spread is
 * given in cents, e.g. 4.5). Total: a non-positive/NaN `v` → 0; out-of-band `s` → 0; never throws.
 */
export function spreadScore(maxSpreadCents: number, spreadCents: number): number {
  if (!(maxSpreadCents > 0) || !Number.isFinite(spreadCents) || spreadCents < 0) return 0;
  if (spreadCents > maxSpreadCents) return 0;
  const u = (maxSpreadCents - spreadCents) / maxSpreadCents;
  return u * u;
}

/**
 * Size-weighted score of ONE side's orders: Σ size·S(v, |price−mid| in cents) over orders within
 * max_spread of the mid. `mid`/prices in probability (0,1); `maxSpreadCents` in cents. Total — empty /
 * junk → 0.
 */
export function sideScore(orders: BookOrder[], mid: number, maxSpreadCents: number): number {
  if (!Array.isArray(orders) || !(mid > 0 && mid < 1)) return 0;
  let q = 0;
  for (const o of orders) {
    if (!o || !(o.price > 0 && o.price < 1) || !(o.size > 0)) continue;
    const spreadCents = Math.abs(o.price - mid) * 100;
    const s = spreadScore(maxSpreadCents, spreadCents);
    if (s > 0) q += o.size * s;
  }
  return q;
}

/**
 * Combine a maker's two side-scores into the single Qmin per the two-sidedness rule (docs-verbatim).
 *   mid ∈ [0.10,0.90] → max( min(Qone,Qtwo), max(Qone/c, Qtwo/c) )   (one-sided allowed at /c)
 *   else              → min(Qone, Qtwo)                              (STRICT two-sided; one-sided ⇒ 0)
 * Total — negative/NaN inputs floored to 0.
 */
export function makerQmin(qOne: number, qTwo: number, mid: number, c: number = SCORING_C): number {
  const a = Number.isFinite(qOne) && qOne > 0 ? qOne : 0;
  const b = Number.isFinite(qTwo) && qTwo > 0 ? qTwo : 0;
  const cc = c > 0 ? c : SCORING_C;
  if (mid >= TWO_SIDED_LO && mid <= TWO_SIDED_HI) {
    return Math.max(Math.min(a, b), Math.max(a / cc, b / cc));
  }
  return Math.min(a, b); // cheap-longshot / rich regime: strict two-sided
}

/**
 * My share of the daily pool = myQmin / (myQmin + κ·compQmin). κ scales the (aggregate-book) competition
 * for the sweep: κ=1 realistic (full live book, conservative — overstates competition), κ<1 thin/decomposed,
 * κ→0 the alone-in-the-market ceiling. Returns 0 when I score nothing; 1 when I am alone and score > 0.
 */
export function rewardShare(myQmin: number, compQmin: number, kappa: number = 1): number {
  const me = Number.isFinite(myQmin) && myQmin > 0 ? myQmin : 0;
  const comp = Number.isFinite(compQmin) && compQmin > 0 ? compQmin : 0;
  const k = Number.isFinite(kappa) && kappa >= 0 ? kappa : 1;
  const denom = me + k * comp;
  return denom > 0 ? me / denom : 0;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// per-market economics
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The live per-market inputs the script pulls from `/sampling-markets` + `/book` (one YES token). */
export interface MarketRewardInputs {
  /** Stable id (condition_id) — for dedup / reporting. */
  conditionId: string;
  /** Human slug (e.g. highest-temperature-in-guangzhou-…). */
  slug: string;
  /** The market's daily reward pool in USDC (Σ rewards.rates[].rewards_daily_rate). */
  dailyPoolUsd: number;
  /** rewards.max_spread in CENTS (4.5 across the weather universe). */
  maxSpreadCents: number;
  /** rewards.min_size in shares (20 or 50). */
  minSize: number;
  /** YES-token best bid / best ask in (0,1), or null. */
  bestBid: number | null;
  bestAsk: number | null;
  /** Full resting bid / ask orders on the YES token (price, size) — the competition denominator. */
  bids: BookOrder[];
  asks: BookOrder[];
}

/** The pre-registered, swept parameters of a hypothetical small-operator two-sided quote. */
export interface RewardFarmingParams {
  /** Capital (USDC) I deploy per market — locks ≈ this in two-sided collateral. Default 100. */
  capitalPerMarketUsd: number;
  /** How far INSIDE max_spread I rest, in cents from the mid (smaller = closer = higher score). Default 1. */
  restOffsetCents: number;
  /** κ — competition multiplier on the aggregate book Qmin (1 realistic, →0 alone). Default 1. */
  kappa: number;
  /** φ — fraction of my resting notional that FILLS over the market's life. Default 0.5. */
  fillFraction: number;
  /** τ — adverse-selection loss per $ of FILLED notional (§12 floor 0.017 … replica tail 0.328). Default 0.05. */
  adverseTaxPerDollar: number;
  /** Maker rebate as a share of the taker fee on fills (live weather_fees = 0.25). Default 0.25. */
  rebateRate: number;
  /** Taker fee rate (weather_fees rate, for the rebate credit). Default 0.05. */
  feeRate: number;
  /** The single-sidedness divisor c. Default 3.0. */
  c: number;
}

export const DEFAULT_PARAMS: RewardFarmingParams = {
  capitalPerMarketUsd: 100,
  restOffsetCents: 1,
  kappa: 1,
  fillFraction: 0.5,
  adverseTaxPerDollar: 0.05,
  rebateRate: 0.25,
  feeRate: 0.05,
  c: 3.0,
};

/** The per-market economic estimate. All USD/day for the market's ~1-day life. */
export interface MarketEconomics {
  conditionId: string;
  slug: string;
  mid: number | null;
  dailyPoolUsd: number;
  /** Shares I rest PER SIDE (capital ÷ ~$1 two-sided collateral/share). */
  mySizeShares: number;
  /** My Qmin from resting `mySizeShares` two-sided at restOffset. */
  myQmin: number;
  /** The aggregate live-book Qmin (the competition). */
  compQmin: number;
  /** My modelled pool share = myQmin/(myQmin+κ·compQmin). */
  share: number;
  /** Gross reward income (USD) = share · pool. */
  grossRewardUsd: number;
  /** Capital at risk (USD) ≈ two-sided collateral I lock. */
  capitalUsd: number;
  /** Filled notional (USD) = φ · my two-sided notional. */
  filledNotionalUsd: number;
  /** Adverse-selection fill cost (USD, ≥0) = filledNotional·τ. */
  fillCostUsd: number;
  /** Maker rebate credit (USD, ≥0) on the fills. */
  rebateCreditUsd: number;
  /** NET P&L (USD) for the market = gross reward − fill cost + rebate. */
  netUsd: number;
  /** Net yield on capital for the ~1-day market = netUsd / capitalUsd. */
  netYield: number;
  /** True when the strict two-sided regime applies (mid < 0.10 or > 0.90). */
  strictTwoSided: boolean;
  /** True when I could not model (no usable mid/book) — excluded from the verdict. */
  skipped: boolean;
}

const usableMid = (bid: number | null, ask: number | null): number | null => {
  if (bid != null && ask != null && bid > 0 && ask < 1 && bid <= ask) return (bid + ask) / 2;
  return null;
};

/**
 * Estimate one market's net reward-farming economics. Two-sided quote: I rest `mySizeShares` shares a
 * bid `restOffsetCents` below mid and an ask `restOffsetCents` above mid (both inside max_spread). My
 * two-sided collateral ≈ S·midBid + S·(1−midAsk) ≈ S USDC, so mySizeShares ≈ capital. Gross reward = my
 * pool share × pool; fill cost = φ·notional·τ; rebate credit on fills. Pure; null mid/empty book → skipped.
 */
export function estimateMarketEconomics(
  m: MarketRewardInputs,
  params: RewardFarmingParams = DEFAULT_PARAMS,
): MarketEconomics {
  const p = { ...DEFAULT_PARAMS, ...params };
  const mid = usableMid(m.bestBid, m.bestAsk);
  const base = {
    conditionId: m.conditionId,
    slug: m.slug,
    mid,
    dailyPoolUsd: Number.isFinite(m.dailyPoolUsd) ? m.dailyPoolUsd : 0,
    mySizeShares: 0,
    myQmin: 0,
    compQmin: 0,
    share: 0,
    grossRewardUsd: 0,
    capitalUsd: 0,
    filledNotionalUsd: 0,
    fillCostUsd: 0,
    rebateCreditUsd: 0,
    netUsd: 0,
    netYield: NaN,
    strictTwoSided: mid != null ? mid < TWO_SIDED_LO || mid > TWO_SIDED_HI : false,
    skipped: true,
  };
  if (mid == null || !(m.maxSpreadCents > 0)) return base;

  // My resting prices: restOffsetCents inside the mid each side (clamped into (0,1) & within max_spread).
  const off = Math.min(Math.max(p.restOffsetCents, 0), m.maxSpreadCents) / 100;
  const myBidPx = Math.max(0.01, mid - off);
  const myAskPx = Math.min(0.99, mid + off);
  // Two-sided collateral ≈ S·bid + S·(1−ask) per share-pair; size from the capital budget.
  const collatPerShare = myBidPx + (1 - myAskPx);
  if (!(collatPerShare > 0)) return base;
  const mySizeShares = p.capitalPerMarketUsd / collatPerShare;
  if (!(mySizeShares > 0)) return base;
  // Honour the program min_size: below it, the quote earns nothing.
  if (mySizeShares < (m.minSize > 0 ? m.minSize : 0)) {
    return { ...base, mySizeShares, capitalUsd: p.capitalPerMarketUsd, skipped: false };
  }

  // My side-scores (one order each side at the chosen offset) and the competition's (whole live book).
  const myScoreOneSide = mySizeShares * spreadScore(m.maxSpreadCents, off * 100);
  const myQmin = makerQmin(myScoreOneSide, myScoreOneSide, mid, p.c); // symmetric two-sided
  const compBid = sideScore(m.bids, mid, m.maxSpreadCents);
  const compAsk = sideScore(m.asks, mid, m.maxSpreadCents);
  const compQmin = makerQmin(compBid, compAsk, mid, p.c);

  const share = rewardShare(myQmin, compQmin, p.kappa);
  const grossRewardUsd = share * (Number.isFinite(m.dailyPoolUsd) ? m.dailyPoolUsd : 0);

  // Fill cost: φ of my two-sided notional fills, realizing τ loss/$, less the maker rebate on those fills.
  const myNotionalUsd = mySizeShares * (myBidPx + myAskPx); // gross two-sided notional quoted
  const filledNotionalUsd = p.fillFraction * myNotionalUsd;
  const fillCostUsd = filledNotionalUsd * Math.max(0, p.adverseTaxPerDollar);
  // rebate credit ≈ rebateRate · taker fee on the filled shares (fee ≈ rate·p·(1−p) per share at ~mid).
  const filledShares = filledNotionalUsd / Math.max(1e-9, (myBidPx + myAskPx) / 2);
  const rebateCreditUsd = p.rebateRate * takerFeePerShare(mid, p.feeRate) * filledShares;

  const netUsd = grossRewardUsd - fillCostUsd + rebateCreditUsd;
  const capitalUsd = mySizeShares * collatPerShare; // == capitalPerMarketUsd by construction
  return {
    ...base,
    mySizeShares,
    myQmin,
    compQmin,
    share,
    grossRewardUsd,
    capitalUsd,
    filledNotionalUsd,
    fillCostUsd,
    rebateCreditUsd,
    netUsd,
    netYield: capitalUsd > 0 ? netUsd / capitalUsd : NaN,
    skipped: false,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// universe aggregate + the frozen verdict
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A 95% CI (bootstrap mean across markets). */
export interface MeanCi {
  mean: number;
  lo: number;
  hi: number;
  n: number;
}

/** The universe-level summary across all funded weather markets at one param corner. */
export interface UniverseSummary {
  /** Markets modelled (not skipped). */
  nMarkets: number;
  /** Total daily pool across modelled markets (USD). */
  totalPoolUsd: number;
  /** Total gross reward income I'd capture (USD/day across the universe). */
  totalGrossUsd: number;
  /** Total fill cost (USD/day). */
  totalFillCostUsd: number;
  /** Total net P&L (USD/day across the universe). */
  totalNetUsd: number;
  /** Total capital deployed (USD). */
  totalCapitalUsd: number;
  /** Mean per-market net P&L (USD) + across-market bootstrap 95% CI. */
  meanNetUsd: MeanCi;
  /** Median per-market net P&L (USD) — concentration check. */
  medianNetUsd: number;
  /** Fraction of modelled markets with net P&L > 0. */
  fracNetPositive: number;
  /** Portfolio net daily yield on deployed capital = totalNet / totalCapital. */
  portfolioDailyYield: number;
}

const median = (xs: number[]): number => {
  const a = xs.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};

/** Aggregate per-market economics into the universe summary (bootstrap seed 42 by default). */
export function summarizeUniverse(rows: MarketEconomics[], seed = 42): UniverseSummary {
  const modelled = (Array.isArray(rows) ? rows : []).filter((r) => !r.skipped);
  const nets = modelled.map((r) => r.netUsd);
  const boot = bootstrapMeanCi(nets, { seed });
  const sum = (xs: number[]): number => xs.reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
  const totalCapitalUsd = sum(modelled.map((r) => r.capitalUsd));
  const totalNetUsd = sum(nets);
  return {
    nMarkets: modelled.length,
    totalPoolUsd: sum(modelled.map((r) => r.dailyPoolUsd)),
    totalGrossUsd: sum(modelled.map((r) => r.grossRewardUsd)),
    totalFillCostUsd: sum(modelled.map((r) => r.fillCostUsd)),
    totalNetUsd,
    totalCapitalUsd,
    meanNetUsd: { mean: boot.mean, lo: boot.lo, hi: boot.hi, n: boot.n },
    medianNetUsd: median(nets),
    fracNetPositive: modelled.length ? modelled.filter((r) => r.netUsd > 0).length / modelled.length : NaN,
    portfolioDailyYield: totalCapitalUsd > 0 ? totalNetUsd / totalCapitalUsd : NaN,
  };
}

/** PASS / PROMISING / FAIL per the frozen REC-8 first-pass kill-criterion. */
export type RewardVerdictLabel = 'PASS' | 'PROMISING' | 'FAIL';

export interface RewardFarmingVerdict {
  label: RewardVerdictLabel;
  /** The realistic-corner summary the verdict adjudicates. */
  summary: UniverseSummary;
  /** One-line human verdict. */
  reason: string;
}

/**
 * Adjudicate the realistic-corner universe summary against the PRE-REGISTERED REC-8 first-pass criterion
 * (REWARD-FARMING-HANDOFF §4.D, frozen before the number was seen — do NOT move to fit a result):
 *
 *   PASS      = mean per-market net > 0 AND its 95% CI lower bound > 0 AND median net > 0.
 *   PROMISING = mean net > 0 but CI straddles 0 OR median ≤ 0 (concentration) → full Phase A→D warranted.
 *   FAIL      = mean net ≤ 0 → forecast-free farming uneconomic for a small operator; rail stays dormant.
 */
export function rewardFarmingVerdict(summary: UniverseSummary): RewardFarmingVerdict {
  const { mean, lo } = summary.meanNetUsd;
  const med = summary.medianNetUsd;
  const pct = (v: number): string => (Number.isFinite(v) ? `$${v.toFixed(3)}` : '—');
  if (!Number.isFinite(mean) || mean <= 0) {
    return {
      label: 'FAIL',
      summary,
      reason: `FAIL — mean per-market net ${pct(mean)} ≤ 0 at the realistic corner: forecast-free farming is uneconomic for a small operator (fills erase the reward share). Rail stays dormant.`,
    };
  }
  if (Number.isFinite(lo) && lo > 0 && Number.isFinite(med) && med > 0) {
    return {
      label: 'PASS',
      summary,
      reason: `PASS — mean per-market net ${pct(mean)} > 0, 95% CI lower bound ${pct(lo)} > 0, median ${pct(med)} > 0. The full Phase A→D study + a two-sided MM bot design are justified.`,
    };
  }
  return {
    label: 'PROMISING',
    summary,
    reason: `PROMISING — mean per-market net ${pct(mean)} > 0 but ${
      !(lo > 0) ? `the 95% CI lower bound ${pct(lo)} straddles 0` : `the median ${pct(med)} ≤ 0 (one-market concentration)`
    }. Warrants the full Phase A→D study (persisted rates + depth capture + walk-forward) before any capital.`,
  };
}
