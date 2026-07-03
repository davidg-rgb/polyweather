/**
 * Tests for scripts/research/conditional-efficiency-scan — the PURE classification helpers behind
 * SIGNAL-BACKLOG.md items 2-4 (bust cutoff, disagreement quartiles, tail-day cutpoints, far-tail bucket
 * selection, calendar-day-add). The DB-touching runScan()/report() are NOT exercised here — no DB access,
 * per the "SQL prepared, not executed" scope of this pass.
 */
import { describe, expect, it } from 'vitest';
import {
  quantile,
  fitBustCutoff,
  isBust,
  fitQuartileCutpoints,
  classifyQuartile,
  fitTailCutpoints,
  isExtremeDay,
  selectFarTailBuckets,
  addDaysISO,
} from './conditional-efficiency-scan.ts';
import type { BucketView } from './db1-daybefore-efficiency.ts';

describe('quantile — linear-interpolated, shared by all three splits', () => {
  it('matches the exact value at the boundaries', () => {
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
  });
  it('interpolates the median of an even-length array', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 9);
  });
  it('is NaN on an empty array', () => {
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

describe('#2 — bust cutoff + classification', () => {
  it('fitBustCutoff is the P75 of the TRAIN errors', () => {
    const train = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(fitBustCutoff(train)).toBeCloseTo(quantile([...train].sort((a, b) => a - b), 0.75), 9);
  });
  it('isBust fires at/above the cutoff, not below', () => {
    const cutoff = fitBustCutoff([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(isBust(cutoff, cutoff)).toBe(true);
    expect(isBust(cutoff - 0.01, cutoff)).toBe(false);
  });
  it('is false on non-finite input (never crashes the TEST-period scan on a data gap)', () => {
    expect(isBust(NaN, 2)).toBe(false);
    expect(isBust(3, NaN)).toBe(false);
  });
});

describe('#3 — disagreement quartile cutpoints + classification', () => {
  it('classifies at/below each cutpoint into the correct quartile', () => {
    const c = fitQuartileCutpoints([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(classifyQuartile(c.q25, c)).toBe(1);
    expect(classifyQuartile(c.q25 + 1e-9, c)).toBe(2);
    expect(classifyQuartile(c.q75 + 100, c)).toBe(4);
  });
  it('is null on a non-finite TEST value (never silently mis-buckets a data gap)', () => {
    const c = fitQuartileCutpoints([1, 2, 3, 4]);
    expect(classifyQuartile(NaN, c)).toBeNull();
  });
  it('is monotone: every TRAIN value classifies into 1..4 with no gaps', () => {
    const train = Array.from({ length: 40 }, (_, i) => i + 1);
    const c = fitQuartileCutpoints(train);
    const seen = new Set(train.map((v) => classifyQuartile(v, c)));
    expect(seen).toEqual(new Set([1, 2, 3, 4]));
  });
});

describe('#4 — tail cutpoints + extreme-day classification', () => {
  it('flags at/beyond P5 or P95, never the interior', () => {
    const t = fitTailCutpoints([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(isExtremeDay(t.p05, t)).toBe(true);
    expect(isExtremeDay(t.p95, t)).toBe(true);
    expect(isExtremeDay((t.p05 + t.p95) / 2, t)).toBe(false);
  });
  it('is false on non-finite obs', () => {
    const t = fitTailCutpoints([1, 2, 3, 4, 5]);
    expect(isExtremeDay(NaN, t)).toBe(false);
  });
});

describe('selectFarTailBuckets — model-distance longshots, distinct from the market-price cheap subset', () => {
  const views = (n: number, modePos: number): BucketView[] =>
    Array.from({ length: n }, (_, i) => ({
      bucketIdx: i, calibratedP: i === modePos ? 0.6 : 0.4 / (n - 1), ask: 0.1, isWinner: false,
    }));

  it('selects buckets >= minDistance from the mode, excludes the near ones', () => {
    const v = views(6, 2); // mode at position 2 (0-indexed)
    const far = selectFarTailBuckets(v, 2);
    expect(far.map((b) => b.bucketIdx).sort()).toEqual([0, 4, 5]); // |0-2|=2, |4-2|=2, |5-2|=3 qualify; 1,3 (dist 1) don't
  });
  it('is empty on a degenerate/empty input', () => {
    expect(selectFarTailBuckets([])).toEqual([]);
  });
  it('minDistance=0 selects every bucket (including the mode itself)', () => {
    const v = views(4, 1);
    expect(selectFarTailBuckets(v, 0).length).toBe(4);
  });
});

describe('addDaysISO — plain calendar-day increment (no tz — target_date is a DATE column)', () => {
  it('adds one day within a month', () => {
    expect(addDaysISO('2026-06-20', 1)).toBe('2026-06-21');
  });
  it('rolls over a month boundary', () => {
    expect(addDaysISO('2026-06-30', 1)).toBe('2026-07-01');
  });
  it('rolls over a year boundary', () => {
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('handles a leap-day month correctly (2028 is a leap year)', () => {
    expect(addDaysISO('2028-02-28', 1)).toBe('2028-02-29');
  });
});
