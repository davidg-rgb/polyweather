/**
 * core/distributions/gaussian — Φ and Gaussian bucketization (ARCHITECTURE.md §6.5).
 *
 * Every method maps inputs → number[] aligned to the event's bucket ladder,
 * summing to 1 ± 1e-9. Pure; persistence happens in §6.16.
 */
import { bucketRange } from '../buckets.ts';
import { DistributionError } from '../errors.ts';
import type { BucketDef } from '../types.ts';

// Abramowitz–Stegun 7.1.26 erf coefficients.
const P = 0.3275911;
const A1 = 0.254829592;
const A2 = -0.284496736;
const A3 = 1.421413741;
const A4 = -1.453152027;
const A5 = 1.061405429;

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + P * ax);
  const poly = ((((A5 * t + A4) * t + A3) * t + A2) * t + A1) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/**
 * Standard normal Φ via the A&S 7.1.26 erf approximation — |ε| < 7.5e-8,
 * three orders below any betting-relevant threshold; no dependency.
 */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Σ=1 renormalization shared by every distribution builder. */
export function renormalize(probs: number[]): number[] {
  const sum = probs.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    throw new DistributionError('cannot renormalize: total mass is 0', { probs });
  }
  return probs.map((p) => p / sum);
}

/**
 * P(b) = Φ((hi−μ)/σ) − Φ((lo−μ)/σ) per bucketRange; tails absorb the open
 * mass; renormalized. DistributionError if σ ≤ 0.2 — a degenerate σ means a
 * calibration bug upstream; refuse to emit overconfident probabilities.
 */
export function gaussianBucketProbs(
  muNative: number,
  sigmaNative: number,
  buckets: BucketDef[],
): number[] {
  if (sigmaNative <= 0.2) {
    throw new DistributionError(`degenerate sigma ${sigmaNative} ≤ 0.2 — refusing to bucketize`, {
      muNative,
      sigmaNative,
    });
  }
  const probs = buckets.map((b) => {
    const { lo, hi } = bucketRange(b);
    const upper = hi === Infinity ? 1 : normCdf((hi - muNative) / sigmaNative);
    const lower = lo === -Infinity ? 0 : normCdf((lo - muNative) / sigmaNative);
    return Math.max(0, upper - lower);
  });
  return renormalize(probs);
}
