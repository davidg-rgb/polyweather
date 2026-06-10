/**
 * core/distributions/ensemble — ensemble stats & dressed empirical distribution
 * (ARCHITECTURE.md §6.5).
 */
import { bucketRange } from '../buckets.ts';
import { DistributionError } from '../errors.ts';
import type { BucketDef, ForecastPoint } from '../types.ts';
import { normCdf, renormalize } from './gaussian.ts';

/**
 * Weighted mean of bias-corrected model points + their weighted std-dev.
 * DIAGNOSTIC ONLY — σ for the Gaussian comes from calibration residuals, NOT
 * this spread (underdispersion guard). Models with weight 0 or missing from
 * the weight map are excluded; no effective points → { NaN, NaN, n: 0 }.
 */
export function ensembleStats(
  points: ForecastPoint[],
  weights: Map<string, number>,
): { mu: number; spreadStd: number; n: number } {
  const effective = points
    .map((p) => ({ value: p.value, w: weights.get(p.model) ?? 0 }))
    .filter((p) => p.w > 0);
  if (effective.length === 0) {
    return { mu: NaN, spreadStd: NaN, n: 0 };
  }
  const wSum = effective.reduce((a, p) => a + p.w, 0);
  const mu = effective.reduce((a, p) => a + p.w * p.value, 0) / wSum;
  const variance = effective.reduce((a, p) => a + p.w * (p.value - mu) ** 2, 0) / wSum;
  return { mu, spreadStd: Math.sqrt(variance), n: effective.length };
}

/**
 * Challenger method: each ensemble member contributes a Gaussian kernel
 * N(member, residualSigma); bucket prob = mean over members of the kernel
 * mass in the bucket. DistributionError if members < 20 (don't pretend 5
 * points are a distribution) or σ ≤ 0.2 (same degenerate-σ floor as §6.5's
 * Gaussian path — kernels with collapsed width are equally overconfident).
 */
export function dressedEnsembleProbs(
  membersNative: number[],
  residualSigma: number,
  buckets: BucketDef[],
): number[] {
  if (membersNative.length < 20) {
    throw new DistributionError(
      `ensemble has ${membersNative.length} members < 20 — refusing to dress`,
      { nMembers: membersNative.length },
    );
  }
  if (residualSigma <= 0.2) {
    throw new DistributionError(`degenerate kernel sigma ${residualSigma} ≤ 0.2`, { residualSigma });
  }
  const probs = buckets.map((b) => {
    const { lo, hi } = bucketRange(b);
    let acc = 0;
    for (const m of membersNative) {
      const upper = hi === Infinity ? 1 : normCdf((hi - m) / residualSigma);
      const lower = lo === -Infinity ? 0 : normCdf((lo - m) / residualSigma);
      acc += Math.max(0, upper - lower);
    }
    return acc / membersNative.length;
  });
  return renormalize(probs);
}
