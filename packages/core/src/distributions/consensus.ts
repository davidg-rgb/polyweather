/**
 * core/distributions/consensus — market-implied distribution (ARCHITECTURE.md §6.5).
 */

/**
 * Market-consensus benchmark from bucket midpoints: clamp mids to
 * [0.001, 0.999], renormalize to Σ=1. 1–2 missing mids (e.g. a null-bid tail,
 * observed live on NYC's top tail) are floored at 0.001 before renormalizing.
 * Returns null if >2 buckets lack a mid — too sparse to be a benchmark.
 */
export function impliedDistribution(mids: (number | null)[]): number[] | null {
  const missing = mids.filter((m) => m === null || !Number.isFinite(m)).length;
  if (missing > 2) return null;

  const clamped = mids.map((m) =>
    m === null || !Number.isFinite(m) ? 0.001 : Math.min(0.999, Math.max(0.001, m)),
  );
  const sum = clamped.reduce((a, b) => a + b, 0);
  return clamped.map((p) => p / sum);
}
