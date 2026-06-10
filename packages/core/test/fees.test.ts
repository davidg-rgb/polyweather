import { describe, expect, it } from 'vitest';
import { minEdgeRequired, takerFeePerShare, takerFeeTotal } from '../src/fees.ts';
import type { EdgeConfig } from '../src/types.ts';

const cfg: EdgeConfig = {
  uncertaintyMargin: 0.05,
  spreadBufferMin: 0.01,
  feeRate: 0.05,
  probeStakeUsd: 20,
  maxSpread: 0.05,
  minEventVolumeUsd: 2000,
  minHoursBeforeClose: 2,
};

describe('takerFeePerShare (§6.4, ADR-07)', () => {
  it('docs worked example: fee(0.34, 0.05) = 0.01122; 100 shares → $1.12', () => {
    expect(takerFeePerShare(0.34, 0.05)).toBeCloseTo(0.01122, 10);
    expect(takerFeeTotal(0.34, 100, 0.05)).toBeCloseTo(1.12, 2);
  });

  it('rate scales linearly and is never assumed (0 rate → 0 fee)', () => {
    expect(takerFeePerShare(0.34, 0)).toBe(0);
    expect(takerFeePerShare(0.34, 0.1)).toBeCloseTo(2 * takerFeePerShare(0.34, 0.05), 12);
  });

  it('peaks at p = 0.5 and vanishes at the boundaries', () => {
    expect(takerFeePerShare(0.5, 0.05)).toBeCloseTo(0.0125, 10);
    expect(takerFeePerShare(0.5, 0.05)).toBeGreaterThan(takerFeePerShare(0.34, 0.05));
    expect(takerFeePerShare(0, 0.05)).toBe(0);
    expect(takerFeePerShare(1, 0.05)).toBe(0);
  });
});

describe('takerFeeTotal symmetry (§15)', () => {
  it('symmetric at p and 1−p', () => {
    for (const p of [0.1, 0.25, 0.34, 0.42, 0.49]) {
      expect(takerFeeTotal(p, 100, 0.05)).toBeCloseTo(takerFeeTotal(1 - p, 100, 0.05), 12);
    }
  });
});

describe('minEdgeRequired (§6.4)', () => {
  it('uses the spread buffer floor when observedSpread/2 is below it', () => {
    // 0.05 + max(0.01, 0.002) + 0.01122
    expect(minEdgeRequired(0.34, 0.004, cfg)).toBeCloseTo(0.05 + 0.01 + 0.01122, 10);
  });

  it('uses observedSpread/2 when it exceeds the buffer floor', () => {
    // 0.05 + max(0.01, 0.02) + 0.01122
    expect(minEdgeRequired(0.34, 0.04, cfg)).toBeCloseTo(0.05 + 0.02 + 0.01122, 10);
  });

  it('monotone in every component', () => {
    const base = minEdgeRequired(0.34, 0.04, cfg);
    expect(minEdgeRequired(0.34, 0.05, cfg)).toBeGreaterThan(base); // wider spread
    expect(minEdgeRequired(0.34, 0.04, { ...cfg, uncertaintyMargin: 0.06 })).toBeGreaterThan(base);
    expect(minEdgeRequired(0.34, 0.04, { ...cfg, feeRate: 0.06 })).toBeGreaterThan(base);
    expect(minEdgeRequired(0.5, 0.04, cfg)).toBeGreaterThan(base); // fee peaks at p=0.5
  });
});
