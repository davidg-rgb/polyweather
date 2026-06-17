import { describe, expect, it } from 'vitest';
import {
  armEdgeStats,
  armTruthStats,
  bootstrapMeanCi,
  meanConfidenceInterval,
  quantileSorted,
  type TruthBet,
  wilsonInterval,
  Z_95,
  type GradedBet,
} from '../src/sim/stats.ts';

describe('wilsonInterval — small-n-safe proportion CI', () => {
  it('matches the textbook 95% bounds for 8/10 (≈[0.490, 0.943])', () => {
    const ci = wilsonInterval(8, 10);
    expect(ci.lo).toBeCloseTo(0.49, 2);
    expect(ci.hi).toBeCloseTo(0.943, 2);
  });

  it('clamps to [0,1] at the extremes — 10/10 pins hi to ~1, lo informative; 0/10 mirrors it', () => {
    const ci = wilsonInterval(10, 10);
    expect(ci.hi).toBeLessThanOrEqual(1);
    expect(ci.hi).toBeGreaterThan(0.999); // upper bound effectively 1
    expect(ci.lo).toBeCloseTo(0.7225, 3);
    const zero = wilsonInterval(0, 10);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeLessThan(0.31);
  });

  it('n=0 → the maximally-uncertain [0,1] (no evidence, never NaN)', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it('the interval narrows as n grows at the same proportion', () => {
    const small = wilsonInterval(8, 10);
    const big = wilsonInterval(80, 100);
    expect(big.hi - big.lo).toBeLessThan(small.hi - small.lo);
  });

  it('Z_95 is the standard two-sided 95% critical value', () => {
    expect(Z_95).toBeCloseTo(1.96, 3);
  });
});

describe('meanConfidenceInterval — mean ± z·SE for a paired series', () => {
  it('computes the Bessel-corrected SE and symmetric bounds ([2,4,6])', () => {
    const ci = meanConfidenceInterval([2, 4, 6]);
    expect(ci.mean).toBe(4);
    expect(ci.se).toBeCloseTo(1.1547, 4); // sqrt(4/3)
    expect(ci.lo).toBeCloseTo(4 - Z_95 * 1.1547, 4);
    expect(ci.hi).toBeCloseTo(4 + Z_95 * 1.1547, 4);
    expect(ci.n).toBe(3);
  });

  it('n=1 → a degenerate CI at the point (SE 0, not infinite)', () => {
    expect(meanConfidenceInterval([5])).toEqual({ mean: 5, lo: 5, hi: 5, se: 0, n: 1 });
  });

  it('n=0 → NaN bounds (serialises to null → dashboard "—")', () => {
    const ci = meanConfidenceInterval([]);
    expect(ci.n).toBe(0);
    expect(Number.isNaN(ci.mean)).toBe(true);
    expect(Number.isNaN(ci.lo)).toBe(true);
  });
});

describe('quantileSorted — type-7 linear interpolation', () => {
  it('median, extremes and an interpolated point', () => {
    const a = [1, 2, 3, 4, 5];
    expect(quantileSorted(a, 0.5)).toBe(3);
    expect(quantileSorted(a, 0)).toBe(1);
    expect(quantileSorted(a, 1)).toBe(5);
    expect(quantileSorted(a, 0.25)).toBe(2);
    expect(quantileSorted(a, 0.1)).toBeCloseTo(1.4, 10);
  });

  it('handles empty and singleton', () => {
    expect(Number.isNaN(quantileSorted([], 0.5))).toBe(true);
    expect(quantileSorted([7], 0.9)).toBe(7);
  });
});

describe('bootstrapMeanCi — seeded percentile bootstrap for heavy tails', () => {
  it('is reproducible: same values + seed → byte-identical bounds', () => {
    const v = [-1, -1, -1, 19, -1, 1, -1, 3];
    const a = bootstrapMeanCi(v, { seed: 7 });
    const b = bootstrapMeanCi(v, { seed: 7 });
    expect(a).toEqual(b);
  });

  it('brackets the sample mean and stays inside the observed range', () => {
    const v = [-1, -1, -1, 19]; // mean 4, one fat win
    const a = bootstrapMeanCi(v, { seed: 1 });
    expect(a.mean).toBe(4);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
    // resample means can never escape the observation range [min, max]
    expect(a.lo).toBeGreaterThanOrEqual(-1);
    expect(a.hi).toBeLessThanOrEqual(19);
  });

  it('n=1 → degenerate at the point; n=0 → NaN', () => {
    expect(bootstrapMeanCi([2.5])).toEqual({ mean: 2.5, lo: 2.5, hi: 2.5, n: 1 });
    const z = bootstrapMeanCi([]);
    expect(z.n).toBe(0);
    expect(Number.isNaN(z.mean)).toBe(true);
  });
});

describe('armEdgeStats — the wired (won, ask) → hit/edge/EV bundle', () => {
  const bets: GradedBet[] = [
    { won: true, ask: 0.5 },
    { won: true, ask: 0.5 },
    { won: false, ask: 0.5 },
  ];

  it('hit rate, paired edge and EV agree with the by-hand values', () => {
    const s = armEdgeStats(bets);
    expect(s.nGraded).toBe(3);
    expect(s.nWon).toBe(2);
    expect(s.hitRate).toBeCloseTo(2 / 3, 10);
    expect(s.avgAsk).toBeCloseTo(0.5, 10);
    // edge = mean(won−ask) = (0.5 + 0.5 − 0.5)/3 = 0.1667 = hitRate − avgAsk (constant ask)
    expect(s.edge).toBeCloseTo(1 / 6, 10);
    expect(s.edge).toBeCloseTo(s.hitRate - s.avgAsk, 10);
    // EV = mean(won ? 1/ask−1 : −1) = (1 + 1 − 1)/3 = 0.3333
    expect(s.ev).toBeCloseTo(1 / 3, 10);
    // Wilson hit CI brackets the point estimate
    expect(s.hitCiLo).toBeLessThanOrEqual(s.hitRate);
    expect(s.hitCiHi).toBeGreaterThanOrEqual(s.hitRate);
  });

  it('drops bets with an unusable ask (≤0 or >1) — they could never have been placed', () => {
    const s = armEdgeStats([...bets, { won: true, ask: 0 }, { won: false, ask: 1.4 }]);
    expect(s.nGraded).toBe(3); // the two junk asks dropped
  });

  it('nGraded=0 → an all-NaN bundle (the dashboard greys it out)', () => {
    const s = armEdgeStats([]);
    expect(s.nGraded).toBe(0);
    expect(s.nWon).toBe(0);
    expect(Number.isNaN(s.edge)).toBe(true);
    expect(Number.isNaN(s.ev)).toBe(true);
    expect(Number.isNaN(s.hitRate)).toBe(true);
  });

  it('is reproducible (seeded EV bootstrap)', () => {
    expect(armEdgeStats(bets)).toEqual(armEdgeStats(bets));
  });
});

describe('armTruthStats — floor-hit (Wilson) + decimal MAE/bias', () => {
  const rows: TruthBet[] = [
    { truthWon: true, signedErrorC: 0.2 },
    { truthWon: true, signedErrorC: -0.4 },
    { truthWon: false, signedErrorC: 0.9 },
    { truthWon: true, signedErrorC: -0.1 },
  ];
  it('computes the floor-hit rate with a bracketing Wilson CI', () => {
    const s = armTruthStats(rows);
    expect(s.nTruth).toBe(4);
    expect(s.nTruthWon).toBe(3);
    expect(s.truthHitRate).toBeCloseTo(0.75, 10);
    expect(s.truthHitCiLo).toBeGreaterThanOrEqual(0);
    expect(s.truthHitCiLo).toBeLessThan(0.75);
    expect(s.truthHitCiHi).toBeGreaterThan(0.75);
    expect(s.truthHitCiHi).toBeLessThanOrEqual(1);
  });
  it('MAE is the mean |signed error| and bias the mean signed error, with a bracketing CI', () => {
    const s = armTruthStats(rows);
    expect(s.mae).toBeCloseTo((0.2 + 0.4 + 0.9 + 0.1) / 4, 10);
    expect(s.bias).toBeCloseTo((0.2 - 0.4 + 0.9 - 0.1) / 4, 10);
    expect(s.biasCiLo).toBeLessThan(s.bias);
    expect(s.biasCiHi).toBeGreaterThan(s.bias);
  });
  it('drops non-finite signed errors; empty → an all-NaN/empty bundle', () => {
    const s = armTruthStats([{ truthWon: true, signedErrorC: Number.NaN }]);
    expect(s.nTruth).toBe(0);
    expect(Number.isNaN(s.truthHitRate)).toBe(true);
    expect(Number.isNaN(s.mae)).toBe(true);
    // n=0 Wilson is the maximally-uncertain [0,1] by design (not NaN)
    expect(s.truthHitCiLo).toBe(0);
    expect(s.truthHitCiHi).toBe(1);
  });
});
