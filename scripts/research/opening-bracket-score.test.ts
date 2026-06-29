/**
 * Tests for the bracket-EXIT scorer (scripts/research/opening-bracket-score.ts) — the screen that says whether
 * SELLING into the convergence before resolution nets positive. Its pure core lives in
 * packages/core/sim/opening-bracket-replay.ts (covered by that package's vitest); this file brings the harness
 * seam into CI — the raw→core row mapping, the DB-free grouping + FRESH-universe filter, report() totality, and
 * the CLI-time sanity() self-test (mirrors opening-resolution-score.test.ts, which moved its sanity() into CI).
 */
import { describe, expect, it } from 'vitest';
import {
  buildEvents,
  mapBucket,
  report,
  sanity,
  DEFAULT_TPS,
  type RawBucket,
  type RawCaptureRow,
  type Resolution,
} from './opening-bracket-score.ts';
import { replayPanel } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import { BOT_DEFAULTS, type OpeningCfg } from '../../packages/core/src/sim/opening-convergence.ts';

const cfg: OpeningCfg = { ...BOT_DEFAULTS, cities: ['amsterdam'], depthFloorUsd: 50, takerFeeRate: 0.05 };

const rawBucket = (over: Partial<RawBucket> = {}): RawBucket => ({
  idx: 2, label: '21C', loF: 70, hiF: 71, mid: 0.1, bestAsk: 0.12, execAsk: 0.18, depthUsd: 100,
  bestBid: 0.09, sellbackUsd: 100, execBid: 0.1, sellbackDepthUsd: 100, houseProb: 0.35,
  tokenYes: 'y', tokenNo: 'n', conditionId: 'c', ...over,
});

const rawRow = (over: Partial<RawCaptureRow> = {}): RawCaptureRow => ({
  eventId: 'R', capturedAt: '2026-06-28T08:00:00.000Z', city: 'amsterdam', targetDate: '2026-06-28',
  tzName: 'Europe/Amsterdam', createdAtGamma: null, resolvesAt: null, hoursSinceListing: 0.2, peakMid: 0.1,
  isFlatOpen: true, houseSeeded: true, buckets: [rawBucket()], evVol24h: 5000, negRisk: true, ...over,
});

describe('mapBucket — raw jsonb → core OpeningBucket', () => {
  it('maps camelCase fields and coalesces nulls (numOrNull / num0 / String)', () => {
    const m = mapBucket(rawBucket({ idx: 3, execAsk: null, depthUsd: null, houseProb: 0.4, label: null }));
    expect(m.idx).toBe(3);
    expect(m.execAsk).toBeNull(); // numOrNull preserves null
    expect(m.depthUsd).toBe(0); // num0 floors null → 0
    expect(m.houseProb).toBeCloseTo(0.4, 9);
    expect(m.label).toBe(''); // String(null ?? '')
    expect(m.execBid).toBeCloseTo(0.1, 9);
  });
});

describe('buildEvents — grouping, ordering, FRESH filter, resolution wiring (DB-free)', () => {
  it('groups a multi-tick event ordered ASC by capturedAt and wires its resolution', () => {
    const rows = [
      rawRow({ eventId: 'R', capturedAt: '2026-06-28T08:30:00.000Z', hoursSinceListing: 0.7 }),
      rawRow({ eventId: 'R', capturedAt: '2026-06-28T08:00:00.000Z', hoursSinceListing: 0.2 }),
    ];
    const events = buildEvents(rows, new Map<string, Resolution>([['R', { winnerIdx: 2, gradingMismatch: false }]]));
    expect(events).toHaveLength(1);
    expect(events[0]!.ticks.map((t) => t.capturedAt)).toEqual([
      '2026-06-28T08:00:00.000Z',
      '2026-06-28T08:30:00.000Z',
    ]); // sorted ascending despite reversed input
    expect(events[0]!.ticks[0]!.buckets[0]!.execAsk).toBe(0.18);
    expect(events[0]!.resolution.winnerIdx).toBe(2);
  });

  it('drops a NON-fresh event (min hours_since_listing ≥ 1) and defaults a missing resolution', () => {
    expect(buildEvents([rawRow({ eventId: 'Z', hoursSinceListing: 5 })], new Map())).toHaveLength(0);
    const events = buildEvents([rawRow({ eventId: 'F', hoursSinceListing: 0.2 })], new Map());
    expect(events).toHaveLength(1);
    expect(events[0]!.resolution).toEqual({ winnerIdx: null, gradingMismatch: false }); // unresolved default
  });

  it('is total on empty / null-eventId rows', () => {
    expect(buildEvents([], new Map())).toEqual([]);
    expect(buildEvents([rawRow({ eventId: null })], new Map())).toEqual([]);
  });
});

describe('report — totality over the pure-engine panel', () => {
  it('does not throw on an empty panel (INSUFFICIENT by design)', () => {
    const panel = replayPanel([], cfg, DEFAULT_TPS);
    expect(() => report(panel, 0.05, 50, () => {})).not.toThrow();
    expect(panel.headlineTp).toBe(cfg.tpDeltaPp);
    expect(panel.perTp[0]!.label).toBe('INSUFFICIENT_DATA');
  });
});

describe('sanity — the CLI self-test passes (no DB, no network)', () => {
  it('runs clean', () => {
    expect(() => sanity()).not.toThrow();
  });
});
