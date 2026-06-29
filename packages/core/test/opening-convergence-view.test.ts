/**
 * Tests for buildConvergenceView (core/sim/opening-convergence-view) — the /convergence page view-model.
 * The bracket engine + the raw mappers are covered by their own suites; this exercises the AGGREGATION the
 * page renders: entry logging, exit-kind classification, per-day chances, the fictive money tracker, and the
 * §9R-E gate counts. Builds a tiny synthetic capture series (a take-profit + an open/marked position).
 */
import { describe, expect, it } from 'vitest';
import { BOT_DEFAULTS, type OpeningCfg } from '../src/sim/opening-convergence.ts';
import { buildConvergenceView } from '../src/sim/opening-convergence-view.ts';
import type { RawBucket, RawCaptureRow } from '../src/sim/opening-bracket-ingest.ts';

const cfg: OpeningCfg & { perPositionUsd: number } = { ...BOT_DEFAULTS, cities: ['amsterdam'], depthFloorUsd: 50, takerFeeRate: 0.05 };
const TZ = 'Europe/Amsterdam'; // CEST → station-local noon = 10:00Z
const DATE = '2026-06-28';

const bucket = (idx: number, over: Partial<RawBucket> = {}): RawBucket => ({
  idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.1, bestAsk: 0.11, execAsk: 0.11, depthUsd: 100,
  bestBid: 0.09, sellbackUsd: 100, execBid: 0.1, sellbackDepthUsd: 100, houseProb: 0.1,
  tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
});

/** a 5-bucket ladder whose mode is idx2 (houseProb 0.35); `center` overrides idx2. */
const ladder = (center: Partial<RawBucket> = {}): RawBucket[] => [
  bucket(0), bucket(1, { houseProb: 0.2 }), bucket(2, { houseProb: 0.35, ...center }), bucket(3, { houseProb: 0.2 }), bucket(4),
];

const row = (eventId: string, capturedAt: string, age: number, center: Partial<RawBucket> = {}): RawCaptureRow => ({
  eventId, capturedAt, city: 'amsterdam', targetDate: DATE, tzName: TZ, createdAtGamma: null, resolvesAt: null,
  hoursSinceListing: age, peakMid: 0.1, isFlatOpen: true, houseSeeded: true, buckets: ladder(center), evVol24h: 5000, negRisk: true,
});

describe('buildConvergenceView — the /convergence page view-model', () => {
  // TP event: maker-fill at 0.12 then execBid re-rates to 0.45 ⇒ take-profit (≥ modelProb 0.35).
  const tpEvent: RawCaptureRow[] = [
    row('TP', '2026-06-28T08:00:00.000Z', 0.2, { execAsk: 0.18, bestAsk: 0.12, execBid: 0.1 }),
    row('TP', '2026-06-28T08:00:30.000Z', 0.3, { execAsk: 0.11, execBid: 0.1 }),
    row('TP', '2026-06-28T08:01:00.000Z', 0.35, { execBid: 0.45 }),
  ];
  // OPEN event: maker-fill at 0.12, execBid holds at 0.10 (between SL 0.06 and TP) ⇒ unresolved mark-to-bid.
  const openEvent: RawCaptureRow[] = [
    row('OPEN', '2026-06-28T08:00:00.000Z', 0.2, { execAsk: 0.18, bestAsk: 0.12, execBid: 0.1 }),
    row('OPEN', '2026-06-28T08:00:30.000Z', 0.3, { execAsk: 0.11, execBid: 0.1 }),
  ];

  const view = buildConvergenceView([...tpEvent, ...openEvent], [], cfg);

  it('logs one entry per entered market with the engine fill + exit', () => {
    expect(view.nFreshEvents).toBe(2);
    expect(view.entries).toHaveLength(2);
    const tp = view.entries.find((e) => e.eventId === 'TP')!;
    const op = view.entries.find((e) => e.eventId === 'OPEN')!;
    expect(tp.exitKind).toBe('take_profit');
    expect(tp.status).toBe('realized');
    expect(tp.isMaker).toBe(true);
    expect(tp.entryPrice).toBeCloseTo(0.12, 9);
    expect(tp.netPnlUsd).toBeGreaterThan(0);
    expect(op.exitKind).toBe('open_marked');
    expect(op.status).toBe('open');
    expect(op.netPnlUsd).toBeLessThan(0); // bought 0.12, marked 0.10
  });

  it('builds the fictive money tracker at the recommended per-entry stake', () => {
    const m = view.money;
    expect(m.perEntryStakeUsd).toBe(cfg.perPositionUsd); // $20, depth-gated
    expect(m.nEntries).toBe(2);
    expect(m.nRealized).toBe(1);
    expect(m.nOpen).toBe(1);
    expect(m.nWins).toBe(1);
    expect(m.nLosses).toBe(0);
    expect(m.winRate).toBeCloseTo(1, 9);
    expect(m.deployedUsd).toBeCloseTo(40, 0); // 2 × ~$20
    expect(m.netPnlUsd).toBeCloseTo(m.realizedPnlUsd + m.openMarkedPnlUsd, 6);
    expect(m.equity).toHaveLength(1); // one target day
    expect(m.equity[0]!.cumUsd).toBeCloseTo(m.netPnlUsd, 6);
  });

  it('computes per-day chances (considered vs entered, fire rate)', () => {
    expect(view.perDay).toHaveLength(1);
    expect(view.perDay[0]!.date).toBe(DATE);
    expect(view.perDay[0]!.considered).toBe(2);
    expect(view.perDay[0]!.entered).toBe(2);
    expect(view.perDay[0]!.firePct).toBeCloseTo(1, 9);
  });

  it('exposes the TP sweep + a recommended (exploratory) TP and the §9R-E gate counts', () => {
    expect(view.tuning.length).toBeGreaterThan(0);
    expect(view.tuning.some((r) => r.isHeadline && r.tpDeltaPp === cfg.tpDeltaPp)).toBe(true);
    expect(view.recommendedTp).not.toBeNull();
    expect(view.gate.nMarkets).toBe(2);
    expect(view.gate.minMarkets).toBe(40);
    expect(view.gate.label).toBe('INSUFFICIENT_DATA'); // 2 < 40 markets
  });

  it('is total on empty input', () => {
    const empty = buildConvergenceView([], [], cfg);
    expect(empty.entries).toEqual([]);
    expect(empty.perDay).toEqual([]);
    expect(empty.money.nEntries).toBe(0);
    expect(empty.money.equity).toEqual([]);
    expect(empty.nFreshEvents).toBe(0);
  });
});
