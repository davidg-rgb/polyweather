import { describe, expect, it } from 'vitest';
import { olsFit, shrinkFit } from './mos-pointskill.ts';

describe('olsFit — the regression-MOS fit the experiment depends on', () => {
  it('recovers a perfect line y = 2 + 0.5x exactly', () => {
    const xs = [0, 2, 4, 6, 8];
    const ys = xs.map((x) => 2 + 0.5 * x);
    const fit = olsFit(xs, ys)!;
    expect(fit.b).toBeCloseTo(0.5, 12);
    expect(fit.a).toBeCloseTo(2, 12);
  });

  it('recovers slope 1 / intercept 0 for the identity (no correction)', () => {
    const xs = [10, 11, 12, 13, 14, 9];
    const fit = olsFit(xs, [...xs])!;
    expect(fit.b).toBeCloseTo(1, 12);
    expect(fit.a).toBeCloseTo(0, 12);
  });

  it('returns null when forecasts have ~no variance (degenerate slope) or n < 2', () => {
    expect(olsFit([5, 5, 5, 5], [1, 2, 3, 4])).toBeNull(); // sxx ≈ 0
    expect(olsFit([5], [1])).toBeNull();
  });

  it('fits a noisy slope-biased model (warm on hot days) with b ≠ 1', () => {
    // obs = forecast scaled by 0.6 + offset — a slope error a constant intercept cannot remove.
    const xs = [-5, 0, 5, 10, 15, 20];
    const ys = xs.map((x) => 3 + 0.6 * x);
    const fit = olsFit(xs, ys)!;
    expect(fit.b).toBeCloseTo(0.6, 9);
    expect(fit.a).toBeCloseTo(3, 9);
  });
});

describe('shrinkFit — regularize the OLS slope toward 1 (the no-conditional-bias prior)', () => {
  it('with k = n the slope moves halfway to 1', () => {
    const sh = shrinkFit({ a: 2, b: 0.5 }, 4, 5, 5); // w = 5/10 = 0.5 → b = 0.75
    expect(sh.b).toBeCloseTo(0.75, 12);
  });

  it('preserves the OLS prediction at the window mean (re-anchored intercept)', () => {
    const fit = { a: 2, b: 0.5 };
    const xbar = 4;
    const ybarPred = fit.a + fit.b * xbar; // 4
    const sh = shrinkFit(fit, xbar, 20, 10);
    expect(sh.a + sh.b * xbar).toBeCloseTo(ybarPred, 12);
  });

  it('large n shrinks little; tiny n shrinks hard toward slope 1', () => {
    const big = shrinkFit({ a: 0, b: 0.4 }, 0, 1000, 10);
    expect(big.b).toBeGreaterThan(0.39); // barely moved
    const small = shrinkFit({ a: 0, b: 0.4 }, 0, 1, 10);
    expect(small.b).toBeGreaterThan(0.9); // pulled almost all the way to 1
  });
});
