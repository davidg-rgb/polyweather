/**
 * Tests for core/sim/opening-maker-exit-view — the /maker-exit forward-paper view-model. Pins that it reuses the
 * tested maker-exit engine over the raw capture series, surfaces the three measured assumptions (maker-fill rate,
 * realized rebate, days/cities/markets), and renders the §9R-E gate; totality on junk.
 */
import { describe, expect, it } from 'vitest';
import { buildMakerExitView } from '../src/sim/opening-maker-exit-view.ts';
import { makerExitCfg } from '../src/sim/opening-maker-exit-replay.ts';
import { BOT_DEFAULTS } from '../src/sim/opening-convergence.ts';
import type { RawBucket, RawCaptureRow } from '../src/sim/opening-bracket-ingest.ts';
import type { RawResolution } from '../src/sim/opening-convergence-view.ts';

const DATE = '2026-06-20';
const RESOLVE = '2026-06-22T10:00:00Z'; // 2 days out → the 18h time-stop is far past the take-profit tick

// a 3-bucket ladder; bucket 1 is the seeded forecast center (houseProb 0.4), deep enough for the tuned $150 floor.
const bucket = (idx: number, over: Partial<RawBucket> = {}): RawBucket => ({
  idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.15, bestAsk: 0.16, execAsk: 0.16, depthUsd: 200,
  bestBid: 0.14, sellbackUsd: 200, execBid: 0.14, sellbackDepthUsd: 200, houseProb: idx === 1 ? 0.4 : 0.15,
  tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
});
const ladder = (center: Partial<RawBucket>): RawBucket[] => [bucket(0), bucket(1, center), bucket(2)];

const cap = (
  eventId: string, city: string, tz: string, capturedAt: string, age: number, center: Partial<RawBucket>,
): RawCaptureRow => ({
  eventId, capturedAt, city, targetDate: DATE, tzName: tz, createdAtGamma: '2026-06-19T23:54:00Z',
  resolvesAt: RESOLVE, hoursSinceListing: age, peakMid: 0.18, isFlatOpen: true, houseSeeded: true,
  buckets: ladder(center), evVol24h: 9000, negRisk: true,
});

/** a fresh event that enters maker (ask runs through the 0.16 limit on tick 2) then a buyer lifts the TP. */
const winningEvent = (eventId: string, city: string, tz: string): RawCaptureRow[] => [
  cap(eventId, city, tz, '2026-06-20T00:00:00Z', 0.1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }),
  cap(eventId, city, tz, '2026-06-20T00:10:00Z', 0.3, { execAsk: 0.12, bestAsk: 0.12, execBid: 0.11 }),
  cap(eventId, city, tz, '2026-06-20T01:00:00Z', 1.0, { execBid: 0.45, execAsk: 0.46, bestBid: 0.45, bestAsk: 0.46 }),
];

describe('buildMakerExitView', () => {
  it('renders entries + the measured assumptions + the §9R-E gate over the maker-exit ledger', () => {
    const captures = [
      ...winningEvent('A', 'amsterdam', 'Europe/Amsterdam'),
      ...winningEvent('B', 'chengdu', 'Asia/Shanghai'),
    ];
    const view = buildMakerExitView(captures, [], makerExitCfg(BOT_DEFAULTS.cities));

    expect(view.entries.length).toBe(2);
    expect(view.entries.every((e) => e.exitKind === 'maker_take_profit')).toBe(true);
    expect(view.entries.every((e) => e.status === 'realized')).toBe(true);
    expect(view.nFreshEvents).toBe(2);

    // the three measured assumptions (handoff §1)
    expect(view.assumptions.makerFillRate).toBe(1); // both took profit as makers
    expect(view.assumptions.nMarkets).toBe(2);
    expect(view.assumptions.nCities).toBe(2);
    expect(view.assumptions.nDistinctDays).toBe(1);
    expect(Number.isFinite(view.assumptions.meanObservedExitSpread)).toBe(true);
    expect(view.assumptions.rebateRateUsed).toBe(0); // the conservative fee-saving floor

    // money tracker + the tuned params surfaced
    expect(view.money.netPnlUsd).toBeGreaterThan(0);
    expect(view.money.nEntries).toBe(2);
    expect(view.tpDeltaPp).toBe(0.12);
    expect(view.tstopHoursBeforeResolve).toBe(18);

    // 2 markets < the §9R-E ≥40 floor → INSUFFICIENT by design
    expect(view.gate.label).toBe('INSUFFICIENT_DATA');
    expect(view.gate.minMarkets).toBe(40);
    expect(view.perDay).toHaveLength(1);
    expect(view.perDay[0]).toMatchObject({ date: DATE, considered: 2, entered: 2 });
  });

  it('drops non-fresh events (min hours_since_listing ≥ 1) from the considered universe', () => {
    // the same shape but listed long ago (all ages ≥ 1) → buildEvents' FRESH filter excludes it
    const stale = winningEvent('S', 'amsterdam', 'Europe/Amsterdam').map((r) => ({ ...r, hoursSinceListing: 5 }));
    const view = buildMakerExitView(stale, [], makerExitCfg(BOT_DEFAULTS.cities));
    expect(view.nFreshEvents).toBe(0);
    expect(view.entries.length).toBe(0);
  });

  it('is total on junk / empty input', () => {
    const view = buildMakerExitView([], [] as RawResolution[], makerExitCfg(BOT_DEFAULTS.cities));
    expect(view.entries.length).toBe(0);
    expect(view.gate.label).toBe('INSUFFICIENT_DATA');
    expect(view.money.nEntries).toBe(0);
    expect(Number.isNaN(view.assumptions.makerFillRate)).toBe(true);
  });
});
