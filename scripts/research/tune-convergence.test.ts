/**
 * Tests for scripts/research/tune-convergence — the pure decision helpers that drive the threshold tuner
 * (the DB/fs/main is exercised live, read-only). Pins: the TRAIN/TEST date split, the winner's-curse-aware
 * cell ranking tiers, the §9R-E floor predicates, the breakeven-spread interpolation, the archive index, and
 * the buildSet→engine seam. Plus the no-DB sanity() self-test.
 */
import { describe, expect, it } from 'vitest';
import {
  splitByDate,
  pickBest,
  rowPasses,
  rowSufficient,
  breakevenSpread,
  buildSet,
  sanity,
  type GridCell,
  type PanelEvent,
} from './tune-convergence.ts';
import type { TpSweepRow, EventReplayInput } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import type { ArchiveEvent } from '../../packages/core/src/sim/history-replay-ingest.ts';

const ev = (d: string): EventReplayInput => ({
  eventId: d, city: 'x', targetDate: d, tz: 'UTC', ticks: [], resolution: { winnerIdx: null, gradingMismatch: false },
});

const row = (over: Partial<TpSweepRow>): TpSweepRow => ({
  tpDeltaPp: 0.1, nEvents: 100, nExecuted: 80, executedFrac: 0.8, nMarkets: 50, nCities: 8, nDistinctDays: 9,
  winFrac: 0.6, meanNetReturn: 0.03, ciLow: 0.01, ciHigh: 0.05, zeroSkillPassRate: 0.02,
  ruleCaptureRoi: 0.03, avgBestReachableRoundtrip: 0.1, label: 'PASS', reason: '', ...over,
});
const cell = (rows: TpSweepRow[]): GridCell => ({
  selector: 'house_gaussian', spreadMult: 1, centerHalfWidth: 1, maxEntryPrice: 0.2, depthFloorUsd: 50, rows,
});

describe('splitByDate', () => {
  it('splits the earliest trainFrac of distinct dates into TRAIN', () => {
    const sp = splitByDate(['2026-06-13', '2026-06-14', '2026-06-15', '2026-06-16', '2026-06-17'].map(ev), 0.6);
    expect(sp.train.map((e) => e.targetDate)).toEqual(['2026-06-13', '2026-06-14', '2026-06-15']);
    expect(sp.test.map((e) => e.targetDate)).toEqual(['2026-06-16', '2026-06-17']);
    expect(sp.cutDate).toBe('2026-06-16');
  });
  it('keeps multiple events on the same date together', () => {
    const sp = splitByDate([ev('a'), ev('a'), ev('b'), ev('c')], 0.6);
    // 3 distinct dates, cut at idx 1 → TRAIN = date a (2 events), TEST = b,c
    expect(sp.train.length).toBe(2);
    expect(sp.test.length).toBe(2);
  });
  it('is total on a single date', () => {
    expect(splitByDate([ev('a')], 0.6).test.length).toBe(0);
  });
});

describe('rowPasses / rowSufficient', () => {
  it('rowPasses enforces counts + winFrac + ciLow>0', () => {
    expect(rowPasses(row({}))).toBe(true);
    expect(rowPasses(row({ ciLow: -0.001 }))).toBe(false);
    expect(rowPasses(row({ winFrac: 0.49 }))).toBe(false);
    expect(rowPasses(row({ nCities: 5 }))).toBe(false);
    expect(rowPasses(row({ nMarkets: 39 }))).toBe(false);
    expect(rowPasses(row({ nDistinctDays: 6 }))).toBe(false);
  });
  it('rowSufficient checks only the count floors', () => {
    expect(rowSufficient(row({ ciLow: -0.5, winFrac: 0.1 }))).toBe(true);
    expect(rowSufficient(row({ nDistinctDays: 6 }))).toBe(false);
  });
});

describe('pickBest tiers', () => {
  it('prefers PASS rows by max ciLow', () => {
    const p = pickBest([cell([row({ ciLow: 0.005 }), row({ tpDeltaPp: 0.2, ciLow: 0.02 })])]);
    expect(p?.basis).toContain('PASS in-sample');
    expect(p?.best.row.ciLow).toBeCloseTo(0.02, 9);
  });
  it('falls to closest-to-passing when nothing passes but counts suffice', () => {
    const p = pickBest([cell([row({ ciLow: -0.01, winFrac: 0.4 })])]);
    expect(p?.basis).toContain('closest-to-passing');
  });
  it('falls to descriptive-only (flagged not actionable) when counts are short', () => {
    const p = pickBest([cell([row({ nMarkets: 5, nDistinctDays: 2, label: 'INSUFFICIENT_DATA', ciLow: NaN, meanNetReturn: 0.5 })])]);
    expect(p?.basis).toContain('NOT actionable');
  });
  it('is null on empty', () => {
    expect(pickBest([])).toBeNull();
    expect(pickBest([cell([])])).toBeNull();
  });
});

describe('breakevenSpread', () => {
  it('interpolates the zero-crossing between bracketing knots', () => {
    expect(breakevenSpread([{ spreadMult: 0, meanNetReturn: 0.04 }, { spreadMult: 1, meanNetReturn: -0.04 }])).toBeCloseTo(0.5, 9);
    expect(breakevenSpread([{ spreadMult: 1, meanNetReturn: 0.02 }, { spreadMult: 2, meanNetReturn: -0.02 }])).toBeCloseTo(1.5, 9);
  });
  it('returns null when negative at spread 0 (no edge at any cost) or robust through the range', () => {
    expect(breakevenSpread([{ spreadMult: 0, meanNetReturn: -0.01 }, { spreadMult: 1, meanNetReturn: -0.05 }])).toBeNull();
    expect(breakevenSpread([{ spreadMult: 0, meanNetReturn: 0.05 }, { spreadMult: 2, meanNetReturn: 0.01 }])).toBeNull();
  });
});

describe('buildSet → engine seam', () => {
  it('assembles a seeded archive event into a non-empty EventReplayInput; drops the unseeded selector', () => {
    const archive: ArchiveEvent = {
      city: 'amsterdam', eventId: 'E', targetDate: '2026-06-21', createdAt: '2026-06-20T00:00:00Z', endDate: '2026-06-21T10:00:00Z',
      buckets: [
        { idx: 0, label: '20°C', resolvedOutcome: 'lose', points: Array.from({ length: 120 }, (_v, i) => [1750377600 + i * 60, 0.12]) },
        { idx: 1, label: '21°C', resolvedOutcome: 'win', points: Array.from({ length: 120 }, (_v, i) => [1750377600 + i * 60, 0.17]) },
        { idx: 2, label: '22°C', resolvedOutcome: 'lose', points: Array.from({ length: 120 }, (_v, i) => [1750377600 + i * 60, 0.12]) },
      ],
    };
    const p: PanelEvent = {
      eventId: 'E', city: 'amsterdam', tz: 'Europe/Amsterdam', targetDate: '2026-06-20', winnerIdx: 1, gradingMismatch: false,
      gaussian: new Map([[0, 0.2], [1, 0.5], [2, 0.2]]), ensemble: new Map(),
      archive, createdAtMs: new Date('2026-06-20T00:00:00Z').getTime(),
    };
    const g = buildSet([p], 'house_gaussian', 1, 10);
    expect(g.length).toBe(1);
    expect(g[0]!.ticks.length).toBeGreaterThan(0);
    expect(buildSet([p], 'house_ensemble', 1, 10).length).toBe(0); // no ensemble seed → dropped
  });
});

describe('sanity', () => {
  it('the no-DB self-test passes', () => {
    expect(() => sanity()).not.toThrow();
  });
});
