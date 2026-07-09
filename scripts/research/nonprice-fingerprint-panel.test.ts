import { describe, expect, it } from 'vitest';
import { buildPrefix, featuresAt, priceAtIdx } from './nonprice-fingerprint-panel.ts';

describe('priceAtIdx', () => {
  const times = [0, 100, 200, 300];
  it('returns the last index at or before t', () => {
    expect(priceAtIdx(times, 250)).toBe(2);
    expect(priceAtIdx(times, 300)).toBe(3);
    expect(priceAtIdx(times, 100)).toBe(1);
  });
  it('returns -1 when t precedes the first point', () => {
    expect(priceAtIdx(times, -5)).toBe(-1);
  });
});

describe('buildPrefix', () => {
  it('tracks running max/min and the time of the max', () => {
    const times = [0, 60, 120, 180];
    const prices = [0.1, 0.3, 0.2, 0.25];
    const pre = buildPrefix(times, prices);
    expect(pre.runMax).toEqual([0.1, 0.3, 0.3, 0.3]);
    expect(pre.runMin).toEqual([0.1, 0.1, 0.1, 0.1]);
    expect(pre.tAtMax[3]).toBe(60); // the max (0.3) happened at t=60
  });
  it('counts ≥5¢ zig-zag reversals (swings)', () => {
    // up to 0.30, down to 0.10 (reversal 1), up to 0.30 (reversal 2)
    const prices = [0.1, 0.3, 0.1, 0.3];
    const pre = buildPrefix([0, 1, 2, 3], prices);
    expect(pre.osc[3]).toBe(2);
  });
  it('does not count sub-5¢ wiggles as swings', () => {
    const prices = [0.2, 0.23, 0.21, 0.24, 0.22];
    const pre = buildPrefix([0, 1, 2, 3, 4], prices);
    expect(pre.osc[4]).toBe(0);
  });
});

describe('featuresAt', () => {
  it('computes momentum, drawdown, runup and hrs-since-peak', () => {
    // points 1h apart: 0.10, 0.30 (peak), 0.20 (now)
    const times = [0, 3600, 7200];
    const prices = [0.1, 0.3, 0.2];
    const pre = buildPrefix(times, prices);
    const f = featuresAt(times, prices, pre, 2); // at t=7200, p=0.20
    expect(f.p).toBeCloseTo(0.2, 10);
    expect(f.mom1h).toBeCloseTo(-0.1, 10); // 0.20 - 0.30 (1h ago)
    expect(f.mom3h).toBeNull(); // no point 3h before 7200
    expect(f.drawdown).toBeCloseTo(0.1, 10); // runMax 0.30 - 0.20
    expect(f.runup).toBeCloseTo(0.1, 10); // 0.20 - runMin 0.10
    expect(f.hrsSincePeak).toBeCloseTo(1, 10); // peak at 3600, now 7200 → 1h
    expect(f.fracLife).toBeCloseTo(1, 10); // last point
  });
});
