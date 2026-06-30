/**
 * Tests for core/sim/history-replay-ingest — the PURE bridge from the mid-only price-history archive into the
 * existing bracket-replay engine. The decisive properties pinned here:
 *   - synthBook: the calibrated two-sided book is well-ordered (execBid ≤ mid ≤ execAsk), spreadMult scales the
 *     half-spread (0 → frictionless, >1 → wider), depth tracks the mid band, and a degenerate mid → null;
 *   - buildHistoryEvent: the per-minute series is resampled onto the cadence grid with last-mid carry-forward,
 *     the external houseProb is attached by idx, hoursSinceListing is anchored to createdAt, the DB target_date
 *     (the weather day) overrides the archive filename date, and the result flows THROUGH replayEvent unchanged;
 *   - resolution: the DB winner wins, else the archive's own resolvedOutcome:'win' fallback;
 *   - selectionDiagnostic: the mode + bought set + winner-in-bought flag;
 *   - totality: junk → null, never a throw.
 */
import { describe, expect, it } from 'vitest';
import {
  synthBook,
  buildHistoryEvent,
  selectionDiagnostic,
  CALIBRATED_BOOK,
  type ArchiveEvent,
  type BuildOpts,
} from '../src/sim/history-replay-ingest.ts';
import { replayEvent } from '../src/sim/opening-bracket-replay.ts';
import { OPENING_DEFAULTS, type OpeningCfg } from '../src/sim/opening-convergence.ts';

const TZ = 'Europe/Amsterdam';
const DATE = '2026-06-20'; // CEST → local noon 10:00Z

// build a flat per-minute mid series for one bucket between two epochs (seconds)
function series(t0: number, n: number, stepSec: number, p: number): Array<[number, number]> {
  return Array.from({ length: n }, (_v, i) => [t0 + i * stepSec, p] as [number, number]);
}

describe('synthBook', () => {
  it('produces a well-ordered two-sided book at the calibrated spread', () => {
    const q = synthBook(0.17, CALIBRATED_BOOK, 1);
    expect(q).not.toBeNull();
    expect(q!.execBid).toBeLessThanOrEqual(q!.mid);
    expect(q!.mid).toBeLessThanOrEqual(q!.execAsk);
    expect(q!.depthUsd).toBeGreaterThan(0);
    // at mid 0.17 the calibration is ~1.5pp ask-over and ~1.4pp bid-under
    expect(q!.execAsk).toBeCloseTo(0.185, 3);
    expect(q!.execBid).toBeCloseTo(0.156, 3);
  });

  it('scales the half-spread by spreadMult (0 = frictionless, 2 = double)', () => {
    const base = synthBook(0.17, CALIBRATED_BOOK, 1)!;
    const zero = synthBook(0.17, CALIBRATED_BOOK, 0)!;
    const wide = synthBook(0.17, CALIBRATED_BOOK, 2)!;
    expect(zero.execAsk).toBeCloseTo(0.17, 9);
    expect(zero.execBid).toBeCloseTo(0.17, 9);
    expect(wide.execAsk - wide.mid).toBeCloseTo(2 * (base.execAsk - base.mid), 9);
    expect(wide.mid - wide.execBid).toBeCloseTo(2 * (base.mid - base.execBid), 9);
    // depth is NOT scaled by spreadMult (separate liquidity axis)
    expect(wide.depthUsd).toBeCloseTo(base.depthUsd, 9);
  });

  it('depth grows with the mid band (cheap = thin)', () => {
    expect(synthBook(0.1, CALIBRATED_BOOK, 1)!.depthUsd).toBeLessThan(synthBook(0.3, CALIBRATED_BOOK, 1)!.depthUsd);
  });

  it('returns null for a degenerate mid', () => {
    expect(synthBook(0, CALIBRATED_BOOK, 1)).toBeNull();
    expect(synthBook(1, CALIBRATED_BOOK, 1)).toBeNull();
    expect(synthBook(Number.NaN, CALIBRATED_BOOK, 1)).toBeNull();
    expect(synthBook(-0.2, CALIBRATED_BOOK, 1)).toBeNull();
  });
});

// ── buildHistoryEvent ──────────────────────────────────────────────────────────────────────────────
const T0 = Math.floor(new Date('2026-06-20T00:00:00Z').getTime() / 1000); // 10h before local noon

function ev3(centerMid: number): ArchiveEvent {
  // a 3-bucket ladder, ~3h of per-minute points; bucket 1 is the center
  return {
    city: 'amsterdam',
    eventId: 'E1',
    targetDate: '2026-06-21', // archive filename date = RESOLUTION date (deliberately != the weather day)
    createdAt: '2026-06-20T00:00:00Z',
    endDate: '2026-06-21T10:20:00Z',
    buckets: [
      { idx: 0, label: '20°C', resolvedOutcome: 'lose', points: series(T0, 180, 60, 0.12) },
      { idx: 1, label: '21°C', resolvedOutcome: 'win', points: series(T0, 180, 60, centerMid) },
      { idx: 2, label: '22°C', resolvedOutcome: 'lose', points: series(T0, 180, 60, 0.12) },
    ],
  };
}

const baseOpts = (over: Partial<BuildOpts> = {}): BuildOpts => ({
  houseProbByIdx: new Map([[0, 0.2], [1, 0.5], [2, 0.2]]),
  resolution: { winnerIdx: 1, gradingMismatch: false },
  targetDate: DATE, // the WEATHER day (overrides the archive filename date)
  tz: TZ,
  sampleEveryMin: 10,
  createdAtMs: new Date('2026-06-20T00:00:00Z').getTime(),
  ...over,
});

describe('buildHistoryEvent', () => {
  it('resamples to the cadence grid, attaches houseProb, and anchors hoursSinceListing', () => {
    const out = buildHistoryEvent(ev3(0.17), baseOpts())!;
    expect(out).not.toBeNull();
    expect(out.targetDate).toBe(DATE); // the weather day, NOT the archive 2026-06-21
    expect(out.tz).toBe(TZ);
    // 180 minutes @ 10-min cadence → ~18 ticks
    expect(out.ticks.length).toBeGreaterThanOrEqual(17);
    expect(out.ticks.length).toBeLessThanOrEqual(19);
    const t0 = out.ticks[0]!;
    expect(t0.hoursSinceListing).toBeCloseTo(0, 5); // first tick == createdAt
    const center = t0.buckets.find((b) => b.idx === 1)!;
    expect(center.houseProb).toBeCloseTo(0.5, 9);
    expect(center.execAsk).toBeGreaterThan(center.mid!);
    expect(center.execBid).toBeLessThan(center.mid!);
  });

  it('flows through replayEvent and the engine enters the forecast-center + settles the win', () => {
    // center cheap (0.17, clears the 20% cap & the depth floor at mid 0.17 ≈ $93) and seeded as the mode.
    const input = buildHistoryEvent(ev3(0.17), baseOpts())!;
    const cfg: OpeningCfg = { ...OPENING_DEFAULTS, cities: ['amsterdam'], depthFloorUsd: 50 };
    const trade = replayEvent(input, cfg, 0.25);
    expect(trade.executed).toBe(true);
    expect(trade.entryLabel).toBe('21°C'); // the forecast center
    // held to the local-noon time-stop (10:00Z) or settles the win — either way a real exit, not a non-fill
    expect(['take_profit', 'stop_loss', 'time_stop', 'resolution_settle']).toContain(trade.exitReason.split(':')[0]);
  });

  it('a too-thin / too-pricey center is not enterable (depth floor + 20% cap honored via the engine)', () => {
    // mid 0.10 → depth ≈ $14 < the $50 floor → never enters (executed:false)
    const input = buildHistoryEvent(ev3(0.1), baseOpts())!;
    const cfg: OpeningCfg = { ...OPENING_DEFAULTS, cities: ['amsterdam'], depthFloorUsd: 50 };
    expect(replayEvent(input, cfg, 0.25).executed).toBe(false);
  });

  it('trimAtLocalHour drops the post-weather-day tail but keeps the time-stop window (verdict-preserving)', () => {
    // a 36h series from 2026-06-20T00:00Z; trim at 20:00 local (CEST = 18:00Z) → keep only the first ~18h.
    const long: ArchiveEvent = {
      ...ev3(0.17),
      buckets: ev3(0.17).buckets.map((b) => ({ ...b, points: series(T0, 36 * 6, 600, b.idx === 1 ? 0.17 : 0.12) })),
    };
    const full = buildHistoryEvent(long, baseOpts({ trimAtLocalHour: null }))!;
    const trimmed = buildHistoryEvent(long, baseOpts({ trimAtLocalHour: 20 }))!;
    expect(trimmed.ticks.length).toBeLessThan(full.ticks.length);
    const lastTrim = new Date(trimmed.ticks[trimmed.ticks.length - 1]!.capturedAt).getTime();
    expect(lastTrim).toBeLessThanOrEqual(new Date('2026-06-20T18:30:00Z').getTime()); // ≤ 20:00 CEST + a cadence step
    // the local-noon (10:00Z) time-stop tick is still present → the exit decision is unchanged
    expect(lastTrim).toBeGreaterThan(new Date('2026-06-20T10:00:00Z').getTime());
  });

  it('falls back to the archive resolvedOutcome when the DB winner is absent', () => {
    const out = buildHistoryEvent(ev3(0.17), baseOpts({ resolution: { winnerIdx: null, gradingMismatch: false } }))!;
    expect(out.resolution.winnerIdx).toBe(1); // the archive's resolvedOutcome:'win' bucket
  });

  it('is total on junk', () => {
    expect(buildHistoryEvent(null as unknown as ArchiveEvent, baseOpts())).toBeNull();
    expect(buildHistoryEvent({ ...ev3(0.17), buckets: [] }, baseOpts())).toBeNull();
    expect(
      buildHistoryEvent({ ...ev3(0.17), buckets: [{ idx: 0, label: 'x', resolvedOutcome: null, points: [] }] }, baseOpts()),
    ).toBeNull();
  });
});

describe('selectionDiagnostic', () => {
  it('reports the mode, the bought set, and whether the winner is bracketed', () => {
    const probs = new Map([[0, 0.1], [1, 0.2], [2, 0.45], [3, 0.2], [4, 0.05]]);
    const d = selectionDiagnostic(probs, 3, 1)!;
    expect(d.modeIdx).toBe(2);
    expect(d.boughtIdxs).toEqual([1, 2, 3]);
    expect(d.winnerInBought).toBe(true);
    expect(selectionDiagnostic(probs, 0, 1)!.winnerInBought).toBe(false); // winner idx 0 outside mode±1
    expect(selectionDiagnostic(new Map(), 1, 1)).toBeNull(); // no seed → null
  });
});
