/**
 * core/sim/cross-venue-arb — the CROSS-VENUE (Kalshi ↔ Polymarket) relative-value measurement on
 * daily-Tmax temperature ladders. The 10th-signal candidate (CROSS-VENUE-SPIKE.md): the one
 * forecast-free, EXECUTABLE, genuinely-orthogonal lever the R&D program never tested. Every prior
 * signal asked "is OUR forecast better than the market?" or "is one book consistent with ITSELF?"
 * (the 8th, complete-set). This asks the orthogonal "do TWO independent venues price the SAME day
 * differently — beyond what it costs to harvest the difference?". It needs no forecast skill.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE MECHANISM, AND WHY IT IS NOT A CLEAN ARBITRAGE. The same US city's daily high trades on both
 * Polymarket ("highest-temperature-in-<city>", 2°F buckets, resolves on Wunderground hourly-obs max)
 * and Kalshi (KXHIGH<city>, 2°F buckets, resolves on the NWS Climatological Report / CLI). Two
 * STRUCTURAL frictions stand between "the prices differ" and "you can lock a profit":
 *
 *   1. A 1°F BIN OFFSET. Polymarket bins start EVEN (80-81, 82-83, …); Kalshi bins start ODD
 *      (79-80, 81-82, …). Their clean cumulative boundaries INTERLEAVE — Polymarket gives P(high≥K)
 *      cleanly at even K, Kalshi at odd K — so the two venues NEVER share a constructible threshold.
 *      Any cross-venue position therefore carries either a ~1°F directional stub or an interpolation
 *      residual. We charge that stub as `offsetCost` (the mass in the integers the short leg covers
 *      but the long leg does not), priced at the market PMF — so the "free" cashflow from selling a
 *      broader event than you bought is netted back out, leaving only a genuine price dislocation.
 *   2. A DUAL RESOLUTION SOURCE. NWS CLI is QC'd and runs ≥ Wunderground (occasionally +1°F). So even
 *      a perfectly bin-aligned position is not market-neutral: the two legs can resolve on opposite
 *      sides of the threshold. We charge that as `basisCost` = P(the two sources straddle the
 *      threshold), from a `BasisModel` (a measured (CLI−WU) distribution; conservative prior default).
 *
 * THE FROZEN, PRE-REGISTERED KILL GATE (operator-ratified 2026-06-25, WO-5 discipline — defined by
 * the economics, not fitted to a result): an EXECUTABLE, basis-adjusted, fee-cleared cross-venue
 * position must show POSITIVE expectancy on ≥ `MIN_WIN_FRAC` (10%) of matched city-days that have
 * real depth, with the pooled 95% CI of the mean net edge EXCLUDING 0. Else KILL — the 10th
 * falsified signal, same destination as the 8th (structurally walled). The live rail stays DORMANT;
 * this module imports only the fee curve, never `packages/trading`.
 *
 * Pure + total: junk / degenerate input → a null/zeroed result, never a throw.
 */
import { takerFeePerShare } from '../fees.ts';

export type VenueName = 'polymarket' | 'kalshi';

/** Polymarket weather taker fee rate (gamma feeSchedule.rate; rate·p·(1−p) per share). */
export const POLY_FEE_RATE = 0.05;
/**
 * Kalshi general trading fee rate (round_up(0.07·C·p·(1−p)) per contract; we model the continuous
 * 0.07·p·(1−p) without the per-contract round-up — a slight UNDER-estimate of the real fee, i.e.
 * generous to the edge, which is the safe direction for a kill gate). The weather-specific rate is
 * verified at build time against kalshi.com/fee-schedule; parameterised so a change is one constant.
 */
export const KALSHI_FEE_RATE = 0.07;

/** The integer-°F grid the implied distributions are reconstructed on (covers all realistic Tmax). */
export const GRID_LO_F = 20;
export const GRID_HI_F = 130;
/**
 * Width (°F) over which an OPEN tail bin's mass is concentrated near its boundary, instead of spread
 * across the whole grid. The lesson that forced this (Denver, 2026-06-25): on a cool day Kalshi priced
 * 83% on "74° or below"; spreading that mass uniformly down to GRID_LO_F dragged the implied mean to
 * ~53°F and manufactured a phantom 21°F cross-venue divergence + a phantom edge — when both venues in
 * fact agreed the high was ~73-74°F. A "≤74" outcome almost always means low-70s, not 30s; concentrate
 * the tail within TAIL_SPREAD_F of the boundary. 3°F ≈ one-and-a-half interior bins.
 */
export const TAIL_SPREAD_F = 3;

const usablePx = (p: number | null | undefined): p is number =>
  p != null && Number.isFinite(p) && p > 0 && p < 1;

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// venue ladder → implied per-integer-°F distribution (overround removed)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One ladder bucket on either venue. Integer-°F coverage is the INCLUSIVE span [loF, hiF]; an open
 * tail uses a null bound ("X°F or below" → loF=null, hiF=X; "X°F or higher" → loF=X, hiF=null).
 * yesAsk/yesBid are the YES top-of-book in probability units (0..1). topAskSize/topBidSize are the
 * resting size at the touch (contracts/shares) — carried for the depth ("real capacity") filter.
 */
export interface VenueBucket {
  loF: number | null;
  hiF: number | null;
  yesAsk: number | null;
  yesBid: number | null;
  topAskSize?: number | null;
  topBidSize?: number | null;
}

/** A venue's full ladder for ONE city-day. */
export interface VenueLadder {
  venue: VenueName;
  buckets: VenueBucket[];
}

/** A ladder reconstructed onto the integer grid: a normalized PMF + the bucket spans (for execution). */
export interface ImpliedLadder {
  venue: VenueName;
  /** pmf[i] = P(high = GRID_LO_F + i), summing to 1 (0 if degenerate). */
  pmf: number[];
  /** Mean implied high (°F); NaN if degenerate. */
  meanF: number;
  /** Were there any usable quotes at all? */
  ok: boolean;
  /** The source buckets, clamped to the grid + with the usable mid mass — for executable synthesis. */
  spans: Array<{ loF: number; hiF: number; mid: number; yesAsk: number | null; yesBid: number | null; topAskSize: number; topBidSize: number }>;
}

const GRID_N = GRID_HI_F - GRID_LO_F + 1;

/** Usable mid for a bucket: (ask+bid)/2, or the single usable side, clamped to (0,1); null otherwise. */
function bucketMid(b: VenueBucket): number | null {
  const a = usablePx(b.yesAsk) ? b.yesAsk : null;
  const d = usablePx(b.yesBid) ? b.yesBid : null;
  if (a != null && d != null) return clamp01((a + d) / 2);
  if (a != null) return clamp01(a);
  if (d != null) return clamp01(d);
  return null;
}

/**
 * Reconstruct a venue ladder onto the integer-°F grid: assign each bucket's normalized mid mass
 * uniformly across the integers it spans, so Σ pmf = 1 (this removes the book's overround/underround,
 * isolating the SHAPE of the implied distribution for a like-for-like cross-venue comparison). Pure +
 * total — no usable quotes → ok:false, a flat-zero pmf.
 */
export function impliedLadder(ladder: VenueLadder): ImpliedLadder {
  const venue = ladder?.venue === 'kalshi' ? 'kalshi' : 'polymarket';
  const buckets = Array.isArray(ladder?.buckets) ? ladder.buckets : [];
  const spans: ImpliedLadder['spans'] = [];
  let totalMass = 0;

  for (const b of buckets) {
    const mid = bucketMid(b);
    if (mid == null || mid <= 0) continue;
    const lowTail = b.loF == null;
    const highTail = b.hiF == null;
    if (lowTail && highTail) continue; // a bin with no bounds is degenerate
    // Open tails concentrate their mass within TAIL_SPREAD_F of the boundary (see TAIL_SPREAD_F): a
    // "≤X" bin spans [X−(TAIL_SPREAD_F−1), X]; a "≥X" bin spans [X, X+(TAIL_SPREAD_F−1)]. Interior
    // (between) bins keep their exact range.
    let lo: number;
    let hi: number;
    if (lowTail) {
      hi = Math.min(GRID_HI_F, Math.max(GRID_LO_F, Math.round(b.hiF!)));
      lo = Math.max(GRID_LO_F, hi - (TAIL_SPREAD_F - 1));
    } else if (highTail) {
      lo = Math.max(GRID_LO_F, Math.min(GRID_HI_F, Math.round(b.loF!)));
      hi = Math.min(GRID_HI_F, lo + (TAIL_SPREAD_F - 1));
    } else {
      lo = Math.max(GRID_LO_F, Math.round(b.loF!));
      hi = Math.min(GRID_HI_F, Math.round(b.hiF!));
    }
    if (hi < lo) continue;
    spans.push({
      loF: lo,
      hiF: hi,
      mid,
      yesAsk: usablePx(b.yesAsk) ? b.yesAsk : null,
      yesBid: usablePx(b.yesBid) ? b.yesBid : null,
      topAskSize: Number.isFinite(b.topAskSize as number) && (b.topAskSize as number) > 0 ? (b.topAskSize as number) : 0,
      topBidSize: Number.isFinite(b.topBidSize as number) && (b.topBidSize as number) > 0 ? (b.topBidSize as number) : 0,
    });
    totalMass += mid;
  }

  const pmf = new Array<number>(GRID_N).fill(0);
  if (totalMass <= 0 || spans.length === 0) {
    return { venue, pmf, meanF: NaN, ok: false, spans };
  }
  for (const s of spans) {
    const width = s.hiF - s.loF + 1;
    const per = s.mid / totalMass / width;
    for (let k = s.loF; k <= s.hiF; k++) {
      const idx = k - GRID_LO_F;
      pmf[idx] = (pmf[idx] ?? 0) + per; // idx ∈ [0, GRID_N) by clamp; ?? satisfies noUncheckedIndexedAccess
    }
  }
  let meanF = 0;
  for (let i = 0; i < GRID_N; i++) meanF += (GRID_LO_F + i) * pmf[i]!;
  return { venue, pmf, meanF, ok: true, spans };
}

/** Survival P(high ≥ k) under an implied ladder's PMF. Pure + total. */
export function survivalAt(impl: ImpliedLadder, k: number): number {
  if (!impl?.ok) return NaN;
  const kk = Math.ceil(k);
  if (kk <= GRID_LO_F) return 1;
  if (kk > GRID_HI_F) return 0;
  let s = 0;
  for (let i = kk - GRID_LO_F; i < GRID_N; i++) s += impl.pmf[i]!;
  return s;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// cross-venue divergence profile (descriptive — the analytics signal)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface DivergenceProfile {
  ok: boolean;
  /** Signed survival gap S_poly(k) − S_kalshi(k) at each integer threshold k in the active range. */
  gaps: Array<{ k: number; sPoly: number; sKalshi: number; signed: number }>;
  /** Max |signed gap| (a KS-style divergence) and the threshold where it occurs. */
  maxAbsGap: number;
  maxGapAtF: number;
  /** Signed mean-temperature difference (Polymarket − Kalshi), °F. >0 ⇒ Polymarket prices it hotter. */
  meanDiffF: number;
}

const EMPTY_DIVERGENCE: DivergenceProfile = { ok: false, gaps: [], maxAbsGap: 0, maxGapAtF: NaN, meanDiffF: NaN };

/**
 * The cross-venue divergence: for every integer threshold where either venue carries mass, the signed
 * survival gap, the KS-style max, and the implied mean-temperature difference. This is the descriptive
 * analytics output (it ALWAYS exists even when no profit does); the executable test is separate. Pure.
 */
export function crossVenueDivergence(poly: ImpliedLadder, kalshi: ImpliedLadder): DivergenceProfile {
  if (!poly?.ok || !kalshi?.ok) return EMPTY_DIVERGENCE;
  const gaps: DivergenceProfile['gaps'] = [];
  let maxAbsGap = 0;
  let maxGapAtF = NaN;
  for (let k = GRID_LO_F + 1; k <= GRID_HI_F; k++) {
    const sPoly = survivalAt(poly, k);
    const sKalshi = survivalAt(kalshi, k);
    // only the active range (where at least one venue still has appreciable mass on each side)
    if (sPoly <= 1e-6 && sKalshi <= 1e-6) continue;
    if (sPoly >= 1 - 1e-6 && sKalshi >= 1 - 1e-6) continue;
    const signed = sPoly - sKalshi;
    gaps.push({ k, sPoly, sKalshi, signed });
    if (Math.abs(signed) > maxAbsGap) {
      maxAbsGap = Math.abs(signed);
      maxGapAtF = k;
    }
  }
  return { ok: gaps.length > 0, gaps, maxAbsGap, maxGapAtF, meanDiffF: poly.meanF - kalshi.meanF };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the basis model (the dual-resolution-source friction)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The distribution of δ = (Kalshi-source high) − (Polymarket-source high), in integer °F. Kalshi
 * resolves on NWS CLI (QC'd, includes T-group spikes), Polymarket on Wunderground hourly-obs max; the
 * documented relationship is CLI ≥ WU, occasionally by 1°F (research/REPORT-weather-data.md §d). The
 * default is a CONSERVATIVE prior; `scripts/research/cross-venue-basis.ts` measures the real per-station
 * distribution and emits a refined asset. `pmf` keys are integer δ; values sum to ~1.
 */
export interface BasisModel {
  pmf: Record<number, number>;
}

/** The research prior: CLI = WU 78% of days, +1°F 18%, +2°F 4% (CLI runs ≥ WU). */
export const DEFAULT_BASIS_PRIOR: BasisModel = { pmf: { 0: 0.78, 1: 0.18, 2: 0.04 } };

/**
 * Basis-NEUTRAL (CLI = WU). The v1 LIVE capture uses THIS, not the CLI-hot prior — empirically (the
 * first 6-city panel, 2026-06-25) an unverified CLI-hot prior SYSTEMATICALLY manufactures a
 * buy-Kalshi edge even when the two venues' implied means agree to <1°F: the CLI premium is already in
 * Kalshi's price (cashflow) and re-crediting it in the expected payoff double-counts it. Measuring the
 * PURE price dislocation basis-neutral is the conservative kill-gate stance (won't false-PASS); the
 * REALIZED (CLI − WU) basis from settled outcomes (cross-venue-basis.ts) then refines it, and a
 * basis-driven edge is only believed once the realized basis confirms it.
 */
export const NEUTRAL_BASIS: BasisModel = { pmf: { 0: 1 } };

/**
 * P(the two resolution sources straddle the threshold k) under a market PMF + a basis model: the
 * probability that the Wunderground high w is < k but the NWS-CLI high w+δ is ≥ k (the case that
 * un-hedges a cross-venue position). Conservative: charged as a full $1 loss in the executable edge.
 */
export function basisStraddleProb(marketPmf: number[], basis: BasisModel, k: number): number {
  if (!Array.isArray(marketPmf) || marketPmf.length === 0) return 0;
  const entries = Object.entries(basis?.pmf ?? {})
    .map(([d, p]) => [Number(d), Number(p)] as const)
    .filter(([d, p]) => Number.isFinite(d) && Number.isFinite(p) && p > 0);
  if (entries.length === 0) return 0;
  const kk = Math.ceil(k);
  let prob = 0;
  for (let i = 0; i < marketPmf.length; i++) {
    const w = GRID_LO_F + i;
    const pw = marketPmf[i]!;
    if (pw <= 0 || w >= kk) continue; // w ≥ k → WU already ≥ k → no straddle (δ ≥ 0)
    for (const [d, pd] of entries) {
      if (w + d >= kk) prob += pw * pd; // WU < k ≤ CLI
    }
  }
  return prob;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the executable, basis-adjusted cross-venue edge (the gate input)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Cost (incl. fee) to TAKE the synthetic YES(high ≥ k) on a venue: buy every whole bucket with loF ≥ k. */
function synthBuyCost(impl: ImpliedLadder, k: number, feeRate: number): { cost: number; minSize: number } | null {
  // k must be a clean bucket lower-edge on this venue (k = some bucket's loF), else YES(≥k) is not
  // cleanly constructible here.
  if (!impl.spans.some((s) => s.loF === k)) return null;
  const legs = impl.spans.filter((s) => s.loF >= k);
  // COMPLETE coverage required: every bucket above k must be takeable. A missing ask = a hole in the
  // synthetic; silently dropping it would overstate the hedge (the wrong direction for a kill gate).
  if (legs.length === 0 || legs.some((s) => s.yesAsk == null)) return null;
  let cost = 0;
  let minSize = Infinity;
  for (const s of legs) {
    cost += s.yesAsk! + takerFeePerShare(s.yesAsk!, feeRate);
    minSize = Math.min(minSize, s.topAskSize);
  }
  return { cost, minSize: Number.isFinite(minSize) ? minSize : 0 };
}

/** Proceeds (net of fee) to SELL the synthetic YES(high ≥ k') on a venue: sell every whole bucket loF ≥ k'. */
function synthSellProceeds(impl: ImpliedLadder, k: number, feeRate: number): { proceeds: number; minSize: number; kClean: number } | null {
  // sell YES(≥k') at the LARGEST clean lower-boundary ≤ k that the venue carries (minimises the
  // over-cover stub [k', k)); require COMPLETE bid coverage above k', else try the next-lower boundary.
  const cleanBoundaries = [...new Set(impl.spans.map((s) => s.loF).filter((lo) => lo <= k))].sort((a, b) => b - a);
  for (const kClean of cleanBoundaries) {
    const legs = impl.spans.filter((s) => s.loF >= kClean);
    if (legs.length === 0 || legs.some((s) => s.yesBid == null)) continue;
    let proceeds = 0;
    let minSize = Infinity;
    for (const s of legs) {
      proceeds += s.yesBid! - takerFeePerShare(s.yesBid!, feeRate);
      minSize = Math.min(minSize, s.topBidSize);
    }
    return { proceeds, minSize: Number.isFinite(minSize) ? minSize : 0, kClean };
  }
  return null;
}

/** Survival P(X ≥ k) under a raw PMF array on the grid. */
function survivalOfPmf(pmf: number[], k: number): number {
  const kk = Math.ceil(k);
  if (kk <= GRID_LO_F) return 1;
  if (kk > GRID_HI_F) return 0;
  let s = 0;
  for (let i = kk - GRID_LO_F; i < pmf.length; i++) s += pmf[i]!;
  return s;
}

/** Normalize the basis δ-distribution to weights summing to 1 (δ = Kalshi/CLI high − Polymarket/WU high). */
function basisWeights(basis: BasisModel): Array<readonly [number, number]> {
  const e = Object.entries(basis?.pmf ?? {})
    .map(([d, p]) => [Number(d), Number(p)] as const)
    .filter(([d, p]) => Number.isFinite(d) && Number.isFinite(p) && p > 0);
  const tot = e.reduce((a, [, p]) => a + p, 0);
  return tot > 0 ? e.map(([d, p]) => [d, p / tot] as const) : [[0, 1]];
}

/** P(CLI ≥ k) given the WU-consensus PMF + basis: Σ_δ w(δ)·P(WU ≥ k−δ) (CLI = WU + δ). */
function cliSurvival(wuPmf: number[], weights: Array<readonly [number, number]>, k: number): number {
  let s = 0;
  for (const [d, w] of weights) s += w * survivalOfPmf(wuPmf, k - d);
  return s;
}

/**
 * Build the neutral WU-truth consensus PMF from both venues: average Polymarket's WU-implied PMF with
 * Kalshi's CLI-implied PMF DE-SHIFTED to WU terms (q(w) ∝ Σ_δ w(δ)·kalshiPmf(w+δ)). Neither venue is
 * privileged as "truth", so a genuine dislocation by EITHER venue surfaces as a positive edge (valuing
 * a leg under its own market's PMF is tautologically ≤ 0 — the edge can only come from a shared truth).
 */
function buildWuConsensus(poly: ImpliedLadder, kalshi: ImpliedLadder, weights: Array<readonly [number, number]>): number[] {
  const n = poly.pmf.length;
  const deshifted = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    // kalshi CLI mass at (w+δ) is attributed back to WU value w with weight w(δ)
    for (const [d, w] of weights) {
      const j = i + d;
      if (j >= 0 && j < n) deshifted[i]! += w * kalshi.pmf[j]!;
    }
  }
  const dTot = deshifted.reduce((a, p) => a + p, 0);
  const dNorm = dTot > 0 ? deshifted.map((p) => p / dTot) : deshifted;
  const blend = poly.pmf.map((p, i) => 0.5 * p + 0.5 * dNorm[i]!);
  const bTot = blend.reduce((a, p) => a + p, 0);
  return bTot > 0 ? blend.map((p) => p / bTot) : blend;
}

export interface CrossVenueEdge {
  ok: boolean;
  /**
   * Best net edge per $1 of threshold notional — the MAX over all constructible positions, of EITHER
   * SIGN. (It used to be tracked only when > 0, which silently made every efficient day return a
   * zeroed/no-depth edge and dropped it from the gate — the winners-only-denominator bug. It now
   * reports the real best edge, positive or negative, so efficient days carry their true ≤0 edge.)
   */
  bestNetEdge: number;
  /** The threshold (°F) of the best edge. */
  atF: number;
  /** 'buyPolySellKalshi' = long Polymarket YES(≥k), short Kalshi; or the reverse. */
  direction: 'buyPolySellKalshi' | 'buyKalshiSellPoly' | 'none';
  /** Immediate cashflow (sellProceeds − buyCost, raw bid/ask incl. both taker fees). */
  cashflow: number;
  /** Expected resolution payoff E[long(≥k)] − E[short(≥k')], each under its own source via the consensus. */
  expPayoff: number;
  /** Limiting top-of-book size across the two legs at the best position (informational; mixed units). */
  limitDepth: number;
  /** Polymarket book liquidity = max bucket 24h volume (USD) — the venue-appropriate depth gate input. */
  polyBookDepth: number;
  /** Kalshi book liquidity = max bin open interest (contracts) — the venue-appropriate depth gate input. */
  kalshiBookDepth: number;
  /** Venue we go LONG (buy YES, hit ask) in the best position. */
  buyVenue: VenueName;
  /** Venue we go SHORT (sell YES, hit bid) in the best position. */
  sellVenue: VenueName;
  /**
   * loF of each ladder leg BOUGHT on buyVenue (the cumulative YES≥atF synthetic — hit the ASK), and each
   * leg SOLD on sellVenue (YES≥kClean — hit the BID). The TRUE executable size of the position is the
   * BINDING (min) resting size across ALL these legs, because every one must fill to be hedged — see
   * `bindingExecutable`. The capture (24h-vol/OI) `limitDepth` is only a PROXY; a net-positive day's real
   * executability is decided by walking these legs' order books (CROSS-VENUE-SPIKE.md depth-wall finding).
   */
  buyLegsLoF: number[];
  sellLegsLoF: number[];
}

const EMPTY_EDGE: CrossVenueEdge = {
  ok: false, bestNetEdge: 0, atF: NaN, direction: 'none', cashflow: 0, expPayoff: 0,
  limitDepth: 0, polyBookDepth: 0, kalshiBookDepth: 0,
  buyVenue: 'polymarket', sellVenue: 'kalshi', buyLegsLoF: [], sellLegsLoF: [],
};

/** Max top-of-book size across a ladder's quoted spans — a venue's representative book liquidity. */
function maxBookDepth(impl: ImpliedLadder): number {
  return impl.spans.reduce((m, s) => Math.max(m, Number.isFinite(s.topAskSize) ? s.topAskSize : 0), 0);
}

/**
 * The executable, basis-adjusted cross-venue edge for one matched city-day snapshot. For each integer
 * threshold k that is a clean bucket lower-edge on the BUY venue, in BOTH directions, build the
 * conservative synthetic position and value it under a single neutral consensus truth:
 *
 *   netEdge = [ sellProceeds(short, ≥k') − buyCost(long, ≥k) ]      (immediate cashflow, raw + fees)
 *           + E[long YES(≥k) pays]  −  E[short YES(≥k') owes]        (resolution, under the consensus)
 *
 * Each leg's expected resolution payoff is computed under the source it actually resolves on —
 * Polymarket legs under P(WU≥·), Kalshi legs under P(CLI≥·) = the basis-shifted consensus — so the
 * cashflow's overround is offset by the expected payoff (a single-venue round-trip nets to −spread−fee,
 * never a phantom edge) AND the 1°F bin offset + the dual-resolution basis are both priced correctly.
 * A positive netEdge is therefore a GENUINE cross-venue price dislocation beyond fees, offset, and
 * basis. Returns the best over all thresholds/directions with the limiting top-of-book depth. Pure + total.
 */
export function crossVenueEdge(
  poly: ImpliedLadder,
  kalshi: ImpliedLadder,
  basis: BasisModel = NEUTRAL_BASIS,
): CrossVenueEdge {
  if (!poly?.ok || !kalshi?.ok) return EMPTY_EDGE;
  // Book liquidity is a property of the BOOKS, not the position — compute it independent of edge sign so
  // the depth gate (buildCaptureRow) counts efficient liquid days too, not just winners.
  const polyBookDepth = maxBookDepth(poly);
  const kalshiBookDepth = maxBookDepth(kalshi);
  const weights = basisWeights(basis);
  const wu = buildWuConsensus(poly, kalshi, weights);
  const eOwn = (venue: VenueName, k: number): number =>
    venue === 'polymarket' ? survivalOfPmf(wu, k) : cliSurvival(wu, weights, k);

  // Track the best CONSTRUCTIBLE position by netEdge regardless of sign (bestVal seeded at −Infinity, not 0).
  let best: CrossVenueEdge | null = null;
  let bestVal = Number.NEGATIVE_INFINITY;
  const consider = (
    longV: ImpliedLadder, longRate: number,
    shortV: ImpliedLadder, shortRate: number,
    k: number,
    direction: CrossVenueEdge['direction'],
  ): void => {
    const buy = synthBuyCost(longV, k, longRate);
    if (!buy) return;
    const sell = synthSellProceeds(shortV, k, shortRate);
    if (!sell) return;
    const cashflow = sell.proceeds - buy.cost;
    const expPayoff = eOwn(longV.venue, k) - eOwn(shortV.venue, sell.kClean);
    const netEdge = cashflow + expPayoff;
    if (netEdge > bestVal) {
      bestVal = netEdge;
      best = {
        ok: true, bestNetEdge: netEdge, atF: k, direction, cashflow, expPayoff,
        limitDepth: Math.min(buy.minSize, sell.minSize), polyBookDepth, kalshiBookDepth,
        buyVenue: longV.venue, sellVenue: shortV.venue,
        // the legs that must ALL fill to be hedged — the buy synthetic (loF≥k) and the sell synthetic (loF≥kClean)
        buyLegsLoF: longV.spans.filter((s) => s.loF >= k).map((s) => s.loF),
        sellLegsLoF: shortV.spans.filter((s) => s.loF >= sell.kClean).map((s) => s.loF),
      };
    }
  };

  // candidate thresholds = the union of both venues' clean bucket lower-edges (interleaved by the offset)
  const ks = new Set<number>();
  for (const s of poly.spans) ks.add(s.loF);
  for (const s of kalshi.spans) ks.add(s.loF);
  for (const k of ks) {
    if (k <= GRID_LO_F || k > GRID_HI_F) continue;
    consider(poly, POLY_FEE_RATE, kalshi, KALSHI_FEE_RATE, k, 'buyPolySellKalshi');
    consider(kalshi, KALSHI_FEE_RATE, poly, POLY_FEE_RATE, k, 'buyKalshiSellPoly');
  }
  // best=null ⇒ no constructible position (a degenerate book) ⇒ ok:false, excluded. Book depth carried for telemetry.
  return best ?? { ...EMPTY_EDGE, ok: false, polyBookDepth, kalshiBookDepth };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// true executable depth (the v2 gate input — replaces the 24h-vol/OI proxy for WINS)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Minimum binding executable size for a net-positive cross-venue position to count as a real WIN (not a
 * top-of-book mirage). Units are ≈ $1-face contracts/shares on the THINNER leg (Kalshi contracts and
 * Polymarket shares are both ~$1 binary units; the cross-venue min is approximate across venues, but the
 * live finding — every net-positive city-day executes at 1–10 units — is an order of magnitude below any
 * tradable floor, so the verdict is robust to a 2× unit error). 25 ≈ a token $25 position; if you cannot
 * put on even that, there is no harvestable cross-venue edge. See CROSS-VENUE-SPIKE.md (the capacity wall).
 */
export const MIN_EXEC_SIZE = 25;

/**
 * The TRUE executable size of a cross-venue position: the BINDING (min) resting size across every leg
 * (buy legs hit the ask, sell legs hit the bid) that must fill to be hedged. A single thin or missing
 * leg (size ≤ 0 / non-finite ⇒ cannot construct that side of the cumulative synthetic) caps the whole
 * position at 0. The cumulative YES≥k synthetic is routinely throttled to single-digit size by its thin
 * tail legs even when the modal bin is deep — which is exactly why a quoted edge is not capturable money.
 * Pure + total.
 */
export function bindingExecutable(buyLegSizes: number[], sellLegSizes: number[]): number {
  const all = [...(buyLegSizes ?? []), ...(sellLegSizes ?? [])];
  if (all.length === 0) return 0;
  let m = Number.POSITIVE_INFINITY;
  for (const s of all) {
    if (!Number.isFinite(s) || s <= 0) return 0; // a leg you cannot fill ⇒ no hedged position
    if (s < m) m = s;
  }
  return Number.isFinite(m) ? m : 0;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the panel + the frozen verdict
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One matched city-day observation: the best executable net edge + whether the BOOKS had real depth. */
export interface PanelDay {
  city: string;
  targetDate: string;
  netEdge: number;
  /** Both venues' books pass the liquidity (24h-vol/OI) PROXY — the denominator filter (market exists). */
  hasRealDepth: boolean;
  /**
   * The net-positive position is executable at real touch depth (binding size ≥ MIN_EXEC_SIZE), walked on
   * BOTH order books. A WIN requires this — a quoted edge on a 1-contract touch is not money. Optional:
   * undefined (legacy/untested rows) is treated as executable so the gate is unchanged where unmeasured;
   * the live capture + scan set it explicitly, and an explicit `false` excludes the day from the wins.
   */
  executable?: boolean;
}

/** Min Kalshi bin open interest (contracts) for the Kalshi book to count as tradable. */
export const MIN_KALSHI_OI = 50;
/** Min Polymarket bucket 24h volume (USD) for the Polymarket book to count as tradable. */
export const MIN_POLY_VOL_USD = 100;
/** The frozen win-fraction bar: ≥10% of real-depth city-days must be net-positive. */
export const MIN_WIN_FRAC = 0.10;
/** Minimum real-depth city-day rows before the gate can render a non-INSUFFICIENT verdict. */
export const MIN_PANEL_DAYS = 12;
/** Minimum distinct cities (clusters) — a cross-venue edge must show across cities, not in one. */
export const MIN_CITIES = 4;
/** Minimum distinct target dates — the panel must span real calendar time, not one day's snapshots. */
export const MIN_DISTINCT_DAYS = 5;

/** Two-sided 95% t critical value by degrees of freedom (small-sample; → 1.96 in the tail). */
function tCrit(df: number): number {
  if (df <= 0) return Number.POSITIVE_INFINITY;
  const T: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447,
    7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  };
  if (df <= 10) return T[df]!;
  if (df <= 15) return 2.131;
  if (df <= 20) return 2.086;
  if (df <= 30) return 2.042;
  return 1.96;
}

export type CrossVenueLabel = 'PASS' | 'KILL' | 'INSUFFICIENT_DATA';

export interface CrossVenueVerdict {
  label: CrossVenueLabel;
  /** Real-depth city-day rows evaluated. */
  nDepthDays: number;
  /** Distinct cities (clusters) with real-depth days. */
  nCities: number;
  /** Distinct target dates spanned. */
  nDistinctDays: number;
  /** Fraction of real-depth day-rows with a net-positive executable edge. */
  winFrac: number;
  /** Grand mean of the per-CITY mean net edges + its t-based 95% CI (clustered by city). */
  meanNetEdge: number;
  ciLow: number;
  ciHigh: number;
  reason: string;
}

/**
 * The pre-registered, operator-ratified (2026-06-25) kill criterion. PASS only if a NON-NEGLIGIBLE
 * fraction of matched, real-depth city-days carries a positive executable basis-adjusted edge AND the
 * mean edge is significantly > 0. The significance test is CLUSTERED BY CITY (each city's mean netEdge
 * is ONE observation, t-interval on C−1 df) — the panel's rows share a city's persistent microstructure
 * + per-station CLI-vs-WU basis, so treating same-city / multi-target-date rows as i.i.d. understates
 * the SE and risks a false PASS (a per-city artifact faking significance). INSUFFICIENT_DATA until the
 * panel has enough rows AND enough distinct cities AND spans enough distinct target dates (≥1 calendar
 * day of 6-city snapshots is NOT a week). Anything else with enough data is a KILL (the 10th falsified
 * signal — the same structural-wall destination as the 8th). Pure + total.
 */
export function crossVenueVerdict(
  panel: PanelDay[],
  opts: { minWinFrac?: number; minDays?: number; minCities?: number; minDistinctDays?: number } = {},
): CrossVenueVerdict {
  const minWinFrac = opts.minWinFrac ?? MIN_WIN_FRAC;
  const minDays = opts.minDays ?? MIN_PANEL_DAYS;
  const minCities = opts.minCities ?? MIN_CITIES;
  const minDistinctDays = opts.minDistinctDays ?? MIN_DISTINCT_DAYS;
  const rows = (Array.isArray(panel) ? panel : []).filter(
    (d) => d && Number.isFinite(d.netEdge) && d.hasRealDepth === true,
  );
  const n = rows.length;
  const cities = [...new Set(rows.map((d) => d.city))];
  const nDistinctDays = new Set(rows.map((d) => d.targetDate)).size;
  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
  const usd = (v: number): string => `$${v.toFixed(4)}`;
  const base = { nDepthDays: n, nCities: cities.length, nDistinctDays };

  if (n < minDays || cities.length < minCities || nDistinctDays < minDistinctDays) {
    return {
      label: 'INSUFFICIENT_DATA', ...base, winFrac: NaN, meanNetEdge: NaN, ciLow: NaN, ciHigh: NaN,
      reason:
        `INSUFFICIENT_DATA — ${n} real-depth city-days across ${cities.length} cities / ${nDistinctDays} distinct dates ` +
        `(need ≥ ${minDays} rows, ≥ ${minCities} cities, ≥ ${minDistinctDays} dates). Keep capturing.`,
    };
  }

  // win fraction over day-rows (the ≥10% bar). A WIN is a net-positive edge that is ALSO executable at
  // real touch depth — a quoted edge on a 1-contract book is a mirage (CROSS-VENUE-SPIKE.md capacity
  // wall). `executable !== false` keeps legacy/unmeasured rows counted; the live path sets it explicitly.
  const wins = rows.filter((d) => d.netEdge > 0 && d.executable !== false).length;
  const winFrac = wins / n;

  // significance CLUSTERED BY CITY: each city's mean netEdge is one observation
  const cityMeans = cities.map((c) => {
    const cr = rows.filter((d) => d.city === c);
    return cr.reduce((a, d) => a + d.netEdge, 0) / cr.length;
  });
  const C = cityMeans.length;
  const mean = cityMeans.reduce((a, v) => a + v, 0) / C;
  const variance = C > 1 ? cityMeans.reduce((a, v) => a + (v - mean) ** 2, 0) / (C - 1) : 0;
  const se = Math.sqrt(variance / C);
  const t = tCrit(C - 1);
  const ciLow = mean - t * se;
  const ciHigh = mean + t * se;

  if (winFrac >= minWinFrac && ciLow > 0) {
    return {
      label: 'PASS', ...base, winFrac, meanNetEdge: mean, ciLow, ciHigh,
      reason:
        `PASS — ${pct(winFrac)} of ${n} real-depth city-days net-positive AND EXECUTABLE at touch depth ` +
        `(≥ ${pct(minWinFrac)} bar) AND the city-clustered mean edge ${usd(mean)} has a 95% CI ` +
        `[${usd(ciLow)}, ${usd(ciHigh)}] (t, ${C} cities) excluding 0. A standing, executable cross-venue ` +
        `dislocation beyond fees + offset + basis. Escalate to an executor design + a true depth-walk.`,
    };
  }
  return {
    label: 'KILL', ...base, winFrac, meanNetEdge: mean, ciLow, ciHigh,
    reason:
      `KILL (10th signal) — ${pct(winFrac)} of ${n} real-depth city-days net-positive AND executable ` +
      `(vs ${pct(minWinFrac)} bar); city-clustered mean edge ${usd(mean)}, 95% CI [${usd(ciLow)}, ${usd(ciHigh)}] ` +
      `(t, ${C} cities). The cross-venue price difference does not clear the combined fee + the 1°F bin-offset ` +
      `stub + the NWS-CLI-vs-Wunderground basis AT EXECUTABLE TOUCH DEPTH (the quoted gap exists but the ` +
      `cumulative synthetic throttles to single-digit size on its thin legs). Structurally walled like the ` +
      `complete-set arb. Rail stays DORMANT.`,
  };
}
