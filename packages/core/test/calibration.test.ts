import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeModelWeights, correctPoint, fitSigma, updateBias } from '../src/calibration/emos.ts';
import {
  brierScore,
  expectedCalibrationError,
  mulberry32,
  pairedBootstrapPValue,
  reliabilityBins,
  sharpness,
} from '../src/calibration/scores.ts';

describe('updateBias (§6.6)', () => {
  it('seeds with the error when prevBias is null', () => {
    expect(updateBias(null, 1.7, 0.15)).toBe(1.7);
    expect(updateBias(null, -2.3, 0.15)).toBe(-2.3);
  });

  it('converges geometrically on constant error — gap shrinks by exactly (1−α) per step', () => {
    const alpha = 0.15;
    const e = 2.0;
    let bias = 0;
    let gap = e - bias;
    for (let k = 0; k < 40; k++) {
      bias = updateBias(bias, e, alpha);
      const newGap = e - bias;
      expect(newGap).toBeCloseTo((1 - alpha) * gap, 12);
      gap = newGap;
    }
    expect(bias).toBeCloseTo(e, 2); // converged after 40 steps
  });
});

describe('fitSigma (§6.6)', () => {
  it('null under minN', () => {
    expect(fitSigma([1, 2, 3, 4, 5, 6, 7], 8)).toBeNull();
    expect(fitSigma([], 8)).toBeNull();
  });

  it('matches the manual sample std-dev (n−1)', () => {
    const residuals = [1, 2, 3, 4, 5, 6, 7, 8]; // mean 4.5, SS 42, sample var 6
    const fit = fitSigma(residuals, 8);
    expect(fit).not.toBeNull();
    expect(fit!.sigma).toBeCloseTo(Math.sqrt(6), 12);
    expect(fit!.n).toBe(8);
  });

  it('zero-variance residuals give σ 0 (callers floor it via sigmaFloorC)', () => {
    expect(fitSigma([1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5], 8)!.sigma).toBe(0);
  });
});

describe('computeModelWeights (§6.6)', () => {
  it('inverse-MSE, Σ=1', () => {
    const w = computeModelWeights(new Map([['a', 1], ['b', 2]]));
    expect(w.get('a')).toBeCloseTo(2 / 3, 12);
    expect(w.get('b')).toBeCloseTo(1 / 3, 12);
    expect([...w.values()].reduce((x, y) => x + y, 0)).toBeCloseTo(1, 12);
  });

  it('missing-data models (non-finite MSE) get weight 0', () => {
    const w = computeModelWeights(new Map([['a', 1], ['b', NaN], ['c', Infinity]]));
    expect(w.get('a')).toBe(1);
    expect(w.get('b')).toBe(0);
    expect(w.get('c')).toBe(0);
  });

  it('single model → weight 1', () => {
    const w = computeModelWeights(new Map([['only', 5]]));
    expect(w.get('only')).toBe(1);
  });

  it('all-missing → all zero (no division by zero)', () => {
    const w = computeModelWeights(new Map([['a', NaN]]));
    expect(w.get('a')).toBe(0);
  });
});

describe('correctPoint (§6.6)', () => {
  it('rawC − bias', () => {
    expect(correctPoint(25.4, 1.2)).toBeCloseTo(24.2, 12);
    expect(correctPoint(25.4, -1.2)).toBeCloseTo(26.6, 12);
  });

  it('grep invariant: emos.ts is the ONLY production site subtracting a bias', () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..');
    const offenders: string[] = [];
    const skipDirs = new Set(['node_modules', '.git', 'research', 'test', 'tests', '.next', 'dist']);
    const biasSubtraction = /-\s*[\w.$]*[Bb]ias\w*\b|\b[\w.$]*[Bb]ias\w*\s*-(?!-)/;

    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (!skipDirs.has(name)) walk(full);
        } else if (/\.(ts|tsx|sql)$/.test(name) && !/\.test\.ts$/.test(name)) {
          // Comments don't subtract — strip them so prose like "bias-corrected" can't trip the wire.
          const text = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '')
            .replace(/^\s*--.*$/gm, '');
          if (biasSubtraction.test(text) && !full.replace(/\\/g, '/').endsWith('calibration/emos.ts')) {
            offenders.push(full);
          }
        }
      }
    };
    walk(repoRoot);
    expect(offenders).toEqual([]);
  });
});

describe('brierScore (§6.6)', () => {
  it('0 perfect / 2 worst-case sanity', () => {
    expect(brierScore([0, 1, 0], 1)).toBe(0);
    expect(brierScore([1, 0, 0], 1)).toBe(2); // all mass on the wrong bucket
  });

  it('matches the hand example: [0.2, 0.5, 0.3] outcome idx 1 → 0.38', () => {
    expect(brierScore([0.2, 0.5, 0.3], 1)).toBeCloseTo(0.38, 12);
  });
});

describe('expectedCalibrationError + reliabilityBins (§6.6)', () => {
  /** 10 preds at q with exactly q·10 hits — perfectly calibrated by construction. */
  const calibratedAt = (q: number): { q: number; hit: boolean }[] =>
    Array.from({ length: 10 }, (_, i) => ({ q, hit: i < Math.round(q * 10) }));

  it('synthetic perfectly-calibrated set → ECE ≈ 0', () => {
    const preds = [...calibratedAt(0.1), ...calibratedAt(0.3), ...calibratedAt(0.7), ...calibratedAt(0.9)];
    expect(expectedCalibrationError(preds, 10)).toBeCloseTo(0, 12);
  });

  it('bins carry n and the bin stats', () => {
    const preds = [...calibratedAt(0.25), ...calibratedAt(0.75)];
    const bins = reliabilityBins(preds, 10);
    expect(bins.length).toBe(2);
    expect(bins[0]).toMatchObject({ lo: 0.2, hi: 0.3, n: 10, meanQ: 0.25 });
    expect(bins[0]!.hitRate).toBeCloseTo(0.3, 12); // round(0.25·10)=3 hits of 10
    expect(bins[1]).toMatchObject({ lo: 0.7, hi: 0.8, n: 10 });
  });

  it('q = 1 lands in the top bin (no off-by-one loss)', () => {
    const bins = reliabilityBins([{ q: 1, hit: true }], 10);
    expect(bins.length).toBe(1);
    expect(bins[0]).toMatchObject({ lo: 0.9, hi: 1, n: 1, meanQ: 1, hitRate: 1 });
  });

  it('miscalibrated predictions produce a positive ECE', () => {
    const overconfident = Array.from({ length: 20 }, (_, i) => ({ q: 0.9, hit: i < 10 })); // 50% hits at q=0.9
    expect(expectedCalibrationError(overconfident, 10)).toBeCloseTo(0.4, 12);
  });
});

describe('sharpness (§6.6)', () => {
  it('orders sharp above flat', () => {
    const sharp = [[0.9, 0.05, 0.05], [0.8, 0.1, 0.1]];
    const flat = [[0.34, 0.33, 0.33], [0.4, 0.3, 0.3]];
    expect(sharpness(sharp)).toBeCloseTo(0.85, 12);
    expect(sharpness(flat)).toBeCloseTo(0.37, 12);
    expect(sharpness(sharp)).toBeGreaterThan(sharpness(flat));
  });
});

describe('pairedBootstrapPValue (§6.6, C5)', () => {
  it('seeded reproducibility — identical p for identical seed', () => {
    const rand = mulberry32(7);
    const diffs = Array.from({ length: 60 }, () => rand() * 0.1 - 0.05);
    expect(pairedBootstrapPValue(diffs, 2000, 42)).toBe(pairedBootstrapPValue(diffs, 2000, 42));
  });

  it('returns 1.0 under n < 30 — insufficient evidence is a failing gate', () => {
    const diffs = Array.from({ length: 29 }, () => -0.5); // house massively better, but n too small
    expect(pairedBootstrapPValue(diffs)).toBe(1.0);
  });

  it('clearly better house → p near 0; clearly worse → p near 1', () => {
    const rand = mulberry32(11);
    const better = Array.from({ length: 60 }, () => -0.05 + (rand() - 0.5) * 0.02);
    const worse = Array.from({ length: 60 }, () => 0.05 + (rand() - 0.5) * 0.02);
    expect(pairedBootstrapPValue(better)).toBeLessThan(0.01);
    expect(pairedBootstrapPValue(worse)).toBeGreaterThan(0.99);
  });

  it('C5 zero-skill Monte Carlo regression: no-skill data passes the FULL gate in <5% of 1,000 trials', () => {
    // Full gate = pooled bootstrap p < 0.05 AND house point estimate ≤ 0.95 × market.
    // House and market are statistically identical (same noise law) — any pass is luck.
    const TRIALS = 1000;
    const N_EVENTS = 60;
    let passes = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const rand = mulberry32(1_000_003 + trial);
      const house: number[] = [];
      const market: number[] = [];
      for (let i = 0; i < N_EVENTS; i++) {
        const base = 0.15 + rand() * 0.3; // shared per-event difficulty
        house.push(base + (rand() - 0.5) * 0.1);
        market.push(base + (rand() - 0.5) * 0.1);
      }
      const meanHouse = house.reduce((a, b) => a + b, 0) / N_EVENTS;
      const meanMarket = market.reduce((a, b) => a + b, 0) / N_EVENTS;
      const pointPass = meanHouse <= 0.95 * meanMarket;
      if (!pointPass) continue; // gate is conjunctive; skip the bootstrap when the point test already fails
      const diffs = house.map((h, i) => h - market[i]!);
      const p = pairedBootstrapPValue(diffs, 500, 42 + trial);
      if (p < 0.05) passes++;
    }
    expect(passes).toBeLessThan(TRIALS * 0.05);
  });
});
