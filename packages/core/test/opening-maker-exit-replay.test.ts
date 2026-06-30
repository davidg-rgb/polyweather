/**
 * Tests for core/sim/opening-maker-exit-replay — the MAKER-EXIT bracket variant (the lever CONVERGENCE-TUNING.md
 * left open). Pins the decisive properties:
 *   - the MAKER take-profit fills AT the resting limit ($0 taker fee, + rebate) when a later bid lifts it;
 *   - the TAKER stop-loss crosses into the bid (fee paid) — you cannot rest above a falling market (§12);
 *   - the HARD time-stop fires at resolvesAt − N hours (the spec) and flattens as a taker;
 *   - NO LOOK-AHEAD: a huge up-tick AFTER a stop-loss fired must NOT rescue the trade;
 *   - the rebate accounting (maker legs only) and the maker-vs-taker fee asymmetry;
 *   - the panel verdict + ledger + makerExitFrac; totality (junk → executed:false, no throw).
 */
import { describe, expect, it } from 'vitest';
import {
  replayMakerExitEvent,
  replayMakerExitPanel,
  MAKER_EXIT_DEFAULTS,
  type MakerExitCfg,
} from '../src/sim/opening-maker-exit-replay.ts';
import type { EventReplayInput, ReplayTick } from '../src/sim/opening-bracket-replay.ts';
import { OPENING_DEFAULTS, type OpeningBucket } from '../src/sim/opening-convergence.ts';

const TZ = 'Europe/Amsterdam';
const DATE = '2026-06-20';
const RESOLVE_MS = new Date('2026-06-21T10:00:00Z').getTime(); // next-morning resolution

const cfg = (over: Partial<MakerExitCfg> = {}): MakerExitCfg => ({
  ...OPENING_DEFAULTS, ...MAKER_EXIT_DEFAULTS, cities: ['amsterdam'], depthFloorUsd: 50, takerFeeRate: 0.05,
  makerFillWindowMin: 15, ...over,
});

// a 3-bucket ladder; bucket 1 is the seeded center. `centerBid`/`centerAsk` override the center bucket's book.
const b = (idx: number, over: Partial<OpeningBucket> = {}): OpeningBucket => ({
  idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.15, bestAsk: 0.16, execAsk: 0.16, depthUsd: 100,
  bestBid: 0.14, sellbackUsd: 100, execBid: 0.14, sellbackDepthUsd: 100, houseProb: idx === 1 ? 0.4 : 0.15,
  tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
});
const ladder = (center: Partial<OpeningBucket>): OpeningBucket[] => [b(0), b(1, center), b(2)];
const tick = (iso: string, age: number, center: Partial<OpeningBucket>): ReplayTick => ({
  capturedAt: iso, hoursSinceListing: age, tz: TZ, targetDate: DATE, buckets: ladder(center),
});
const input = (ticks: ReplayTick[], winnerIdx: number | null = 1): EventReplayInput => ({
  eventId: 'E', city: 'amsterdam', targetDate: DATE, tz: TZ, ticks, resolution: { winnerIdx, gradingMismatch: false },
});

// a clean maker entry at 0.16 then a re-rate path; entry fills maker at the cheap limit on tick 2.
const entryTicks = (): ReplayTick[] => [
  tick('2026-06-20T00:00:00Z', 0.1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }), // selectEntries enters here
  tick('2026-06-20T00:10:00Z', 0.3, { execAsk: 0.12, bestAsk: 0.12, execBid: 0.11 }), // ask runs through the maker limit → fill
];

describe('replayMakerExitEvent', () => {
  it('maker take-profit fills AT the limit with $0 fee (cheaper than the taker would be)', () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25 }), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.isMakerEntry).toBe(true);
    expect(t.exitKind).toBe('maker_take_profit');
    expect(t.isMakerExit).toBe(true);
    // entry filled maker at the limit (≤0.16); exit at entry+0.25 with NO exit fee
    expect(t.exitPrice).toBeCloseTo(t.entryPrice + 0.25, 9);
    expect(t.feeUsd).toBe(0); // both legs maker → zero taker fee
    expect(t.netReturn).toBeGreaterThan(0);
  });

  it('a maker rebate is credited on maker legs only', () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    const noReb = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, makerRebateRate: 0 }), RESOLVE_MS);
    const reb = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, makerRebateRate: 0.05 }), RESOLVE_MS);
    expect(reb.rebateUsd).toBeGreaterThan(0);
    expect(noReb.rebateUsd).toBe(0);
    expect(reb.netPnlUsd).toBeGreaterThan(noReb.netPnlUsd); // the rebate strictly improves the maker P&L
  });

  it('taker stop-loss crosses into the bid and pays the taker fee', () => {
    // entry ~0.12 (maker), then the bid collapses below the ternary stop → taker SL
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.04, execAsk: 0.05 })];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, slDeltaPp: 0.06 }), RESOLVE_MS);
    expect(t.exitKind).toBe('taker_stop_loss');
    expect(t.isMakerExit).toBe(false);
    expect(t.feeUsd).toBeGreaterThan(0); // taker fee on the exit
    expect(t.netReturn).toBeLessThan(0);
  });

  it('the hard time-stop fires at resolvesAt − N hours and flattens as a taker', () => {
    // hold region (bid between stop and limit) all the way; resolves 2026-06-21T10:00Z, tstop 12h → 2026-06-20T22:00Z
    const ticks = [
      ...entryTicks(),
      tick('2026-06-20T21:50:00Z', 10, { execBid: 0.18, execAsk: 0.19 }), // before the time-stop → hold
      tick('2026-06-20T22:10:00Z', 11, { execBid: 0.18, execAsk: 0.19 }), // past resolvesAt−12h → taker flatten
    ];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, tstopHoursBeforeResolve: 12 }), RESOLVE_MS);
    expect(t.exitKind).toBe('taker_time_stop');
    expect(t.exitPrice).toBeCloseTo(0.18, 9);
    expect(t.feeUsd).toBeGreaterThan(0);
  });

  it('NO LOOK-AHEAD: a huge up-tick after the stop-loss fired does not rescue the trade', () => {
    const ticks = [
      ...entryTicks(),
      tick('2026-06-20T01:00:00Z', 1, { execBid: 0.04, execAsk: 0.05 }), // stop-loss fires here
      tick('2026-06-20T02:00:00Z', 2, { execBid: 0.95, execAsk: 0.96 }), // later moon-shot — must be ignored
    ];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, slDeltaPp: 0.06 }), RESOLVE_MS);
    expect(t.exitKind).toBe('taker_stop_loss');
    expect(t.exitPrice).toBeCloseTo(0.04, 9);
  });

  it('is total on junk / non-entry', () => {
    expect(replayMakerExitEvent(null as unknown as EventReplayInput, cfg(), RESOLVE_MS).executed).toBe(false);
    const offCity = input(entryTicks());
    expect(replayMakerExitEvent({ ...offCity, city: 'london' }, cfg(), RESOLVE_MS).executed).toBe(false);
  });
});

describe('replayMakerExitPanel', () => {
  it('returns a ledger + the §9R-E verdict + the maker-exit fraction', () => {
    const winTicks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    const events: EventReplayInput[] = [
      { ...input(winTicks), eventId: 'A', city: 'amsterdam' },
      { ...input(winTicks), eventId: 'B', city: 'chengdu' },
    ];
    const res = new Map<string, number | null>([['A', RESOLVE_MS], ['B', RESOLVE_MS]]);
    const panel = replayMakerExitPanel(events, cfg({ tpDeltaPp: 0.25, cities: ['amsterdam', 'chengdu'] }), res);
    expect(panel.ledger.length).toBe(2);
    expect(panel.nRealized).toBe(2);
    expect(panel.makerExitFrac).toBe(1); // both took profit as makers
    expect(panel.totalNetUsd).toBeGreaterThan(0);
    expect(panel.verdict.label).toBe('INSUFFICIENT_DATA'); // 2 markets < the ≥40 floor — by design
  });

  it('is total on an empty panel', () => {
    const panel = replayMakerExitPanel([], cfg(), new Map());
    expect(panel.ledger.length).toBe(0);
    expect(panel.verdict.label).toBe('INSUFFICIENT_DATA');
  });
});
