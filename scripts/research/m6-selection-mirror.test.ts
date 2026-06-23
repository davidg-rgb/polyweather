/**
 * Tests for m6-selection-mirror — the pure selection-mirror statistics + the CSV splitter.
 * No DB / no network (the research-script idiom): exercises mirrorStats + splitCsvLine on synthetic input.
 */
import { describe, it, expect } from 'vitest';
import { mirrorStats, splitCsvLine, type MirrorPick } from './m6-selection-mirror.ts';

describe('splitCsvLine (quote-aware)', () => {
  it('splits a plain line', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });
  it('respects a double-quoted field containing a comma', () => {
    expect(splitCsvLine('a,"x,y",c')).toEqual(['a', 'x,y', 'c']);
  });
  it('handles a trailing empty field', () => {
    expect(splitCsvLine('a,b,')).toEqual(['a', 'b', '']);
  });
});

describe('mirrorStats', () => {
  const picks: MirrorPick[] = [
    { price: 0.1, won: true, leadHours: 36, stakeUsd: 10, outcome: 'Yes' },
    { price: 0.1, won: false, leadHours: 36, stakeUsd: 10, outcome: 'Yes' },
    { price: 0.2, won: false, leadHours: 50, stakeUsd: 10, outcome: 'Yes' },
  ];

  it('selection edge = mean(won − price), REBATE-INDEPENDENT', () => {
    // edges: +0.9, −0.1, −0.2 → mean 0.2
    const cons = mirrorStats(picks, { feeRate: 0.05, rebateRate: 0, seed: 42, mcIters: 0 });
    const real = mirrorStats(picks, { feeRate: 0.05, rebateRate: 0.25, seed: 42, mcIters: 0 });
    expect(cons.edge.mean).toBeCloseTo(0.2, 9);
    expect(real.edge.mean).toBeCloseTo(cons.edge.mean, 12); // rebate does not touch the edge
  });

  it('the rebate lifts the realistic maker EV above the conservative EV', () => {
    const cons = mirrorStats(picks, { feeRate: 0.05, rebateRate: 0, seed: 42, mcIters: 0 });
    const real = mirrorStats(picks, { feeRate: 0.05, rebateRate: 0.25, seed: 42, mcIters: 0 });
    // conservative EV mean = (8.955 − 1.045 − 1.04)/3; realistic = (9.01125 − 0.98875 − 0.99)/3
    expect(cons.ev.mean).toBeCloseTo((8.955 - 1.045 - 1.04) / 3, 6);
    expect(real.ev.mean).toBeCloseTo((9.01125 - 0.98875 - 0.99) / 3, 6);
    expect(real.ev.mean).toBeGreaterThan(cons.ev.mean);
  });

  it('win rate is the resolved hit rate', () => {
    const s = mirrorStats(picks, { feeRate: 0.05, rebateRate: 0.25, seed: 42, mcIters: 0 });
    expect(s.n).toBe(3);
    expect(s.nWon).toBe(1);
    expect(s.winRate).toBeCloseTo(1 / 3, 9);
  });

  it('zero-skill MC returns a probability in [0,1]', () => {
    const s = mirrorStats(picks, { feeRate: 0.05, rebateRate: 0.25, seed: 42, mcIters: 100 });
    expect(s.zeroSkillPPass).toBeGreaterThanOrEqual(0);
    expect(s.zeroSkillPPass).toBeLessThanOrEqual(1);
  });

  it('empty input is total ({n:0, NaN})', () => {
    const s = mirrorStats([], { feeRate: 0.05, rebateRate: 0.25 });
    expect(s.n).toBe(0);
    expect(Number.isNaN(s.ev.mean)).toBe(true);
    expect(Number.isNaN(s.edge.mean)).toBe(true);
  });
});
