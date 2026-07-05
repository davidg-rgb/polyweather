/**
 * Pure units for the /maker-exit assumptions-over-time sparklines (maker-exit-trend.ts). The load-bearing
 * property is the HONEST-NULL contract: a NaN/null assumption becomes a null POINT (a line break), never a 0,
 * while a real 0 is preserved. Plus the spec pins the fill-rate 0.30 warning / 0.49 backtest reference lines.
 */
import { describe, expect, it } from 'vitest';
import type { MakerExitHistoryPoint } from '../src/lib/loaders.ts';
import {
  MAKER_EXIT_TREND_SPECS,
  TREND_MAX_CITY_ERRORS,
  TREND_MIN_MARKETS,
  coerceFinite,
  filterTrendPoints,
  hasAnyFinite,
  isDegradedTrendPoint,
  lastFinite,
  seriesDomain,
  toSeries,
  type TrendSpec,
} from '../src/lib/maker-exit-trend.ts';

const pt = (makerFillRate: number | null, realizedRebateUsd: number | null = null): MakerExitHistoryPoint =>
  ({
    capturedAt: '2026-07-04T12:00:00Z',
    makerFillRate,
    meanMakerFillLatencyTicks: null,
    realizedRebateUsd,
    rebateRateUsed: null,
    meanObservedEntrySpread: null,
    meanObservedExitSpread: null,
    qualifyingTickFrac: null,
    nQualifyingRestingTicks: null,
    nRestingTicks: null,
    meanDistFromMidPp: null,
    fracWithinAdvertisedBand: null,
    fracFailsMinSize: null,
    dominantDisqualifier: null,
    nMarkets: null,
    nCities: null,
    nDistinctDays: null,
    cityErrors: null,
  }) as MakerExitHistoryPoint;

describe('coerceFinite', () => {
  it('passes finite numbers (incl. a real 0) and coerces numeric strings', () => {
    expect(coerceFinite(0.49)).toBe(0.49);
    expect(coerceFinite(0)).toBe(0); // a REAL zero survives — distinct from a null gap
    expect(coerceFinite('0.42')).toBeCloseTo(0.42, 6);
  });
  it('maps null / NaN / non-numeric to null (a line break, never a zero)', () => {
    expect(coerceFinite(null)).toBeNull();
    expect(coerceFinite(undefined)).toBeNull();
    expect(coerceFinite(Number.NaN)).toBeNull();
    expect(coerceFinite('band')).toBeNull();
  });
});

describe('toSeries — null-preserving column extraction', () => {
  it('keeps nulls as nulls and coerces the rest, aligned to snapshot order', () => {
    const s = toSeries([pt(null), pt(0.42), pt(0.49)], 'makerFillRate');
    expect(s).toEqual([null, 0.42, 0.49]);
  });
  it('a real 0 stays 0 (not confused with the null gap)', () => {
    const s = toSeries([pt(null, 0), pt(null, 2.4)], 'realizedRebateUsd');
    expect(s).toEqual([0, 2.4]);
  });
});

describe('seriesDomain', () => {
  const fillSpec = MAKER_EXIT_TREND_SPECS.find((s) => s.key === 'makerFillRate')!;
  const rebateSpec = MAKER_EXIT_TREND_SPECS.find((s) => s.key === 'realizedRebateUsd')!;
  it('honours a fixed [0,1] domain regardless of data', () => {
    expect(seriesDomain([0.1, 0.9], fillSpec)).toEqual([0, 1]);
  });
  it('derives [min,max] over finite values ∪ 0 for an unpinned metric', () => {
    expect(seriesDomain([1.1, 2.4, null], rebateSpec)).toEqual([0, 2.4]);
  });
  it('degenerate (all equal / empty) domain widens by 1 so the axis never collapses', () => {
    expect(seriesDomain([], rebateSpec)).toEqual([0, 1]);
  });
});

describe('lastFinite / hasAnyFinite', () => {
  it('lastFinite skips trailing nulls', () => {
    expect(lastFinite([0.3, 0.42, null])).toBe(0.42);
    expect(lastFinite([null, null])).toBeNull();
  });
  it('hasAnyFinite is false for an all-null series (drives the no-data card)', () => {
    expect(hasAnyFinite([null, null])).toBe(false);
    expect(hasAnyFinite([null, 0])).toBe(true); // a real 0 counts as data
  });
});

describe('filterTrendPoints / isDegradedTrendPoint — the #21 degradation floor', () => {
  const healthy = (over: Partial<MakerExitHistoryPoint> = {}): MakerExitHistoryPoint => ({
    ...pt(0.42),
    nMarkets: 60,
    cityErrors: 0,
    ...over,
  });

  it('pins the floor to the gate contract: 40 markets / ≤2 city errors', () => {
    expect(TREND_MIN_MARKETS).toBe(40);
    expect(TREND_MAX_CITY_ERRORS).toBe(2);
  });

  it('keeps a healthy snapshot (nMarkets ≥ 40, cityErrors ≤ 2)', () => {
    expect(isDegradedTrendPoint(healthy())).toBe(false);
    expect(isDegradedTrendPoint(healthy({ cityErrors: 2 }))).toBe(false); // boundary: 2 errors tolerated
    expect(isDegradedTrendPoint(healthy({ nMarkets: 40 }))).toBe(false); // boundary: exactly the gate floor
  });

  it('excludes a partial-view snapshot (cityErrors > 2 — the 07-05 1-of-73-cities incident shape)', () => {
    expect(isDegradedTrendPoint(healthy({ cityErrors: 3 }))).toBe(true);
    expect(isDegradedTrendPoint(healthy({ cityErrors: 72 }))).toBe(true);
  });

  it('excludes a below-gate-floor sample (nMarkets < 40 or unknown)', () => {
    expect(isDegradedTrendPoint(healthy({ nMarkets: 39 }))).toBe(true);
    expect(isDegradedTrendPoint(healthy({ nMarkets: 1 }))).toBe(true); // the crater case: 0.0/1.0 over ≤2 exits
    expect(isDegradedTrendPoint(healthy({ nMarkets: null }))).toBe(true); // unknown sample = not trend-worthy
  });

  it('a null cityErrors (pre-0084 snapshot) is UNKNOWN, not degraded — only the sample floor applies', () => {
    expect(isDegradedTrendPoint(healthy({ cityErrors: null }))).toBe(false);
    expect(isDegradedTrendPoint(healthy({ cityErrors: null, nMarkets: 10 }))).toBe(true);
  });

  it('filterTrendPoints preserves order and counts the excluded', () => {
    const points = [healthy(), healthy({ cityErrors: 9 }), healthy({ nMarkets: 5 }), healthy({ makerFillRate: 0.5 })];
    const { points: kept, excluded } = filterTrendPoints(points);
    expect(kept).toHaveLength(2);
    expect(excluded).toBe(2);
    expect(kept[0]).toBe(points[0]);
    expect(kept[1]).toBe(points[3]);
  });

  it('junk in → empty out, no throwing (the component contract)', () => {
    expect(filterTrendPoints(undefined as unknown as MakerExitHistoryPoint[])).toEqual({ points: [], excluded: 0 });
    expect(filterTrendPoints([])).toEqual({ points: [], excluded: 0 });
  });

  it('the degraded crater never reaches the headline: lastFinite over the FILTERED series skips it', () => {
    // a healthy 0.42 history followed by a degraded 1-market tick reading 0.0 — the pre-#21 bug headlined 0% RED.
    const points = [healthy(), healthy({ makerFillRate: 0.44 }), healthy({ makerFillRate: 0, nMarkets: 1, cityErrors: 72 })];
    const { points: kept } = filterTrendPoints(points);
    expect(lastFinite(toSeries(kept, 'makerFillRate'))).toBe(0.44);
  });
});

describe('MAKER_EXIT_TREND_SPECS — the small-multiples contract', () => {
  it('charts the three assumptions + the three WHY fields (categorical dominantDisqualifier excluded)', () => {
    const keys = MAKER_EXIT_TREND_SPECS.map((s) => s.key);
    expect(keys).toEqual([
      'makerFillRate',
      'realizedRebateUsd',
      'qualifyingTickFrac',
      'meanDistFromMidPp',
      'fracWithinAdvertisedBand',
      'fracFailsMinSize',
    ]);
  });
  it('the fill-rate line carries the 0.30 warning + 0.49 backtest reference lines', () => {
    const fill = MAKER_EXIT_TREND_SPECS.find((s) => s.key === 'makerFillRate') as TrendSpec;
    expect(fill.refLines).toEqual([
      { y: 0.3, label: '0.30 warn', tone: 'warn' },
      { y: 0.49, label: '0.49 backtest', tone: 'ref' },
    ]);
  });
  it('no other metric carries reference lines', () => {
    const others = MAKER_EXIT_TREND_SPECS.filter((s) => s.key !== 'makerFillRate');
    expect(others.every((s) => !s.refLines)).toBe(true);
  });
});
