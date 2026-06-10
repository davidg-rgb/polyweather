/**
 * core/distributions/nowcast — running-max constraint (ARCHITECTURE.md §6.5, ADR-15).
 */
import { bucketRange } from '../buckets.ts';
import type { BucketDef } from '../types.ts';
import { renormalize } from './gaussian.ts';

/** Empirical remaining-lift quantiles (§7.8a), in NATIVE degrees — the caller converts the °C table values for °F ladders. */
export interface LiftQuantiles {
  p50: number;
  p90: number;
}

/**
 * P(remaining lift ≤ h) from the two stored quantiles: piecewise-linear CDF
 * through (p50, 0.5) and (p90, 0.9), clamped to [0, 1]. Degenerate p50 = p90
 * collapses to a step at that value. This is the documented interpolation
 * behind the §6.5 "partial-bucket lift" — two quantiles are all §7.8a stores.
 */
function liftCdf(h: number, lift: LiftQuantiles): number {
  const { p50, p90 } = lift;
  if (p90 <= p50) return h >= p50 ? 1 : 0;
  const slope = 0.4 / (p90 - p50);
  return Math.min(1, Math.max(0, 0.5 + slope * (h - p50)));
}

/**
 * Constrain a distribution by the observed intraday running max:
 *  - buckets with range hi < runningMaxNative are physically eliminated (zeroed);
 *  - the bucket CONTAINING the running max keeps only its "day ends in this
 *    bucket" share — P(remaining lift ≤ headroom) from the lift quantiles when
 *    provided (truncation-only when absent, §7.8a missing-row rule);
 *  - renormalized to Σ=1.
 *
 * Top-tail edge case: the open top tail (hi = +∞) can never be eliminated —
 * when runningMax exceeds every closed bucket the result is [0,…,0,1] on the
 * tail, NOT "unchanged". (An unchanged-with-warning return is reachable only
 * on a ladder with no open tail, which validateLadder rejects upstream.)
 */
export function applyRunningMaxConstraint(
  probs: number[],
  buckets: BucketDef[],
  runningMaxNative: number,
  lift?: LiftQuantiles,
): number[] {
  const constrained = probs.map((p, i) => {
    const { lo, hi } = bucketRange(buckets[i]!);
    if (hi < runningMaxNative) return 0; // below the observed max — eliminated
    if (lift && runningMaxNative > lo && runningMaxNative < hi) {
      // Bucket containing the running max: scale by the probability that the
      // remaining lift keeps the final max inside this bucket.
      return p * liftCdf(hi - runningMaxNative, lift);
    }
    return p;
  });

  // Physical certainty beats the prior: if the prior put ~no mass on the
  // surviving buckets (e.g. runningMax blew past every closed bucket and the
  // model gave the open tail 0), the constraint still forces the mass onto
  // the non-eliminated buckets — uniformly, since the prior carries no signal
  // there. The open top tail can never be eliminated, so survivors ≥ 1.
  if (constrained.reduce((a, b) => a + b, 0) <= 0) {
    const survivors = buckets
      .map((b, i) => ({ i, hi: bucketRange(b).hi }))
      .filter(({ hi }) => hi >= runningMaxNative)
      .map(({ i }) => i);
    const out = probs.map(() => 0);
    for (const i of survivors) out[i] = 1 / survivors.length;
    return out;
  }

  return renormalize(constrained);
}
