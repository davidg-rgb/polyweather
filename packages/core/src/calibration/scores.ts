/**
 * core/calibration/scores — Brier, ECE, reliability, sharpness, paired
 * bootstrap (ARCHITECTURE.md §6.6).
 */

/** One reliability-diagram bin (persisted to calibration_scores.reliability jsonb). */
export interface ReliabilityBin {
  lo: number;
  hi: number;
  meanQ: number;
  hitRate: number;
  n: number;
}

export interface Prediction {
  q: number;
  hit: boolean;
}

/** Multi-category Brier: Σ (qᵢ − oᵢ)² over the ladder — 0 perfect, 2 worst. */
export function brierScore(probs: number[], outcomeIdx: number): number {
  return probs.reduce((acc, q, i) => acc + (q - (i === outcomeIdx ? 1 : 0)) ** 2, 0);
}

/**
 * Reliability-diagram data: predictions binned by q into `bins` equal-width
 * probability bins over [0,1] (q=1 lands in the top bin). Only non-empty bins
 * are returned — each carries its n; empty bins would serialize as NaN points.
 */
export function reliabilityBins(preds: Prediction[], bins: number): ReliabilityBin[] {
  const out: ReliabilityBin[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = preds.filter((p) => (p.q >= lo && p.q < hi) || (b === bins - 1 && p.q === 1));
    if (inBin.length === 0) continue;
    out.push({
      lo,
      hi,
      meanQ: inBin.reduce((a, p) => a + p.q, 0) / inBin.length,
      hitRate: inBin.filter((p) => p.hit).length / inBin.length,
      n: inBin.length,
    });
  }
  return out;
}

/** Weighted |mean-predicted − empirical-hit-rate| over probability bins (default 10). */
export function expectedCalibrationError(preds: Prediction[], bins: number = 10): number {
  if (preds.length === 0) return 0;
  return reliabilityBins(preds, bins).reduce(
    (acc, bin) => acc + (bin.n / preds.length) * Math.abs(bin.meanQ - bin.hitRate),
    0,
  );
}

/** Mean max-bucket probability — "calibrated but vague" vs "calibrated and sharp". */
export function sharpness(probsRows: number[][]): number {
  if (probsRows.length === 0) return 0;
  return probsRows.reduce((a, row) => a + Math.max(...row), 0) / probsRows.length;
}

/** mulberry32 — the seeded RNG behind reproducible gate decisions (exported for tests/simulation). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One-sided paired bootstrap on per-event Brier differences (house − market):
 * resample with replacement `iters` times; p = fraction of resample means ≥ 0.
 * Seeded RNG (mulberry32) for reproducible gate decisions — the statistical
 * teeth of the go-live gate (C5: the 0.95× point threshold alone passes on
 * pure noise ≈30% of the time). Returns 1.0 when diffs.length < 30 —
 * insufficient evidence is a failing gate, not an error.
 */
export function pairedBootstrapPValue(diffs: number[], iters: number = 2000, seed: number = 42): number {
  const n = diffs.length;
  if (n < 30) return 1.0;
  const rand = mulberry32(seed);
  let atOrAbove = 0;
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += diffs[Math.floor(rand() * n)]!;
    }
    if (sum / n >= 0) atOrAbove++;
  }
  return atOrAbove / iters;
}
