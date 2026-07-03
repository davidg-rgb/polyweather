import { describe, expect, it } from 'vitest';
import {
  selectEntries,
  bucketEdge,
  brierSharperP,
  marketImpliedProbs,
  CHEAP_LONGSHOT_MAX_ASK,
  EmosStation,
  type BucketView,
} from './db1-daybefore-efficiency.ts';
import { parseConfigRows } from '../../packages/core/src/index.ts';

describe('brierSharperP — sign convention (review fix [9]: small p ⇒ OURS sharper)', () => {
  it('returns a SMALL p when ours is unambiguously sharper (lower Brier)', () => {
    const ours = Array.from({ length: 40 }, () => 0.1);
    const market = Array.from({ length: 40 }, () => 0.6);
    expect(brierSharperP(ours, market)).toBeLessThan(0.05);
  });

  it('returns a LARGE p when the MARKET is sharper (the EFFICIENT-verdict case)', () => {
    const ours = Array.from({ length: 40 }, () => 0.6);
    const market = Array.from({ length: 40 }, () => 0.1);
    expect(brierSharperP(ours, market)).toBeGreaterThan(0.95);
  });
});

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
    const mip = marketImpliedProbs(v, 1)!; // winner = pos 1 (has an ask)
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
    expect(marketImpliedProbs(v, 1)).toBeNull();
  });

  it('drops the event when the WINNER bucket has no day-before ask (review fix [10])', () => {
    // Other buckets are quoted (sum > 0) but the bucket that resolved has no ask. The pre-fix returned a
    // distribution with P(winner)=0, handing the market a guaranteed +1 Brier penalty on the winning outcome.
    const v: BucketView[] = [
      { bucketIdx: 0, calibratedP: 0, ask: 0.4, isWinner: false },
      { bucketIdx: 1, calibratedP: 0, ask: null, isWinner: true }, // winner unquoted
    ];
    expect(marketImpliedProbs(v, 1)).toBeNull();
    // …but a quoted winner alongside an unquoted loser still yields a distribution.
    const v2: BucketView[] = [
      { bucketIdx: 0, calibratedP: 0, ask: null, isWinner: false },
      { bucketIdx: 1, calibratedP: 0, ask: 0.4, isWinner: true },
    ];
    expect(marketImpliedProbs(v2, 1)).not.toBeNull();
  });
});

describe('EmosStation.disagreement — the cross-model spread feature (SIGNAL-BACKLOG.md #3, reused from l3b)', () => {
  const cfg = parseConfigRows([]); // defaults: sigmaMinN=8, biasAlpha=0.15, sigmaWindowDays=30

  it('is null until at least 2 models clear sigmaMinN trailing observations', () => {
    const s = new EmosStation(cfg);
    // fold only 7 days (< sigmaMinN=8) for two models — neither qualifies yet
    for (let i = 0; i < 7; i++) s.fold([{ model: 'a', f: 20 }, { model: 'b', f: 21 }], 1, 20);
    expect(s.disagreement([{ model: 'a', f: 20 }, { model: 'b', f: 21 }], 1)).toBeNull();
  });

  it('is null with only ONE qualifying model (no spread to measure)', () => {
    const s = new EmosStation(cfg);
    for (let i = 0; i < 10; i++) s.fold([{ model: 'a', f: 20 }], 1, 20);
    expect(s.disagreement([{ model: 'a', f: 20 }], 1)).toBeNull();
  });

  it('is 0 when every qualifying model agrees exactly (no disagreement)', () => {
    const s = new EmosStation(cfg);
    for (let i = 0; i < 10; i++) s.fold([{ model: 'a', f: 20 }, { model: 'b', f: 20 }], 1, 20);
    expect(s.disagreement([{ model: 'a', f: 20 }, { model: 'b', f: 20 }], 1)).toBeCloseTo(0, 9);
  });

  it('grows with the spread of the CORRECTED points (bias-adjusted, not raw)', () => {
    const s = new EmosStation(cfg);
    // model 'a' consistently reads +2 hot, 'b' reads true — both converge to ~0 bias-corrected residual,
    // but a fresh disagreement CALL with a wide raw split should still show a non-trivial corrected spread.
    for (let i = 0; i < 10; i++) s.fold([{ model: 'a', f: 22 }, { model: 'b', f: 20 }], 1, 20);
    const tight = s.disagreement([{ model: 'a', f: 22 }, { model: 'b', f: 20 }], 1)!;
    const wide = s.disagreement([{ model: 'a', f: 30 }, { model: 'b', f: 20 }], 1)!;
    expect(wide).toBeGreaterThan(tight);
  });

  it('is per-lead (a model with only lead-2 history does not qualify at lead-1)', () => {
    const s = new EmosStation(cfg);
    for (let i = 0; i < 10; i++) s.fold([{ model: 'a', f: 20 }, { model: 'b', f: 20 }], 2, 20);
    expect(s.disagreement([{ model: 'a', f: 20 }, { model: 'b', f: 20 }], 1)).toBeNull();
  });
});
