/**
 * core/sim/stats — small, pure, reproducible confidence-interval helpers for the
 * Amsterdam model-vs-market analytics (AMSTERDAM-EV-MODEL.md Deliverable 1 + 2).
 *
 * Three estimators, one per signal, each chosen for its sample's shape:
 *   - wilsonInterval  → a binomial PROPORTION (our exact-bucket hit rate). The Wilson
 *     score interval is small-n safe and never escapes [0,1] (unlike normal ±1.96·se,
 *     which gives nonsense bounds at the low n the live sim starts with).
 *   - meanConfidenceInterval → the PAIRED hit−ask gap (won − ask per bet). Low variance
 *     (each term is in [−1,1]), so the closed-form mean ± z·SE is honest and cheap — this
 *     is the headline metric (the handoff: "edge (hit−ask) is the primary metric").
 *   - bootstrapMeanCi → EV/$1 (won ? 1/ask−1 : −1). HEAVY-TAILED: one 0.05-ask win is
 *     +19, a loss is −1, so the analytic SE is unreliable; a seeded percentile bootstrap
 *     gives a faithful interval. mulberry32 seeds it → byte-identical across runs (the
 *     same reproducibility contract as pairedBootstrapPValue).
 *
 * All functions are total: an empty sample returns NaN bounds (JSON-serialises to null →
 * the dashboard renders "—"); a single observation returns a degenerate CI at the point
 * (SE 0 / no bootstrap spread) rather than throwing. Callers gate on n for credibility.
 */
import { mulberry32 } from '../calibration/scores.ts';

/** Default two-sided 95% normal critical value. */
export const Z_95 = 1.959963984540054;

export interface Interval {
  lo: number;
  hi: number;
}

export interface MeanCi extends Interval {
  mean: number;
  /** Standard error of the mean (sample SD / √n); 0 for n ≤ 1. */
  se: number;
  n: number;
}

export interface BootstrapCi extends Interval {
  mean: number;
  n: number;
}

/**
 * Wilson score interval for a binomial proportion — the small-n-safe CI for a hit rate.
 * Centred on the shrunk estimate (phat pulled toward 0.5 by z²/n), bounds clamped to
 * [0,1]. n = 0 → the maximally-uncertain [0,1] (no evidence). z defaults to 95%.
 */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): Interval {
  if (n <= 0) return { lo: 0, hi: 1 };
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

/**
 * Mean ± z·SE of the sample mean (SE = sample SD / √n, Bessel-corrected). The right CI for
 * a low-variance paired series like (won − ask). n = 0 → NaN bounds; n = 1 → a degenerate
 * CI at the point (SE 0 — one observation has no spread, not infinite spread).
 */
export function meanConfidenceInterval(values: number[], z: number = Z_95): MeanCi {
  const n = values.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, se: NaN, n: 0 };
  const mean = values.reduce((a, v) => a + v, 0) / n;
  if (n === 1) return { mean, lo: mean, hi: mean, se: 0, n };
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  return { mean, lo: mean - z * se, hi: mean + z * se, se, n };
}

/** Type-7 (linear-interpolation) quantile of an already-ascending array. */
export function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0]!;
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - pos) + sorted[hi]! * (pos - lo);
}

/**
 * Percentile bootstrap CI for the mean of a heavy-tailed sample (EV/$1 per bet). Resamples
 * with replacement `iters` times (default 2000), takes the central (1−alpha) band of the
 * resample means. Seeded with mulberry32 (default 42) so the interval is reproducible run
 * to run — the same contract as the go-live gate's pairedBootstrapPValue. n = 0 → NaN
 * bounds; n = 1 → a degenerate CI at the point.
 */
export function bootstrapMeanCi(
  values: number[],
  opts: { iters?: number; seed?: number; alpha?: number } = {},
): BootstrapCi {
  const n = values.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const mean = values.reduce((a, v) => a + v, 0) / n;
  if (n === 1) return { mean, lo: mean, hi: mean, n };
  const iters = opts.iters ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rand = mulberry32(opts.seed ?? 42);
  const means = new Array<number>(iters);
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[Math.floor(rand() * n)]!;
    means[i] = sum / n;
  }
  means.sort((a, b) => a - b);
  return { mean, lo: quantileSorted(means, alpha / 2), hi: quantileSorted(means, 1 - alpha / 2), n };
}

// --- floor "truth accuracy" stats: forecast skill vs the true decimal high, separate from the market ---

/** One bet reduced to its floor-truth outcome + decimal signed error (from core/sim/amsterdam planTruth). */
export interface TruthBet {
  /** predicted whole °C === floor(decimal actual). */
  truthWon: boolean;
  /** Continuous nowcast basis − decimal actual (°C); the per-bet signed forecast error. */
  signedErrorC: number;
}

/** The per-arm floor-truth bundle the dashboard renders alongside (but separate from) the market edge. */
export interface ArmTruthStats {
  nTruth: number;
  nTruthWon: number;
  /** Fraction of bets whose whole-°C call equals floor(decimal actual). NaN when nTruth = 0. */
  truthHitRate: number;
  truthHitCiLo: number;
  truthHitCiHi: number;
  /** Mean absolute signed error (°C) — the arm's nowcast MAE at decimal resolution. */
  mae: number;
  /** Mean signed error (°C); positive = the nowcast ran hot. The Δ on it is mean ± z·SE. */
  bias: number;
  biasCiLo: number;
  biasCiHi: number;
}

/**
 * Reduce a set of truth-resolved bets to the floor-hit rate (Wilson CI), the decimal MAE, and the signed
 * bias (mean ± z·SE) — the one place these are wired, so the dashboard loader and the backtest score
 * identically. Rows with a non-finite signed error are dropped. nTruth = 0 → an all-NaN/empty bundle.
 */
export function armTruthStats(rows: TruthBet[]): ArmTruthStats {
  const usable = rows.filter((r) => Number.isFinite(r.signedErrorC));
  const nTruth = usable.length;
  const nTruthWon = usable.filter((r) => r.truthWon).length;
  const hit = wilsonInterval(nTruthWon, nTruth);
  const bias = meanConfidenceInterval(usable.map((r) => r.signedErrorC));
  const mae = nTruth === 0 ? NaN : usable.reduce((a, r) => a + Math.abs(r.signedErrorC), 0) / nTruth;
  return {
    nTruth,
    nTruthWon,
    truthHitRate: nTruth === 0 ? NaN : nTruthWon / nTruth,
    truthHitCiLo: hit.lo,
    truthHitCiHi: hit.hi,
    mae,
    bias: bias.mean,
    biasCiLo: bias.lo,
    biasCiHi: bias.hi,
  };
}

/** One graded paper bet reduced to the two fields every estimator above needs. */
export interface GradedBet {
  won: boolean;
  /** Recorded market ask on our predicted bucket at placement, in (0,1]. */
  ask: number;
}

/** The full per-arm (or per-grid-point) CI bundle the dashboard + the best-buy curve render. */
export interface ArmEdgeStats {
  nGraded: number;
  nWon: number;
  hitRate: number;
  hitCiLo: number;
  hitCiHi: number;
  avgAsk: number;
  /** Mean paired gap (won − ask) — the low-variance headline edge. */
  edge: number;
  edgeCiLo: number;
  edgeCiHi: number;
  /** Mean realised EV per $1 staked, fee-free (won ? 1/ask−1 : −1). */
  ev: number;
  evCiLo: number;
  evCiHi: number;
}

/**
 * Reduce a set of graded bets to the hit/edge/EV point estimates and their CIs — the one
 * place the three estimators are wired to the (won, ask) data, so the dashboard loader and
 * the best-buy backtest score identically. Bets with an unusable ask (≤ 0 or > 1) are
 * dropped (they could never have been placed). nGraded = 0 → an all-NaN bundle.
 */
export function armEdgeStats(bets: GradedBet[], opts: { bootstrapSeed?: number } = {}): ArmEdgeStats {
  const usable = bets.filter((b) => Number.isFinite(b.ask) && b.ask > 0 && b.ask <= 1);
  const nGraded = usable.length;
  const nWon = usable.filter((b) => b.won).length;
  const hit = wilsonInterval(nWon, nGraded);
  const gap = meanConfidenceInterval(usable.map((b) => (b.won ? 1 : 0) - b.ask));
  const ev = bootstrapMeanCi(
    usable.map((b) => (b.won ? 1 / b.ask - 1 : -1)),
    { seed: opts.bootstrapSeed },
  );
  const avgAsk = nGraded === 0 ? NaN : usable.reduce((a, b) => a + b.ask, 0) / nGraded;
  return {
    nGraded,
    nWon,
    hitRate: nGraded === 0 ? NaN : nWon / nGraded,
    hitCiLo: hit.lo,
    hitCiHi: hit.hi,
    avgAsk,
    edge: gap.mean,
    edgeCiLo: gap.lo,
    edgeCiHi: gap.hi,
    ev: ev.mean,
    evCiLo: ev.lo,
    evCiHi: ev.hi,
  };
}
