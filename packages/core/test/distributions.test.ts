import { describe, expect, it } from 'vitest';
import { impliedDistribution } from '../src/distributions/consensus.ts';
import { dressedEnsembleProbs, ensembleStats } from '../src/distributions/ensemble.ts';
import { gaussianBucketProbs, normCdf } from '../src/distributions/gaussian.ts';
import { applyRunningMaxConstraint } from '../src/distributions/nowcast.ts';
import { DistributionError } from '../src/errors.ts';
import type { BucketDef } from '../src/types.ts';

const F = (low: number | null, high: number | null): BucketDef => ({ low, high, unit: 'F' });
const C = (low: number | null, high: number | null): BucketDef => ({ low, high, unit: 'C' });

/** NYC-style 2°F ladder. */
const fLadder: BucketDef[] = [
  F(null, 87), F(88, 89), F(90, 91), F(92, 93), F(94, 95),
  F(96, 97), F(98, 99), F(100, 101), F(102, 103), F(104, 105), F(106, null),
];

/** London-style 1°C ladder. */
const cLadder: BucketDef[] = [
  C(null, 9), C(10, 10), C(11, 11), C(12, 12), C(13, 13), C(14, 14),
  C(15, 15), C(16, 16), C(17, 17), C(18, 18), C(19, null),
];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('normCdf (§6.5)', () => {
  // High-precision reference values for Φ.
  const refs: Array<[number, number]> = [
    [0, 0.5],
    [0.5, 0.6914624612740131],
    [1, 0.8413447460685429],
    [-1, 0.15865525393145707],
    [1.96, 0.9750021048517795],
    [2, 0.9772498680518208],
    [-2.5, 0.006209665325776132],
    [3, 0.9986501019683699],
    [-3.5, 0.00023262907903552502],
  ];

  it.each(refs)('Φ(%f) within 1e-7 of reference', (x, ref) => {
    expect(Math.abs(normCdf(x) - ref)).toBeLessThan(1e-7);
  });

  it('is symmetric: Φ(x) + Φ(−x) = 1', () => {
    for (const x of [0.3, 1.1, 2.7]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 9);
    }
  });
});

describe('gaussianBucketProbs (§6.5)', () => {
  it('sums to 1 ± 1e-9 on both ladders', () => {
    expect(Math.abs(sum(gaussianBucketProbs(93, 2, fLadder)) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(sum(gaussianBucketProbs(15, 1.2, cLadder)) - 1)).toBeLessThan(1e-9);
  });

  it('°F 2° ladder: bucket mass matches direct Φ computation', () => {
    const probs = gaussianBucketProbs(93, 2, fLadder);
    // '92-93°F' = [91.5, 93.5): Φ(0.25) − Φ(−0.75)
    const expected = normCdf((93.5 - 93) / 2) - normCdf((91.5 - 93) / 2);
    expect(probs[3]).toBeCloseTo(expected, 9);
    expect(probs[3]).toBeCloseTo(0.372078973, 6);
  });

  it('°C 1° ladder: bucket mass matches direct Φ computation', () => {
    const probs = gaussianBucketProbs(15, 1, cLadder);
    // '15°C' = [14.5, 15.5): Φ(0.5) − Φ(−0.5)
    expect(probs[6]).toBeCloseTo(0.3829249225480262, 6);
  });

  it('tails absorb the open mass', () => {
    const probs = gaussianBucketProbs(80, 3, fLadder); // μ far below the ladder
    expect(probs[0]).toBeGreaterThan(0.99);
  });

  it('mass shifts with μ', () => {
    const at93 = gaussianBucketProbs(93, 2, fLadder);
    const at97 = gaussianBucketProbs(97, 2, fLadder);
    expect(at97[5]).toBeGreaterThan(at93[5]!); // '96-97°F' gains
    expect(at97.indexOf(Math.max(...at97))).toBeGreaterThan(at93.indexOf(Math.max(...at93)));
  });

  it('DistributionError at σ ≤ 0.2', () => {
    expect(() => gaussianBucketProbs(93, 0.2, fLadder)).toThrow(DistributionError);
    expect(() => gaussianBucketProbs(93, 0, fLadder)).toThrow(DistributionError);
    expect(() => gaussianBucketProbs(93, -1, fLadder)).toThrow(DistributionError);
  });
});

describe('ensembleStats (§6.5)', () => {
  it('weighted mean and std; zero-weight models excluded', () => {
    const points = [
      { model: 'ecmwf_ifs025', value: 10 },
      { model: 'gfs_seamless', value: 20 },
      { model: 'icon_seamless', value: 1000 }, // weight 0 — must not move the stats
    ];
    const weights = new Map([
      ['ecmwf_ifs025', 0.5],
      ['gfs_seamless', 0.5],
      ['icon_seamless', 0],
    ]);
    const stats = ensembleStats(points, weights);
    expect(stats.mu).toBe(15);
    expect(stats.spreadStd).toBe(5);
    expect(stats.n).toBe(2);
  });

  it('models missing from the weight map are excluded', () => {
    const stats = ensembleStats(
      [{ model: 'known', value: 7 }, { model: 'unknown', value: 99 }],
      new Map([['known', 1]]),
    );
    expect(stats.mu).toBe(7);
    expect(stats.n).toBe(1);
  });

  it('unequal weights pull the mean', () => {
    const stats = ensembleStats(
      [{ model: 'a', value: 0 }, { model: 'b', value: 10 }],
      new Map([['a', 3], ['b', 1]]),
    );
    expect(stats.mu).toBe(2.5);
  });

  it('no effective points → n 0 with NaN stats', () => {
    const stats = ensembleStats([{ model: 'a', value: 5 }], new Map([['a', 0]]));
    expect(stats.n).toBe(0);
    expect(Number.isNaN(stats.mu)).toBe(true);
  });
});

describe('dressedEnsembleProbs (§6.5)', () => {
  it('refuses < 20 members', () => {
    const members = Array.from({ length: 19 }, () => 15);
    expect(() => dressedEnsembleProbs(members, 1.5, cLadder)).toThrow(DistributionError);
  });

  it('reduces to gaussianBucketProbs for identical members', () => {
    const members = Array.from({ length: 30 }, () => 15);
    const dressed = dressedEnsembleProbs(members, 1.5, cLadder);
    const gauss = gaussianBucketProbs(15, 1.5, cLadder);
    dressed.forEach((p, i) => expect(p).toBeCloseTo(gauss[i]!, 12));
  });

  it('spread members produce Σ=1 and a wider distribution than any single kernel', () => {
    const members = Array.from({ length: 40 }, (_, i) => 12 + (i % 8)); // 12..19
    const probs = dressedEnsembleProbs(members, 1.0, cLadder);
    expect(Math.abs(sum(probs) - 1)).toBeLessThan(1e-9);
    const single = gaussianBucketProbs(15.5, 1.0, cLadder);
    expect(Math.max(...probs)).toBeLessThan(Math.max(...single));
  });

  it('refuses a degenerate kernel σ', () => {
    const members = Array.from({ length: 30 }, () => 15);
    expect(() => dressedEnsembleProbs(members, 0.1, cLadder)).toThrow(DistributionError);
  });
});

describe('impliedDistribution (§6.5)', () => {
  it('normalizes mids to Σ=1', () => {
    const probs = impliedDistribution([0.2, 0.2, 0.2]);
    expect(probs).not.toBeNull();
    expect(probs!.every((p) => Math.abs(p - 1 / 3) < 1e-12)).toBe(true);
  });

  it('null when >2 mids are missing', () => {
    expect(impliedDistribution([null, null, null, 0.5, 0.5])).toBeNull();
  });

  it('floors 1–2 missing mids at 0.001 (live-observed null-bid tail case)', () => {
    const probs = impliedDistribution([null, 0.5, 0.499]);
    expect(probs).not.toBeNull();
    expect(probs![0]).toBeCloseTo(0.001, 9);
    expect(Math.abs(sum(probs!) - 1)).toBeLessThan(1e-12);
  });

  it('clamps degenerate quotes into [0.001, 0.999]', () => {
    const probs = impliedDistribution([1.2, -0.1, 0.5])!;
    const raw = [0.999, 0.001, 0.5];
    const rawSum = sum(raw);
    probs.forEach((p, i) => expect(p).toBeCloseTo(raw[i]! / rawSum, 12));
  });
});

describe('applyRunningMaxConstraint (§6.5, ADR-15)', () => {
  const ladder: BucketDef[] = [F(null, 87), F(88, 89), F(90, 91), F(92, 93), F(94, null)];
  const probs = [0.1, 0.2, 0.3, 0.3, 0.1];

  it('zeroes eliminated buckets and renormalizes (truncation-only without lift)', () => {
    const out = applyRunningMaxConstraint(probs, ladder, 90);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(0.3 / 0.7, 12);
    expect(out[3]).toBeCloseTo(0.3 / 0.7, 12);
    expect(out[4]).toBeCloseTo(0.1 / 0.7, 12);
    expect(Math.abs(sum(out) - 1)).toBeLessThan(1e-9);
  });

  it('top-tail edge case: runningMax above every closed bucket → [0,…,0,1], mass stays 1', () => {
    const out = applyRunningMaxConstraint(probs, ladder, 99);
    expect(out).toEqual([0, 0, 0, 0, 1]);
  });

  it('top tail wins even when the prior gave it zero mass (physical certainty beats prior)', () => {
    const out = applyRunningMaxConstraint([0.5, 0.5, 0, 0, 0], ladder, 99);
    expect(out).toEqual([0, 0, 0, 0, 1]);
  });

  it('applies the partial-bucket lift to the containing bucket when the table is provided', () => {
    // runningMax 91 sits in '90-91' (range [89.5, 91.5)); headroom = 0.5.
    // liftCdf(0.5, {p50:0, p90:2}) = 0.5 + (0.4/2)·0.5 = 0.6
    const out = applyRunningMaxConstraint(probs, ladder, 91, { p50: 0, p90: 2 });
    const constrained = [0, 0, 0.3 * 0.6, 0.3, 0.1];
    const total = sum(constrained);
    out.forEach((p, i) => expect(p).toBeCloseTo(constrained[i]! / total, 12));
  });

  it('lift shrinks the containing bucket vs truncation-only', () => {
    const withLift = applyRunningMaxConstraint(probs, ladder, 91, { p50: 0.5, p90: 3 });
    const without = applyRunningMaxConstraint(probs, ladder, 91);
    expect(withLift[2]).toBeLessThan(without[2]!);
  });

  it('degenerate p50=p90 lift acts as a step CDF', () => {
    // headroom 0.5 < step at 1 → containing bucket fully drained
    const out = applyRunningMaxConstraint(probs, ladder, 91, { p50: 1, p90: 1 });
    expect(out[2]).toBe(0);
    expect(out[3]).toBeCloseTo(0.3 / 0.4, 12);
    expect(out[4]).toBeCloseTo(0.1 / 0.4, 12);
    // headroom 1.5 ≥ step at 1 → containing bucket untouched
    const out2 = applyRunningMaxConstraint(probs, ladder, 90, { p50: 1, p90: 1 });
    expect(out2[2]).toBeCloseTo(0.3 / 0.7, 12);
  });

  it('a runningMax below the whole ladder changes nothing', () => {
    const out = applyRunningMaxConstraint(probs, ladder, 50);
    out.forEach((p, i) => expect(p).toBeCloseTo(probs[i]!, 12));
  });
});
