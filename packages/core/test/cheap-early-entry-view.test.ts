/**
 * Tests for core/sim/cheap-early-entry-view — the /cheap-early forward-paper view-model. Pins that it reuses the
 * tested cheap-early engine over the raw capture series, surfaces the measured reads (net return + CI, win rate,
 * cost/depth), renders the §9R-E gate, drops non-fresh events, and parses the cheap_early config; totality on junk.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCheapEarlyView,
  parseCheapEarlyConfig,
} from '../src/sim/cheap-early-entry-view.ts';
import {
  cheapEarlyCfg,
  CANONICAL_VARIANT_ID,
  CHEAP_EARLY_CITIES,
  CHEAP_EARLY_VARIANTS,
} from '../src/sim/cheap-early-entry-replay.ts';
import type { RawBucket, RawCaptureRow } from '../src/sim/opening-bracket-ingest.ts';
import type { RawResolution } from '../src/sim/opening-convergence-view.ts';

const DATE = '2026-06-22';
const RESOLVE = '2026-06-22T00:00:00Z';
// a capture 30h before resolution → hours-to-close 30 ∈ [24,36]; hoursSinceListing 0.5 → FRESH (min < 1).
const IN_WINDOW = '2026-06-20T18:00:00Z';

const bucket = (idx: number, over: Partial<RawBucket> = {}): RawBucket => ({
  idx, label: `${20 + idx}°C`, loF: null, hiF: null, mid: 0.24, bestAsk: 0.25, execAsk: 0.25, depthUsd: 200,
  bestBid: 0.24, sellbackUsd: 200, execBid: 0.24, sellbackDepthUsd: 200, houseProb: idx === 1 ? 0.4 : 0.15,
  tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
});
const ladder = (center: Partial<RawBucket> = {}): RawBucket[] => [bucket(0), bucket(1, center), bucket(2)];

const cap = (eventId: string, city: string, tz: string, capturedAt: string, age: number, center: Partial<RawBucket> = {}): RawCaptureRow => ({
  eventId, capturedAt, city, targetDate: DATE, tzName: tz, createdAtGamma: '2026-06-20T17:30:00Z',
  resolvesAt: RESOLVE, hoursSinceListing: age, peakMid: 0.25, isFlatOpen: false, houseSeeded: true,
  buckets: ladder(center), evVol24h: 9000, negRisk: true,
});

/** a fresh, in-window event: one tick, hours-to-close 30, ask 0.25, depth ample. */
const freshEvent = (eventId: string, city: string, tz: string, center: Partial<RawBucket> = {}): RawCaptureRow[] => [
  cap(eventId, city, tz, IN_WINDOW, 0.5, center),
];

describe('buildCheapEarlyView', () => {
  it('renders entries + the measured reads + the §9R-E gate over the cheap-early ledger', () => {
    const captures = [
      ...freshEvent('A', 'helsinki', 'Europe/Helsinki'),
      ...freshEvent('B', 'ankara', 'Europe/Istanbul'),
    ];
    // A wins (winner idx 1 == the pick), B loses (winner idx 0).
    const resolutions: RawResolution[] = [
      { id: 'A', winnerIdx: 1, gradingMismatch: false },
      { id: 'B', winnerIdx: 0, gradingMismatch: false },
    ];
    const view = buildCheapEarlyView(captures, resolutions, cheapEarlyCfg([...CHEAP_EARLY_CITIES]));

    expect(view.entries.length).toBe(2);
    expect(view.entries.every((e) => e.status === 'realized')).toBe(true);
    expect(view.nConsidered).toBe(2);
    expect(view.entries.find((e) => e.city === 'helsinki')!.won).toBe(true);
    expect(view.entries.find((e) => e.city === 'ankara')!.won).toBe(false);

    // the frozen params surfaced
    expect(view.windowLoH).toBe(24);
    expect(view.windowHiH).toBe(36);
    expect(view.askBandLo).toBe(0.2);
    expect(view.askBandHi).toBe(0.33);
    expect(view.stakeUsd).toBe(20);

    // the measured reads: 2 markets → INSUFFICIENT (< 40); cost/depth confirmed
    expect(view.assumptions.nMarkets).toBe(2);
    expect(view.assumptions.nCities).toBe(2);
    // the RUNNING mean net-return is finite from the first realized trade (usable day one), while the rigorous
    // gate CI stays NaN until the sufficiency floor.
    expect(Number.isFinite(view.assumptions.meanNetReturn)).toBe(true);
    expect(Number.isNaN(view.gate.ciLow)).toBe(true);
    expect(view.assumptions.winRate).toBeCloseTo(0.5, 9);
    expect(view.assumptions.meanEntryAsk).toBeCloseTo(0.25, 9);
    expect(view.assumptions.meanDepthUsd).toBeCloseTo(200, 6);
    expect(view.assumptions.meanObservedSpread).toBeCloseTo(0.01, 9); // 0.25 − 0.24
    expect(view.assumptions.firePct).toBeCloseTo(1, 9); // both considered entered

    // money tracker
    expect(view.money.nEntries).toBe(2);
    expect(view.money.perEntryStakeUsd).toBe(20);
    expect(view.money.deployedUsd).toBeCloseTo(40, 6);

    // gate
    expect(view.gate.label).toBe('INSUFFICIENT_DATA');
    expect(view.gate.minMarkets).toBe(40);
    expect(view.perDay).toHaveLength(1);
    expect(view.perDay[0]).toMatchObject({ date: DATE, considered: 2, entered: 2 });
  });

  it('tallies non-entries: an out-of-band pick is considered but not entered', () => {
    const captures = [
      ...freshEvent('A', 'helsinki', 'Europe/Helsinki'),
      ...freshEvent('C', 'wellington', 'Pacific/Auckland', { bestAsk: 0.9, execAsk: 0.9 }), // out of band
    ];
    const view = buildCheapEarlyView(captures, [{ id: 'A', winnerIdx: 1, gradingMismatch: false }], cheapEarlyCfg([...CHEAP_EARLY_CITIES]));
    expect(view.nConsidered).toBe(2);
    expect(view.entries.length).toBe(1);
    expect(view.assumptions.reasonTally.ask_out_of_band).toBe(1);
  });

  it('drops non-fresh events (min hours_since_listing ≥ 1)', () => {
    const stale = freshEvent('S', 'helsinki', 'Europe/Helsinki').map((r) => ({ ...r, hoursSinceListing: 5 }));
    const view = buildCheapEarlyView(stale, [], cheapEarlyCfg([...CHEAP_EARLY_CITIES]));
    expect(view.nConsidered).toBe(0);
    expect(view.entries.length).toBe(0);
  });

  it('is total on junk input (empty → empty sections, no throw)', () => {
    const view = buildCheapEarlyView([], [], cheapEarlyCfg([...CHEAP_EARLY_CITIES]));
    expect(view.entries).toEqual([]);
    expect(view.gate.label).toBe('INSUFFICIENT_DATA');
    expect(view.money.nEntries).toBe(0);
  });
});

describe('buildCheapEarlyView — the pre-registered variant sweep (CHEAP-EARLY-IMPROVE.md §8)', () => {
  it('emits one block per registered variant, canonical first, with the top-level view UNCHANGED', () => {
    const captures = [
      ...freshEvent('A', 'helsinki', 'Europe/Helsinki'),
      ...freshEvent('B', 'ankara', 'Europe/Istanbul'),
    ];
    const resolutions: RawResolution[] = [
      { id: 'A', winnerIdx: 1, gradingMismatch: false },
      { id: 'B', winnerIdx: 0, gradingMismatch: false },
    ];
    const cfg = cheapEarlyCfg([...CHEAP_EARLY_CITIES]);
    const view = buildCheapEarlyView(captures, resolutions, cfg);

    expect(view.variants.map((v) => v.id)).toEqual(CHEAP_EARLY_VARIANTS.map((v) => v.id));
    expect(view.variants).toHaveLength(6);
    expect(view.variantsCommon.windowUnion).toEqual({ loH: 12, hiH: 36 });
    expect(view.variantsCommon.cityHitRatesAvailable).toBe(false);

    // the CANONICAL block IS the headline panel — the gate-of-record view can never disagree with its own row.
    const canonical = view.variants.find((v) => v.id === CANONICAL_VARIANT_ID)!;
    expect(canonical.nExecuted).toBe(view.money.nEntries);
    expect(canonical.gate).toEqual(view.gate);
    expect(canonical.meanNetReturn).toBeCloseTo(view.assumptions.meanNetReturn, 12);
    expect(canonical.entries.map((e) => e.city).sort()).toEqual(['ankara', 'helsinki']);

    // and the top-level sections are byte-identical to the pre-variant build (no variant leaks into them).
    const baseline = buildCheapEarlyView(captures, resolutions, cfg, { variants: [] });
    expect(baseline.variants).toEqual([]);
    expect({ ...view, variants: [], variantsCommon: baseline.variantsCommon }).toEqual(baseline);
  });

  it('a top-K variant without city hit rates scores NOTHING and says why (fail-closed)', () => {
    const captures = [...freshEvent('A', 'helsinki', 'Europe/Helsinki')];
    const view = buildCheapEarlyView(captures, [{ id: 'A', winnerIdx: 1, gradingMismatch: false }], cheapEarlyCfg([...CHEAP_EARLY_CITIES]));
    const survivor = view.variants.find((v) => v.id === 'survivor')!;
    expect(survivor.cfg.scoredCities).toEqual([]);
    expect(survivor.nExecuted).toBe(0);
    expect(survivor.verdict).toBe('INSUFFICIENT');
    expect(survivor.gate.reason).toBe('no city hit rates');
  });

  it('DEAD: a variant that clears the market floor with a wholly-negative city CI is pruned', () => {
    // 42 markets across 6 cities × 7 days, every one a LOSS → the clustered CI cannot include 0.
    const cities = ['ankara', 'helsinki', 'kuala-lumpur', 'wellington', 'madrid', 'singapore'];
    const captures: RawCaptureRow[] = [];
    const resolutions: RawResolution[] = [];
    for (let d = 0; d < 7; d++) {
      for (const city of cities) {
        const id = `${city}-${d}`;
        // the winner is bucket 0; the house pick is bucket 1 → every entry loses.
        captures.push({ ...cap(id, city, 'Europe/Helsinki', IN_WINDOW, 0.5), targetDate: `2026-06-${String(10 + d).padStart(2, '0')}` });
        resolutions.push({ id, winnerIdx: 0, gradingMismatch: false });
      }
    }
    const view = buildCheapEarlyView(captures, resolutions, cheapEarlyCfg(cities));
    const canonical = view.variants.find((v) => v.id === CANONICAL_VARIANT_ID)!;
    expect(canonical.nRealized).toBe(42);
    expect(canonical.nCities).toBe(6);
    expect(canonical.nDays).toBe(7);
    expect(canonical.ciHigh).toBeLessThan(0);
    expect(canonical.verdict).toBe('DEAD');
    // and the gate of record still reads its own §9R-E label — DEAD is a VARIANT-layer prune, not a new label.
    expect(view.gate.label).toBe('KILL');
  });
});

describe('parseCheapEarlyConfig', () => {
  it('defaults to the frozen 4 live cities and enabled', () => {
    const c = parseCheapEarlyConfig([]);
    expect(c.cities).toEqual(['ankara', 'helsinki', 'kuala-lumpur', 'wellington']);
    expect(c.enabled).toBe(true);
  });

  it('parses a JSON-array city widening', () => {
    const c = parseCheapEarlyConfig([{ key: 'cheap_early.cities', value: '["ankara","paris","madrid"]' }]);
    expect(c.cities).toEqual(['ankara', 'paris', 'madrid']);
  });

  it('parses a comma-separated city widening', () => {
    const c = parseCheapEarlyConfig([{ key: 'cheap_early.cities', value: 'ankara, paris , madrid' }]);
    expect(c.cities).toEqual(['ankara', 'paris', 'madrid']);
  });

  it('honors the enabled pause and falls back on bad JSON', () => {
    expect(parseCheapEarlyConfig([{ key: 'cheap_early.enabled', value: '0' }]).enabled).toBe(false);
    expect(parseCheapEarlyConfig([{ key: 'cheap_early.enabled', value: 'false' }]).enabled).toBe(false);
    const bad = parseCheapEarlyConfig([{ key: 'cheap_early.cities', value: '[not json' }]);
    expect(bad.cities).toEqual(['ankara', 'helsinki', 'kuala-lumpur', 'wellington']); // fell back to the default
  });
});
