import { describe, expect, it } from 'vitest';
import {
  selectEntries,
  bucketEdge,
  marketImpliedProbs,
  CHEAP_LONGSHOT_MAX_ASK,
  type BucketView,
} from './db1-daybefore-efficiency.ts';

describe('bucketEdge — the primary metric (calibratedP − ask)', () => {
  it('computes the signed gap', () => {
    expect(bucketEdge(0.3, 0.2)).toBeCloseTo(0.1, 12);
    expect(bucketEdge(0.1, 0.25)).toBeCloseTo(-0.15, 12);
  });
});

describe('selectEntries — the badatmath-style entry-selection rule', () => {
  const views: BucketView[] = [
    { bucketIdx: 0, calibratedP: 0.05, ask: 0.02, isWinner: false }, // cheap, p>ask → longshot
    { bucketIdx: 1, calibratedP: 0.6, ask: 0.55, isWinner: true }, // modal (argmax), ask≥0.25 → modal only
    { bucketIdx: 2, calibratedP: 0.1, ask: 0.3, isWinner: false }, // p<ask, ask≥0.25 → nothing
    { bucketIdx: 3, calibratedP: 0.2, ask: 0.1, isWinner: false }, // cheap, p>ask → longshot
  ];

  it('selects exactly the argmax bucket as the modal arm', () => {
    const modal = selectEntries(views).filter((s) => s.arm === 'modal');
    expect(modal).toHaveLength(1);
    expect(modal[0]!.bucketIdx).toBe(1);
  });

  it('selects every bucket with calibratedP > ask AND ask < 0.25 as cheap-longshot', () => {
    const longs = selectEntries(views).filter((s) => s.arm === 'cheap_longshot');
    expect(longs.map((l) => l.bucketIdx).sort()).toEqual([0, 3]);
    expect(longs.every((l) => l.inCheapSubset)).toBe(true);
  });

  it('does NOT select a cheap bucket whose calibratedP ≤ ask', () => {
    const v: BucketView[] = [
      { bucketIdx: 0, calibratedP: 0.9, ask: 0.5, isWinner: true }, // modal
      { bucketIdx: 1, calibratedP: 0.02, ask: 0.05, isWinner: false }, // cheap but p<ask → not a longshot
    ];
    const longs = selectEntries(v).filter((s) => s.arm === 'cheap_longshot');
    expect(longs).toHaveLength(0);
  });

  it('does NOT select a p>ask bucket whose ask is ≥ 0.25 (not cheap)', () => {
    const v: BucketView[] = [
      { bucketIdx: 0, calibratedP: 0.6, ask: 0.4, isWinner: true }, // modal + p>ask but ask≥0.25
    ];
    const sel = selectEntries(v);
    expect(sel.filter((s) => s.arm === 'cheap_longshot')).toHaveLength(0);
    expect(sel.filter((s) => s.arm === 'modal')).toHaveLength(1);
  });

  it('emits a cheap modal bucket under BOTH arms (counted in each independently)', () => {
    const v: BucketView[] = [
      { bucketIdx: 0, calibratedP: 0.5, ask: 0.1, isWinner: true }, // modal AND cheap (p>ask, ask<0.25)
      { bucketIdx: 1, calibratedP: 0.5, ask: 0.9, isWinner: false }, // tie on p; argmax keeps idx 0
    ];
    const sel = selectEntries(v);
    expect(sel.some((s) => s.arm === 'modal' && s.bucketIdx === 0)).toBe(true);
    expect(sel.some((s) => s.arm === 'cheap_longshot' && s.bucketIdx === 0)).toBe(true);
  });

  it('never selects a bucket with no usable day-before ask', () => {
    const v: BucketView[] = [
      { bucketIdx: 0, calibratedP: 0.9, ask: null, isWinner: true }, // modal but no quote → skip
      { bucketIdx: 1, calibratedP: 0.05, ask: 0, isWinner: false }, // ask 0 → unusable
      { bucketIdx: 2, calibratedP: 0.05, ask: 1.5, isWinner: false }, // ask >1 → unusable
    ];
    expect(selectEntries(v)).toHaveLength(0);
  });

  it('honors the cheap threshold constant boundary (ask exactly 0.25 is NOT cheap)', () => {
    const v: BucketView[] = [
      { bucketIdx: 0, calibratedP: 0.9, ask: 0.8, isWinner: true }, // modal
      { bucketIdx: 1, calibratedP: 0.5, ask: CHEAP_LONGSHOT_MAX_ASK, isWinner: false }, // ask == 0.25 → not cheap
    ];
    const longs = selectEntries(v).filter((s) => s.arm === 'cheap_longshot');
    expect(longs).toHaveLength(0);
  });
});

describe('marketImpliedProbs — day-before asks renormalized to a distribution', () => {
  it('renormalizes present asks to sum 1; absent asks contribute 0', () => {
    const v: BucketView[] = [
      { bucketIdx: 0, calibratedP: 0, ask: 0.2, isWinner: false },
      { bucketIdx: 1, calibratedP: 0, ask: 0.6, isWinner: true },
      { bucketIdx: 2, calibratedP: 0, ask: null, isWinner: false },
    ];
    const mip = marketImpliedProbs(v)!;
    expect(mip.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(mip[0]!).toBeCloseTo(0.25, 9); // 0.2 / 0.8
    expect(mip[1]!).toBeCloseTo(0.75, 9); // 0.6 / 0.8
    expect(mip[2]!).toBe(0);
  });

  it('returns null when no bucket has a usable ask', () => {
    const v: BucketView[] = [
      { bucketIdx: 0, calibratedP: 0, ask: null, isWinner: false },
      { bucketIdx: 1, calibratedP: 0, ask: 0, isWinner: true },
    ];
    expect(marketImpliedProbs(v)).toBeNull();
  });
});
