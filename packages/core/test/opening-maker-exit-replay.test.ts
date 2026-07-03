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
  replayMakerExitEventBasket,
  replayMakerExitPanelBasket,
  restingSellQmin,
  MAKER_EXIT_DEFAULTS,
  type MakerExitCfg,
} from '../src/sim/opening-maker-exit-replay.ts';
import type { EventReplayInput, ReplayTick } from '../src/sim/opening-bracket-replay.ts';
import { OPENING_DEFAULTS, type OpeningBucket } from '../src/sim/opening-convergence.ts';
import { takerFeePerShare } from '../src/fees.ts';

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

  it('records the measurement diagnostics (bucket, tick indices, maker-fill latency, spreads, rebate rate)', () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, makerRebateRate: 0.03 }), RESOLVE_MS);
    expect(t.exitKind).toBe('maker_take_profit');
    expect(t.bucketIdx).toBe(1); // the seeded center bucket
    expect(t.entryTickIndex).toBe(1); // fills on the 2nd tick (the ask runs through the maker limit)
    expect(t.exitTickIndex).toBe(2); // the take-profit tick
    expect(t.makerFillLatencyTicks).toBe(1); // exit − entry, a MAKER exit so latency is recorded
    expect(t.exitAt).toBe('2026-06-20T01:00:00Z'); // the ACTUAL exit tick, not the series end
    expect(t.rebateRateUsed).toBe(0.03);
    expect(Number.isFinite(t.observedEntrySpread)).toBe(true);
    expect(t.observedExitSpread).toBeCloseTo(0.16 - 0.14, 9); // bestAsk − bestBid at the exit tick (book defaults)
  });

  it('maker-fill latency is null on a taker exit (the adverse-selection read)', () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.04, execAsk: 0.05 })];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, slDeltaPp: 0.06 }), RESOLVE_MS);
    expect(t.exitKind).toBe('taker_stop_loss');
    expect(t.makerFillLatencyTicks).toBeNull();
    expect(t.exitTickIndex).toBe(2);
    expect(t.rebateRateUsed).toBe(0); // MAKER_EXIT_DEFAULTS.makerRebateRate
  });

  it('a maker rebate is credited on maker legs only', () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    const noReb = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, makerRebateRate: 0 }), RESOLVE_MS);
    const reb = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, makerRebateRate: 0.05 }), RESOLVE_MS);
    expect(reb.rebateUsd).toBeGreaterThan(0);
    expect(noReb.rebateUsd).toBe(0);
    expect(reb.netPnlUsd).toBeGreaterThan(noReb.netPnlUsd); // the rebate strictly improves the maker P&L
  });

  it('the maker rebate is a FRACTION of the taker fee (rate · takerFee · shares), not the full fee magnitude (20× bug guard)', () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    const feeRate = 0.05;
    const R = 0.25; // the documented weather rebate tier (reward-farming.ts / reward-inventory.ts)
    const t = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, makerRebateRate: R, takerFeeRate: feeRate }), RESOLVE_MS);
    expect(t.exitKind).toBe('maker_take_profit');
    expect(t.isMakerEntry).toBe(true);
    expect(t.isMakerExit).toBe(true);
    const shares = t.stakeUsd / t.entryPrice; // stakeUsd = fill.price · shares
    // the convention: rebate = rate · takerFeePerShare(price, feeRate) · shares, credited on BOTH maker legs.
    const expected = R * (takerFeePerShare(t.entryPrice, feeRate) + takerFeePerShare(t.exitPrice, feeRate)) * shares;
    expect(t.rebateUsd).toBeCloseTo(expected, 9);
    // the BUG (takerFeePerShare(p, 1)) would credit 1/feeRate = 20× this — pin that it does NOT.
    expect(t.rebateUsd).toBeLessThan(expected * 2);
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

  it('RUNWAY GUARD: an entry already past its resolvesAt−N time-stop at the fill tick is SKIPPED (no_runway), not force-flattened', () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    // fill is at 2026-06-20T00:10Z; resolvesAt 2026-06-21T10:00Z, tstop 34h → time-stop 2026-06-20T00:00Z, BEFORE
    // the fill. The shared entry gate (local-noon clock) lets it in, but THIS engine's clock has no runway → skip.
    const t = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, tstopHoursBeforeResolve: 34 }), RESOLVE_MS);
    expect(t.executed).toBe(false);
    expect(t.exitKind).toBe('no_runway');
    expect(Number.isNaN(t.netReturn)).toBe(true); // not a realized (loss) row — excluded from the §9R-E panel
  });

  it('RUNWAY GUARD also covers the local-noon FALLBACK clock (resolvesAt unknown)', () => {
    // resolvesAt null → the time-stop is local noon (timeStopLocalHour 12). Enter pre-noon (runway OK at selection),
    // but the fill lands AFTER noon → no runway under the fallback clock → skip. Pins the round-2 refinement that
    // dropped the `fin(resolvesAtMs)` precondition so the noon-fallback path is guarded too.
    const ticks = [
      tick('2026-06-20T09:00:00Z', 0.1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }), // 11:00 local — selectEntries enters (60m runway to noon)
      tick('2026-06-20T10:10:00Z', 1.3, { execAsk: 0.12, bestAsk: 0.12, execBid: 0.11 }), // 12:10 local — fill, PAST the noon time-stop
      tick('2026-06-20T13:00:00Z', 4, { execBid: 0.45, execAsk: 0.46 }),
    ];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, timeStopLocalHour: 12 }), null); // resolvesAt unknown → noon fallback
    expect(t.executed).toBe(false);
    expect(t.exitKind).toBe('no_runway');
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

describe('tpMode — the exit-structure lever (2026-07-03)', () => {
  // entry fills MAKER at the limit 0.16 on tick 1 (entryTicks) — all modes share the entry leg.

  it("'abs' rests the sell at the ABSOLUTE convergence target, independent of the entry", () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.36, execAsk: 0.37 })];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpMode: 'abs', tpAbsTarget: 0.35, tpDeltaPp: 0.1 }), RESOLVE_MS);
    expect(t.exitKind).toBe('maker_take_profit');
    expect(t.exitPrice).toBeCloseTo(0.35, 9); // the abs target — NOT entry+tpDeltaPp (0.26), NOT the bid (0.36)
    expect(t.feeUsd).toBe(0);
  });

  it("'abs' does NOT fill while the bid sits below the target (carried to the taker time-stop)", () => {
    const ticks = [
      ...entryTicks(),
      tick('2026-06-20T01:00:00Z', 1, { execBid: 0.3, execAsk: 0.31 }), // +14pp over entry — 'delta' would exit; 'abs' rests on
      tick('2026-06-20T23:00:00Z', 23, { execBid: 0.28, execAsk: 0.29 }), // past resolvesAt−12h → taker flatten
    ];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpMode: 'abs', tpAbsTarget: 0.35, tstopHoursBeforeResolve: 12 }), RESOLVE_MS);
    expect(t.exitKind).toBe('taker_time_stop');
    expect(t.exitPrice).toBeCloseTo(0.28, 9);
  });

  it("'abs' floors the limit at entry+0.02 when the target is at/below the entry (degenerate guard)", () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.19, execAsk: 0.2 })];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpMode: 'abs', tpAbsTarget: 0.05 }), RESOLVE_MS);
    expect(t.exitKind).toBe('maker_take_profit');
    expect(t.exitPrice).toBeCloseTo(t.entryPrice + 0.02, 9);
  });

  it("'model' rests the sell AT our forecast prob (the convergence target itself)", () => {
    // the center bucket's houseProb is 0.4 (the fixture ladder) — the bid reaching 0.45 fills AT 0.40.
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpMode: 'model', tpDeltaPp: 0.1 }), RESOLVE_MS);
    expect(t.exitKind).toBe('maker_take_profit');
    expect(t.exitPrice).toBeCloseTo(0.4, 9);
    expect(t.isMakerExit).toBe(true);
  });

  it("unset/'delta' stays byte-identical to the historical entry+tpDeltaPp behavior", () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    const unset = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25 }), RESOLVE_MS);
    const explicit = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25, tpMode: 'delta', tpAbsTarget: 0.35 }), RESOLVE_MS);
    expect(explicit).toEqual(unset);
    expect(unset.exitPrice).toBeCloseTo(unset.entryPrice + 0.25, 9);
  });
});

describe('noChaseTakerFallback — the no-chase entry guard (2026-07-03, tested + REJECTED, kept as an option)', () => {
  // entry decided at t0 (ask 0.16 ≤ reservation 0.20); the book RUNS AWAY during the maker rest; the 15-min
  // window elapses at t1 (ask 0.46 — no maker fill possible, taker fallback would chase).
  const chaseTicks = (): ReplayTick[] => [
    tick('2026-06-20T00:00:00Z', 0.1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }),
    tick('2026-06-20T00:20:00Z', 0.4, { execAsk: 0.46, bestAsk: 0.46, execBid: 0.44 }),
    tick('2026-06-20T00:40:00Z', 0.8, { execAsk: 0.18, bestAsk: 0.18, execBid: 0.16 }),
    tick('2026-06-20T02:00:00Z', 2.2, { execBid: 0.5, execAsk: 0.51 }),
  ];

  it('OFF (default) chases: the taker fallback pays the run-away ask (the historical behavior)', () => {
    const t = replayMakerExitEvent(input(chaseTicks()), cfg({ tpDeltaPp: 0.25 }), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.entryTickIndex).toBe(1);
    expect(t.entryPrice).toBeCloseTo(0.46 + OPENING_DEFAULTS.paperSlippage, 9); // worse-of + slippage — the chase
  });

  it('ON skips the run-away tick and takes when the ask comes back inside the reservation', () => {
    const t = replayMakerExitEvent(input(chaseTicks()), cfg({ tpDeltaPp: 0.25, noChaseTakerFallback: true }), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.entryTickIndex).toBe(2); // t1 skipped (0.46 > reservation 0.20), takes t2 (0.18)
    expect(t.entryPrice).toBeCloseTo(0.18 + OPENING_DEFAULTS.paperSlippage, 9);
  });

  it('ON never fills when the book never comes back inside', () => {
    const ticks = chaseTicks().slice(0, 2); // ends on the run-away tick
    const t = replayMakerExitEvent(input(ticks), cfg({ noChaseTakerFallback: true }), RESOLVE_MS);
    expect(t.executed).toBe(false);
  });
});

describe('minEntryAgeH — the entry-timing lever (2026-07-03)', () => {
  // t0 enterable young → (no gate) maker-fill t1 at limit 0.16; with a 1h floor the entry walk skips to t2
  // (age 1.3) → maker-fill t3 at the CHEAPER limit 0.13 (the later, faded book).
  const agedTicks = (): ReplayTick[] => [
    tick('2026-06-20T00:00:00Z', 0.1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }),
    tick('2026-06-20T00:10:00Z', 0.3, { execAsk: 0.12, bestAsk: 0.12, execBid: 0.11 }),
    tick('2026-06-20T01:10:00Z', 1.3, { execAsk: 0.13, bestAsk: 0.13, execBid: 0.12 }),
    tick('2026-06-20T01:20:00Z', 1.5, { execAsk: 0.1, bestAsk: 0.1, execBid: 0.09 }),
    tick('2026-06-20T02:00:00Z', 2.2, { execBid: 0.45, execAsk: 0.46 }),
  ];

  it('0/unset = the historical first-enterable-tick entry', () => {
    const t = replayMakerExitEvent(input(agedTicks()), cfg({ tpDeltaPp: 0.25 }), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.entryTickIndex).toBe(1); // fills on the tick after the first (young) enterable tick
    expect(t.entryPrice).toBeCloseTo(0.16, 9);
  });

  it('skips enterable ticks younger than the floor — enters later, at the later book', () => {
    const t = replayMakerExitEvent(input(agedTicks()), cfg({ tpDeltaPp: 0.25, minEntryAgeH: 1 }), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.entryTickIndex).toBe(3); // entry decided at t2 (age 1.3), maker fill at t3
    expect(t.entryPrice).toBeCloseTo(0.13, 9);
  });

  it('an unknown hoursSinceListing fails the ARMED gate (fail closed — no entry)', () => {
    const ticks = agedTicks().map((t) => ({ ...t, hoursSinceListing: NaN }));
    const gated = replayMakerExitEvent(input(ticks), cfg({ minEntryAgeH: 1 }), RESOLVE_MS);
    expect(gated.executed).toBe(false);
    const ungated = replayMakerExitEvent(input(ticks), cfg({}), RESOLVE_MS);
    expect(ungated.executed).toBe(true); // the gate off → unknown age is fine (historical behavior)
  });
});

describe('restingSellQmin — the docs-verbatim one-sided reward-eligibility formula (SIGNAL-BACKLOG #1b)', () => {
  it('qualifies (Qmin > 0) for a one-sided rest within band, mid in [0.10, 0.90] (the Qtwo/c discount)', () => {
    expect(restingSellQmin(0.365, 100, 0.36, 4.5)).toBeGreaterThan(0);
  });

  it('is ZERO in the strict <0.10 regime even when the rest sits within max_spread of mid (mandatory two-sided)', () => {
    expect(restingSellQmin(0.085, 100, 0.08, 4.5)).toBe(0);
  });

  it('is ZERO in the strict >0.90 regime for the same reason', () => {
    expect(restingSellQmin(0.915, 100, 0.92, 4.5)).toBe(0);
  });

  it('is ZERO out of band (too far from mid) even in the [0.10, 0.90] regime', () => {
    expect(restingSellQmin(0.37, 100, 0.15, 4.5)).toBe(0); // 22c away >> the 4.5c max_spread
  });

  it('is total on junk (non-finite mid/price/shares, non-positive shares)', () => {
    expect(restingSellQmin(0.3, 100, null, 4.5)).toBe(0);
    expect(restingSellQmin(NaN, 100, 0.3, 4.5)).toBe(0);
    expect(restingSellQmin(0.3, 0, 0.3, 4.5)).toBe(0);
  });
});

describe('rewardCfg — liquidity-reward accrual on the resting TP sell (SIGNAL-BACKLOG #1b, 2026-07-03)', () => {
  it('unset (default) accrues ZERO reward — byte-identical to every existing caller', () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    const t = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25 }), RESOLVE_MS);
    expect(t.rewardUsd).toBe(0);
  });

  it('accrues income only for the interval the resting sell is actually within band of mid, additively on top of netPnlUsd', () => {
    const ticks = [
      ...entryTicks(), // maker-fills on tick index 1 (2026-06-20T00:10:00Z)
      tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.20, execAsk: 0.21, mid: 0.20 }), // far from the 0.37 target — not eligible yet
      tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }), // mid converged close to target, but bid hasn't reached it — still resting
      tick('2026-06-20T01:00:00Z', 1, { execBid: 0.37, execAsk: 0.38, mid: 0.365 }), // bid reaches the target — maker TP fires
    ];
    const rewardCfg = { dailyPoolUsd: 240, maxSpreadCents: 4.5, myPoolShareIfQualifying: 0.01 };
    const withReward = replayMakerExitEvent(input(ticks), cfg({ tpMode: 'abs', tpAbsTarget: 0.37 as const, rewardCfg }), RESOLVE_MS);
    const noReward = replayMakerExitEvent(input(ticks), cfg({ tpMode: 'abs', tpAbsTarget: 0.37 as const }), RESOLVE_MS);
    expect(withReward.exitKind).toBe('maker_take_profit');
    // only the LAST 10-minute interval qualifies (eligibility is judged on the PRIOR tick's mid — no look-ahead):
    // the [00:40→00:50] interval is judged on the 00:40 mid (0.20, 17c away — ineligible); the [00:50→01:00]
    // interval is judged on the 00:50 mid (0.365, 0.5c away — eligible).
    const expectedReward = 0.01 * 240 * ((10 / 60) / 24);
    expect(withReward.rewardUsd).toBeCloseTo(expectedReward, 9);
    expect(withReward.netPnlUsd).toBeCloseTo(noReward.netPnlUsd + expectedReward, 9);
  });

  it('accrues ZERO when the resting sell never comes within band (mid stays far away the whole hold)', () => {
    const ticks = [
      ...entryTicks(),
      tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.20, execAsk: 0.21, mid: 0.20 }),
      tick('2026-06-20T22:10:00Z', 11, { execBid: 0.20, execAsk: 0.21, mid: 0.20 }), // past resolvesAt−12h → taker time-stop
    ];
    const rewardCfg = { dailyPoolUsd: 240, maxSpreadCents: 4.5, myPoolShareIfQualifying: 0.01 };
    const t = replayMakerExitEvent(input(ticks), cfg({ tpMode: 'abs', tpAbsTarget: 0.37, tstopHoursBeforeResolve: 12, rewardCfg }), RESOLVE_MS);
    expect(t.exitKind).toBe('taker_time_stop');
    expect(t.rewardUsd).toBe(0);
  });

  it('a zero-pool / zero-share config accrues nothing even when the rest is otherwise eligible', () => {
    const ticks = [
      ...entryTicks(),
      tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }),
      tick('2026-06-20T01:00:00Z', 1, { execBid: 0.37, execAsk: 0.38, mid: 0.365 }),
    ];
    const t = replayMakerExitEvent(
      input(ticks),
      cfg({ tpMode: 'abs', tpAbsTarget: 0.37, rewardCfg: { dailyPoolUsd: 0, maxSpreadCents: 4.5, myPoolShareIfQualifying: 0.01 } }),
      RESOLVE_MS,
    );
    expect(t.rewardUsd).toBe(0);
  });
});

describe('restingTicks / qualifyingRestingTicks — the reward-ELIGIBILITY tick diagnostic (SIGNAL-BACKLOG #1 follow-on, 2026-07-03)', () => {
  // reuses the exact fixture from the rewardCfg $accrual tests above: eligibility is judged on the PRIOR tick's
  // mid, no look-ahead. fillIdx=1 (00:10); the exit walk then visits 00:40 (prior mid = the 00:10 fill tick's
  // DEFAULT mid 0.15 → 22c from the 0.37 target, ineligible), 00:50 (prior mid = 00:40's 0.20 → 17c, ineligible),
  // 01:00 (prior mid = 00:50's 0.365 → 0.5c, ELIGIBLE — and the bid also reaches the target here, firing the TP).
  const ticks = () => [
    ...entryTicks(),
    tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.20, execAsk: 0.21, mid: 0.20 }),
    tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }),
    tick('2026-06-20T01:00:00Z', 1, { execBid: 0.37, execAsk: 0.38, mid: 0.365 }),
  ];

  it('counts 3 resting ticks / 1 qualifying — measured even with NO rewardCfg configured (pool-share-agnostic)', () => {
    const t = replayMakerExitEvent(input(ticks()), cfg({ tpMode: 'abs', tpAbsTarget: 0.37 }), RESOLVE_MS);
    expect(t.exitKind).toBe('maker_take_profit');
    expect(t.rewardUsd).toBe(0); // no $ pool configured — the diagnostic is independent of that
    expect(t.restingTicks).toBe(3);
    expect(t.qualifyingRestingTicks).toBe(1);
  });

  it('is IDENTICAL whether or not cfg.rewardCfg is set, as long as maxSpreadCents matches (reuses the exact formula)', () => {
    const noCfg = replayMakerExitEvent(input(ticks()), cfg({ tpMode: 'abs', tpAbsTarget: 0.37 }), RESOLVE_MS);
    const withCfg = replayMakerExitEvent(
      input(ticks()),
      cfg({ tpMode: 'abs', tpAbsTarget: 0.37, rewardCfg: { dailyPoolUsd: 240, maxSpreadCents: 4.5, myPoolShareIfQualifying: 0.01 } }),
      RESOLVE_MS,
    );
    expect(withCfg.restingTicks).toBe(noCfg.restingTicks);
    expect(withCfg.qualifyingRestingTicks).toBe(noCfg.qualifyingRestingTicks);
  });

  it('follows cfg.rewardCfg.maxSpreadCents when configured — NOT the 4.5c fallback', () => {
    // a wider 20c band admits the 00:40→00:50 interval too (17c from target, within 20c but not 4.5c).
    const wide = replayMakerExitEvent(
      input(ticks()),
      cfg({ tpMode: 'abs', tpAbsTarget: 0.37, rewardCfg: { dailyPoolUsd: 240, maxSpreadCents: 20, myPoolShareIfQualifying: 0.01 } }),
      RESOLVE_MS,
    );
    expect(wide.restingTicks).toBe(3);
    expect(wide.qualifyingRestingTicks).toBe(2); // was 1 at the 4.5c default
  });

  it('a single-tick resting window that immediately qualifies counts 1/1', () => {
    // tpDeltaPp 0.02 → exitLimit = entryPrice(0.16)+0.02 = 0.18; the ONE resting tick's prior mid (the entry-fill
    // tick's default 0.15) sits 3c away — within the 4.5c default band — AND the bid reaches 0.18 on that same tick.
    const t = replayMakerExitEvent(
      input([...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.19, execAsk: 0.2 })]),
      cfg({ tpDeltaPp: 0.02 }),
      RESOLVE_MS,
    );
    expect(t.exitKind).toBe('maker_take_profit');
    expect(t.restingTicks).toBe(1);
    expect(t.qualifyingRestingTicks).toBe(1);
  });

  it('is 0/0 on a not-executed trade (no_runway, off-universe, junk)', () => {
    const noRunway = replayMakerExitEvent(
      input([...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })]),
      cfg({ tpDeltaPp: 0.25, tstopHoursBeforeResolve: 34 }),
      RESOLVE_MS,
    );
    expect(noRunway.executed).toBe(false);
    expect(noRunway.restingTicks).toBe(0);
    expect(noRunway.qualifyingRestingTicks).toBe(0);
    const junk = replayMakerExitEvent(null as unknown as EventReplayInput, cfg(), RESOLVE_MS);
    expect(junk.restingTicks).toBe(0);
    expect(junk.qualifyingRestingTicks).toBe(0);
  });
});

describe('restingDistFromMidSumPp / restingMidKnownTicks / restingWithinBandTicks — the v2 "WHY zero" price-band diagnostic (SIGNAL-BACKLOG #1 follow-on v2, 2026-07-04)', () => {
  // the EXACT shared fixture from the restingTicks/qualifyingRestingTicks describe above: 3 resting ticks whose
  // prior mids are 0.15 (default, 22c from the 0.37 target), 0.20 (17c), 0.365 (0.5c) — only the last is in-band.
  const ticks = () => [
    ...entryTicks(),
    tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.20, execAsk: 0.21, mid: 0.20 }),
    tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }),
    tick('2026-06-20T01:00:00Z', 1, { execBid: 0.37, execAsk: 0.38, mid: 0.365 }),
  ];

  it('decomposes the fixture into Σ39.5pp distance / 3 known mids / 1 within band (matches qualifyingRestingTicks here since mid never leaves [0.10,0.90])', () => {
    const t = replayMakerExitEvent(input(ticks()), cfg({ tpMode: 'abs', tpAbsTarget: 0.37 }), RESOLVE_MS);
    expect(t.exitKind).toBe('maker_take_profit');
    expect(t.restingTicks).toBe(3);
    expect(t.qualifyingRestingTicks).toBe(1);
    // 22.0 + 17.0 + 0.5 — hand-computed from the fixture's prior-tick mids vs the 0.37 target.
    expect(t.restingDistFromMidSumPp).toBeCloseTo(39.5, 9);
    expect(t.restingMidKnownTicks).toBe(3); // every prior-tick mid in this fixture is a real number
    expect(t.restingWithinBandTicks).toBe(1); // only the last tick (0.5c) sits within the 4.5c default band
  });

  it('a missing prior-tick mid is excluded from BOTH the distance sum and the known-ticks denominator (never fabricated)', () => {
    // the tick at 00:40 has mid:NaN — that tick's OWN mid is read as the PRIOR mid by the NEXT iteration
    // (00:50), so IT is the one that goes unpriced; 00:40 itself still prices off 00:10's (entryTicks') default
    // mid 0.15, and 01:00 (the TP tick) still prices off 00:50's 0.365. The resting walk must still count
    // restingTicks for all 3 iterations while excluding only the one iteration with an unknown prior mid.
    const noMidTicks = [
      ...entryTicks(),
      tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.20, execAsk: 0.21, mid: NaN }), // mid unknown this tick
      tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }),
      tick('2026-06-20T01:00:00Z', 1, { execBid: 0.37, execAsk: 0.38, mid: 0.365 }),
    ];
    const t = replayMakerExitEvent(input(noMidTicks), cfg({ tpMode: 'abs', tpAbsTarget: 0.37 }), RESOLVE_MS);
    expect(t.exitKind).toBe('maker_take_profit');
    expect(t.restingTicks).toBe(3); // still counts every resting tick
    expect(t.restingMidKnownTicks).toBe(2); // the 00:50 iteration's prior mid (00:40's NaN) is the one excluded
    // 22.0 (00:40, priced off 00:10's default 0.15) + 0.5 (01:00, priced off 00:50's 0.365) — the 00:50
    // iteration (priced off 00:40's NaN) contributes NOTHING, not a fabricated 0.
    expect(t.restingDistFromMidSumPp).toBeCloseTo(22.5, 9);
    expect(t.restingWithinBandTicks).toBe(1); // only the 01:00 iteration (0.5c) is in-band
    expect(t.qualifyingRestingTicks).toBe(1); // matches — the same tick that qualifies is the one in-band
  });

  it('is 0/0/0/0 on a not-executed trade and on junk', () => {
    const noRunway = replayMakerExitEvent(
      input([...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })]),
      cfg({ tpDeltaPp: 0.25, tstopHoursBeforeResolve: 34 }),
      RESOLVE_MS,
    );
    expect(noRunway.executed).toBe(false);
    expect(noRunway.restingDistFromMidSumPp).toBe(0);
    expect(noRunway.restingMidKnownTicks).toBe(0);
    expect(noRunway.restingWithinBandTicks).toBe(0);
    expect(noRunway.restingFailsMinSizeTicks).toBe(0);
    const junk = replayMakerExitEvent(null as unknown as EventReplayInput, cfg(), RESOLVE_MS);
    expect(junk.restingDistFromMidSumPp).toBe(0);
    expect(junk.restingMidKnownTicks).toBe(0);
    expect(junk.restingWithinBandTicks).toBe(0);
    expect(junk.restingFailsMinSizeTicks).toBe(0);
  });
});

describe('restingFailsMinSizeTicks — the min-size half of the v2 WHY-zero diagnostic (SIGNAL-BACKLOG #1 follow-on v2, 2026-07-04)', () => {
  const ticks = () => [
    ...entryTicks(),
    tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.20, execAsk: 0.21, mid: 0.20 }),
    tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }),
    tick('2026-06-20T01:00:00Z', 1, { execBid: 0.37, execAsk: 0.38, mid: 0.365 }),
  ];

  it('the default $20 stake at the 0.16 entry rests comfortably above the 50-share floor — ZERO ticks fail min size', () => {
    const t = replayMakerExitEvent(input(ticks()), cfg({ tpMode: 'abs', tpAbsTarget: 0.37 }), RESOLVE_MS);
    const shares = t.stakeUsd / t.entryPrice;
    expect(shares).toBeGreaterThanOrEqual(50);
    expect(t.restingFailsMinSizeTicks).toBe(0);
  });

  it('a tiny stake under the 50-share floor fails min size on EVERY resting tick (binary per trade, not partial)', () => {
    const t = replayMakerExitEvent(input(ticks()), cfg({ tpMode: 'abs', tpAbsTarget: 0.37, perPositionUsd: 1 }), RESOLVE_MS);
    const shares = t.stakeUsd / t.entryPrice;
    expect(shares).toBeLessThan(50);
    expect(t.restingFailsMinSizeTicks).toBe(t.restingTicks);
    expect(t.restingTicks).toBe(3);
  });
});

describe('the mid-REGIME case — price band passes but qualifying still reads ZERO (the live "0/1,732" hypothesis, SIGNAL-BACKLOG #1 follow-on v2, 2026-07-04)', () => {
  // a genuinely cheap ladder (entry fills maker at 0.03, the resting sell targets 0.06) — every resting tick's
  // mid stays UNDER 0.10 (the strict two-sided regime restingSellQmin's own docstring names: "a one-sided quote
  // earns ZERO" there) even though the resting sell sits well WITHIN the 4.5c band of that low mid. This is
  // reward-farming.ts's own documented explanation for why MOST weather buckets (cheap longshots) never qualify.
  const cheapTicks = (): ReplayTick[] => [
    tick('2026-06-20T00:00:00Z', 0.1, { execAsk: 0.03, bestAsk: 0.03, execBid: 0.02, mid: 0.025 }), // selectEntries enters here (makerLimit → 0.03)
    tick('2026-06-20T00:10:00Z', 0.3, { execAsk: 0.025, bestAsk: 0.025, execBid: 0.02, mid: 0.022 }), // ask runs through the maker limit → fill @ 0.03
    tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.04, execAsk: 0.05, mid: 0.058 }), // resting: 0.06 target, mid 0.058 → 0.2c away, in-band, regime<0.10
    tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.04, execAsk: 0.05, mid: 0.059 }), // still holds — never reaches the 0.06 TP
  ];

  it('restingWithinBandTicks reads 100% while qualifyingRestingTicks reads ZERO — the price band is NOT the disqualifier here', () => {
    const t = replayMakerExitEvent(input(cheapTicks()), cfg({ tpMode: 'abs', tpAbsTarget: 0.06 }), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.entryPrice).toBeCloseTo(0.03, 9); // the maker resting ceiling (makerLimit), not the live re-walked ask
    // the bid (0.04) never reaches the 0.06 TP limit — the position holds to series end and settles at
    // resolution (winner=1, matching the entered bucket) — exitPrice 1 is the redemption payout, not a TP fill.
    expect(t.exitKind).toBe('resolution_settle:win');
    expect(t.exitPrice).toBe(1);
    expect(t.restingTicks).toBe(2);
    expect(t.qualifyingRestingTicks).toBe(0); // the strict <0.10 regime zeroes it every tick
    expect(t.restingMidKnownTicks).toBe(2);
    expect(t.restingWithinBandTicks).toBe(2); // BOTH ticks sit within 4.5c of their (low) mid — band is NOT the problem
    expect(t.restingFailsMinSizeTicks).toBe(0); // the default $20 stake at 0.03 is comfortably >50 shares — size is NOT the problem either
  });
});

describe('the no-bid time-stop break path — the diagnostic catch-up (review lens A fix, 2026-07-03)', () => {
  // entry fills at idx 1 (00:10). At idx 2 (22:10) the time-stop (resolvesAt−12h = 22:00Z) has passed but the
  // bucket has NO bid — and none was seen since the fill — so the walk `break`s instead of returning, and the
  // trade settles at the SERIES END (endIdx 4). The resting TP sell stays live through every one of those
  // post-break ticks; the pre-fix defect skipped ticks (2, 4] from BOTH diagnostic counts.
  const noBid: Partial<OpeningBucket> = { execBid: NaN, bestBid: NaN, execAsk: NaN, bestAsk: NaN };
  const noBidTicks = (): ReplayTick[] => [
    ...entryTicks(),
    tick('2026-06-20T22:10:00Z', 22.2, { ...noBid, mid: 0.365 }), // idx 2 — time-stop fires, no bid → break
    tick('2026-06-20T22:40:00Z', 22.7, { ...noBid, mid: 0.20 }), //  idx 3 — post-break, must still be counted
    tick('2026-06-20T23:00:00Z', 23.0, { ...noBid, mid: 0.20 }), //  idx 4 — endIdx, the settle tick
  ];
  const noBidOver: Partial<MakerExitCfg> = { tpMode: 'abs', tpAbsTarget: 0.37, tstopHoursBeforeResolve: 12 };

  it('counts every tick through the settle index, evaluates qualifying in the post-break range, and leaves the P&L untouched', () => {
    const t = replayMakerExitEvent(input(noBidTicks()), cfg(noBidOver), RESOLVE_MS);
    // (c) trading behavior unchanged by the diagnostic: the break path still settles at resolution (winner=1),
    // fee-free (maker entry + redeem), reward-free — nothing folded into the P&L.
    expect(t.executed).toBe(true);
    expect(t.exitKind).toBe('resolution_settle:win');
    expect(t.exitPrice).toBe(1);
    expect(t.feeUsd).toBe(0);
    expect(t.rewardUsd).toBe(0);
    const shares = t.stakeUsd / t.entryPrice;
    expect(t.netPnlUsd).toBeCloseTo(shares * (1 - t.entryPrice), 9);
    // (a) the invariant: the resting sell was live from the fill (idx 1) through the settle (endIdx 4) — 3
    // ticks, NOT the 1 tick the pre-fix walk had counted before breaking.
    expect(t.entryTickIndex).toBe(1);
    expect(t.exitTickIndex).toBe(4);
    expect(t.restingTicks).toBe(3);
    expect(t.restingTicks).toBe(t.exitTickIndex - t.entryTickIndex);
    // (b) qualifying is actually EVALUATED in the post-break range: the one qualifying tick is k=3, whose
    // PRIOR-tick mid (idx 2's 0.365) sits 0.5c from the 0.37 limit — in band; idx 2 (prior mid 0.15, 22c) and
    // idx 4 (prior mid 0.20, 17c) are out of band. Pre-fix this came back 0.
    expect(t.qualifyingRestingTicks).toBe(1);
  });

  it('the break→mtm path (no resolution) obeys the same invariant', () => {
    const t = replayMakerExitEvent(input(noBidTicks(), null), cfg(noBidOver), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.exitKind).toBe('mtm_unresolved');
    expect(t.exitPrice).toBe(0); // no bid ever seen post-fill → marks to 0 (pre-existing behavior, unchanged)
    expect(t.restingTicks).toBe(t.exitTickIndex - t.entryTickIndex);
    expect(t.restingTicks).toBe(3);
    expect(t.qualifyingRestingTicks).toBe(1);
  });

  it('INVARIANT: restingTicks === exitTickIndex − entryTickIndex on EVERY settle path', () => {
    const cases: { name: string; ticks: ReplayTick[]; over: Partial<MakerExitCfg>; winner?: number | null }[] = [
      { name: 'maker_take_profit', ticks: [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })], over: { tpDeltaPp: 0.25 } },
      { name: 'taker_stop_loss', ticks: [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.04, execAsk: 0.05 })], over: { tpDeltaPp: 0.25, slDeltaPp: 0.06 } },
      { name: 'taker_time_stop (with bid)', ticks: [...entryTicks(), tick('2026-06-20T21:50:00Z', 10, { execBid: 0.18, execAsk: 0.19 }), tick('2026-06-20T22:10:00Z', 11, { execBid: 0.18, execAsk: 0.19 })], over: { tpDeltaPp: 0.25, tstopHoursBeforeResolve: 12 } },
      { name: 'no-bid break → resolution', ticks: noBidTicks(), over: noBidOver },
      { name: 'no-bid break → mtm', ticks: noBidTicks(), over: noBidOver, winner: null },
      { name: 'held to series end → resolution', ticks: [...entryTicks(), tick('2026-06-20T02:00:00Z', 2, { execBid: 0.18, execAsk: 0.19 })], over: { tpDeltaPp: 0.25, tstopHoursBeforeResolve: 12 } },
    ];
    for (const c of cases) {
      const t = replayMakerExitEvent(input(c.ticks, c.winner === undefined ? 1 : c.winner), cfg(c.over), RESOLVE_MS);
      expect(t.executed, c.name).toBe(true);
      expect(t.restingTicks, c.name).toBe(t.exitTickIndex - t.entryTickIndex);
    }
  });
});

describe('replayMakerExitEventBasket — SIGNAL-BACKLOG.md #5 (basket entry, variance reduction not a new edge)', () => {
  // a ladder where BOTH bucket 0 and bucket 1 qualify (bucket 2 never does, as in the default fixture) —
  // bucket1 stays the argmax (houseProb 0.4 > bucket0's 0.35), so a basketSize:1 request must degenerate
  // to EXACTLY the single-bucket engine's choice.
  const b0Base: Partial<OpeningBucket> = { houseProb: 0.35, execAsk: 0.10, bestAsk: 0.10, execBid: 0.09 };
  const basketLadder = (b1over: Partial<OpeningBucket>, b0over: Partial<OpeningBucket> = {}): OpeningBucket[] => [
    b(0, { ...b0Base, ...b0over }),
    b(1, b1over),
    b(2),
  ];
  const basketTick = (iso: string, age: number, b1over: Partial<OpeningBucket>, b0over: Partial<OpeningBucket> = {}): ReplayTick => ({
    capturedAt: iso, hoursSinceListing: age, tz: TZ, targetDate: DATE, buckets: basketLadder(b1over, b0over),
  });
  const twoLegTicks = (): ReplayTick[] => [
    basketTick('2026-06-20T00:00:00Z', 0.1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }), // entry decided (both qualify)
    basketTick('2026-06-20T00:10:00Z', 0.3, { execAsk: 0.12, bestAsk: 0.12, execBid: 0.11 }, { execAsk: 0.08, bestAsk: 0.08, execBid: 0.07 }), // both maker-fill
    basketTick('2026-06-20T01:00:00Z', 1, { execBid: 0.36, execAsk: 0.37 }, { execBid: 0.36, execAsk: 0.37 }), // both TP (abs target 0.35)
  ];
  const basketCfg = (over: Partial<MakerExitCfg> = {}) => cfg({ tpMode: 'abs', tpAbsTarget: 0.35, ...over });

  it('unset/1 degenerates EXACTLY to replayMakerExitEvent (same numbers, one leg)', () => {
    const ticks = [...entryTicks(), tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 })];
    const solo = replayMakerExitEvent(input(ticks), cfg({ tpDeltaPp: 0.25 }), RESOLVE_MS);
    const basket = replayMakerExitEventBasket(input(ticks), cfg({ tpDeltaPp: 0.25 }), RESOLVE_MS);
    expect(basket.executed).toBe(true);
    expect(basket.legs.length).toBe(1);
    expect(basket.legs[0]!.basketWeight).toBe(1);
    expect(basket.nLegsRequested).toBe(1);
    expect(basket.nLegsFilled).toBe(1);
    expect(basket.netPnlUsd).toBeCloseTo(solo.netPnlUsd, 9);
    expect(basket.stakeUsd).toBeCloseTo(solo.stakeUsd, 9);
    expect(basket.netReturn).toBeCloseTo(solo.netReturn, 9);
    expect(basket.legs[0]!.exitKind).toBe(solo.exitKind);
  });

  it('basketSize:2 splits perPositionUsd probability-weighted across both qualifying buckets', () => {
    const t = replayMakerExitEventBasket(input(twoLegTicks()), basketCfg({ basketSize: 2 }), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.nLegsRequested).toBe(2);
    expect(t.nLegsFilled).toBe(2);
    // weights normalize to 1, proportional to modelProb (0.4 vs 0.35)
    const byBucket = new Map(t.legs.map((l) => [l.bucketIdx, l]));
    expect(byBucket.get(1)!.basketWeight).toBeCloseTo(0.4 / 0.75, 9);
    expect(byBucket.get(0)!.basketWeight).toBeCloseTo(0.35 / 0.75, 9);
    expect(t.legs.reduce((a, l) => a + l.basketWeight, 0)).toBeCloseTo(1, 9);
    // total stake across legs equals the undivided perPositionUsd (OPENING_DEFAULTS = 20)
    expect(t.stakeUsd).toBeCloseTo(20, 6);
    // both legs took profit as makers (0/0.16 -> 0.35, 0/0.10 -> 0.35)
    expect(byBucket.get(1)!.exitKind).toBe('maker_take_profit');
    expect(byBucket.get(0)!.exitKind).toBe('maker_take_profit');
    expect(t.netPnlUsd).toBeCloseTo(t.legs.reduce((a, l) => a + l.netPnlUsd, 0), 9);
    expect(t.netReturn).toBeCloseTo(t.netPnlUsd / t.stakeUsd, 9);
  });

  it('requesting more legs than exist caps at the number of qualifying candidates (never pads)', () => {
    const t = replayMakerExitEventBasket(input(twoLegTicks()), basketCfg({ basketSize: 5 }), RESOLVE_MS);
    expect(t.nLegsRequested).toBe(2); // only 2 candidates ever qualify in this fixture
    expect(t.nLegsFilled).toBe(2);
  });

  it('a leg that never fills is dropped; the OTHER leg still realizes independently', () => {
    const ticks = [
      basketTick('2026-06-20T00:00:00Z', 0.1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }),
      // bucket 0 goes quote-less (execAsk NaN) for the rest of the series -> never fills; bucket 1 fills normally
      basketTick('2026-06-20T00:10:00Z', 0.3, { execAsk: 0.12, bestAsk: 0.12, execBid: 0.11 }, { execAsk: NaN, bestAsk: NaN, execBid: NaN }),
      basketTick('2026-06-20T01:00:00Z', 1, { execBid: 0.36, execAsk: 0.37 }, { execAsk: NaN, bestAsk: NaN, execBid: NaN }),
    ];
    const t = replayMakerExitEventBasket(input(ticks), basketCfg({ basketSize: 2 }), RESOLVE_MS);
    expect(t.nLegsRequested).toBe(2);
    expect(t.nLegsFilled).toBe(1);
    expect(t.legs[0]!.bucketIdx).toBe(1); // the bucket-0 leg never filled and is absent
  });

  it('is total on junk / off-universe', () => {
    expect(replayMakerExitEventBasket(null as unknown as EventReplayInput, basketCfg({ basketSize: 2 }), RESOLVE_MS).executed).toBe(false);
    const offCity = input(twoLegTicks());
    expect(replayMakerExitEventBasket({ ...offCity, city: 'london' }, basketCfg({ basketSize: 2 }), RESOLVE_MS).executed).toBe(false);
  });
});

describe('replayMakerExitPanelBasket', () => {
  it('returns a ledger + the §9R-E verdict + the maker-exit leg fraction', () => {
    const b0Base: Partial<OpeningBucket> = { houseProb: 0.35, execAsk: 0.10, bestAsk: 0.10, execBid: 0.09 };
    const winTicks: ReplayTick[] = [
      { capturedAt: '2026-06-20T00:00:00Z', hoursSinceListing: 0.1, tz: TZ, targetDate: DATE, buckets: [b(0, b0Base), b(1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }), b(2)] },
      { capturedAt: '2026-06-20T00:10:00Z', hoursSinceListing: 0.3, tz: TZ, targetDate: DATE, buckets: [b(0, { ...b0Base, execAsk: 0.08, bestAsk: 0.08, execBid: 0.07 }), b(1, { execAsk: 0.12, bestAsk: 0.12, execBid: 0.11 }), b(2)] },
      { capturedAt: '2026-06-20T01:00:00Z', hoursSinceListing: 1, tz: TZ, targetDate: DATE, buckets: [b(0, { ...b0Base, execBid: 0.36, execAsk: 0.37 }), b(1, { execBid: 0.36, execAsk: 0.37 }), b(2)] },
    ];
    const events: EventReplayInput[] = [
      { ...input(winTicks), eventId: 'A', city: 'amsterdam' },
      { ...input(winTicks), eventId: 'B', city: 'chengdu' },
    ];
    const res = new Map<string, number | null>([['A', RESOLVE_MS], ['B', RESOLVE_MS]]);
    const panel = replayMakerExitPanelBasket(
      events,
      cfg({ tpMode: 'abs', tpAbsTarget: 0.35, basketSize: 2, cities: ['amsterdam', 'chengdu'] }),
      res,
    );
    expect(panel.ledger.length).toBe(2);
    expect(panel.nRealized).toBe(2);
    expect(panel.ledger[0]!.nLegsFilled).toBe(2);
    expect(panel.makerExitFrac).toBe(1); // every leg of every basket took profit as a maker
    expect(panel.totalNetUsd).toBeGreaterThan(0);
    expect(panel.verdict.label).toBe('INSUFFICIENT_DATA'); // 2 markets < the ≥40 floor — by design
  });

  it('is total on an empty panel', () => {
    const panel = replayMakerExitPanelBasket([], cfg({ basketSize: 2 }), new Map());
    expect(panel.ledger.length).toBe(0);
    expect(panel.verdict.label).toBe('INSUFFICIENT_DATA');
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

  it('qualifyingTickFrac is WEIGHTED BY RESTING TICKS across the panel, not a simple mean of per-trade fractions', () => {
    // event A: 3 resting ticks / 1 qualifying (frac 1/3) — the shared SIGNAL-BACKLOG #1b fixture.
    const ticksA = [
      ...entryTicks(),
      tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.20, execAsk: 0.21, mid: 0.20 }),
      tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }),
      tick('2026-06-20T01:00:00Z', 1, { execBid: 0.37, execAsk: 0.38, mid: 0.365 }),
    ];
    // event B: 1 resting tick / 1 qualifying (frac 1/1) — the SAME shared cfg (tpMode 'abs'/0.37), so its fill
    // tick's mid is overridden to sit right next to the target (0.5c away — eligible), and the very next tick's
    // bid reaches 0.37 immediately (one resting tick, no earlier ineligible interval).
    const ticksB: ReplayTick[] = [
      tick('2026-06-20T00:00:00Z', 0.1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }),
      tick('2026-06-20T00:10:00Z', 0.3, { execAsk: 0.12, bestAsk: 0.12, execBid: 0.11, mid: 0.365 }),
      tick('2026-06-20T01:00:00Z', 1, { execBid: 0.37, execAsk: 0.38 }),
    ];
    const events: EventReplayInput[] = [
      { ...input(ticksA), eventId: 'A', city: 'amsterdam' },
      { ...input(ticksB), eventId: 'B', city: 'chengdu' },
    ];
    const res = new Map<string, number | null>([['A', RESOLVE_MS], ['B', RESOLVE_MS]]);
    const panel = replayMakerExitPanel(
      events,
      cfg({ tpMode: 'abs', tpAbsTarget: 0.37, cities: ['amsterdam', 'chengdu'] }),
      res,
    );
    expect(panel.nRealized).toBe(2);
    expect(panel.nRestingTicks).toBe(panel.ledger.reduce((a, t) => a + t.restingTicks, 0));
    expect(panel.nQualifyingRestingTicks).toBe(panel.ledger.reduce((a, t) => a + t.qualifyingRestingTicks, 0));
    expect(panel.qualifyingTickFrac).toBeCloseTo(panel.nQualifyingRestingTicks / panel.nRestingTicks, 9);
    // the tick-weighted fraction must differ from the simple (unweighted) mean of the two trades' own fractions
    // whenever their resting-tick counts differ — pins that this is NOT trade-averaged.
    const perTradeFracs = panel.ledger.map((t) => t.qualifyingRestingTicks / t.restingTicks).filter(Number.isFinite);
    const simpleMean = perTradeFracs.reduce((a, b) => a + b, 0) / perTradeFracs.length;
    if (panel.ledger.some((t) => t.restingTicks !== panel.ledger[0]!.restingTicks)) {
      expect(panel.qualifyingTickFrac).not.toBeCloseTo(simpleMean, 6);
    }
  });

  it('is total on an empty panel', () => {
    const panel = replayMakerExitPanel([], cfg(), new Map());
    expect(panel.ledger.length).toBe(0);
    expect(panel.verdict.label).toBe('INSUFFICIENT_DATA');
    expect(panel.nRestingTicks).toBe(0);
    expect(panel.nQualifyingRestingTicks).toBe(0);
    expect(Number.isNaN(panel.qualifyingTickFrac)).toBe(true);
  });
});

describe('replayMakerExitPanel — the v2 "WHY zero" disqualifier aggregate (meanDistFromMidPp / fracWithinAdvertisedBand / fracFailsMinSize / dominantDisqualifier, SIGNAL-BACKLOG #1 follow-on v2, 2026-07-04)', () => {
  const bandFixtureTicks = () => [
    ...entryTicks(),
    tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.20, execAsk: 0.21, mid: 0.20 }),
    tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }),
    tick('2026-06-20T01:00:00Z', 1, { execBid: 0.37, execAsk: 0.38, mid: 0.365 }),
  ];
  const cheapRegimeTicks = (): ReplayTick[] => [
    tick('2026-06-20T00:00:00Z', 0.1, { execAsk: 0.03, bestAsk: 0.03, execBid: 0.02, mid: 0.025 }),
    tick('2026-06-20T00:10:00Z', 0.3, { execAsk: 0.025, bestAsk: 0.025, execBid: 0.02, mid: 0.022 }),
    tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.04, execAsk: 0.05, mid: 0.058 }),
    tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.04, execAsk: 0.05, mid: 0.059 }),
  ];

  it("'band' dominant: mostly out-of-band, size comfortably OK (qualifyingTickFrac still low)", () => {
    const events: EventReplayInput[] = [{ ...input(bandFixtureTicks()), eventId: 'A', city: 'amsterdam' }];
    const panel = replayMakerExitPanel(events, cfg({ tpMode: 'abs', tpAbsTarget: 0.37, cities: ['amsterdam'] }), new Map([['A', RESOLVE_MS]]));
    expect(panel.nRestingTicks).toBe(3);
    expect(panel.meanDistFromMidPp).toBeCloseTo(39.5 / 3, 9);
    expect(panel.fracWithinAdvertisedBand).toBeCloseTo(1 / 3, 9);
    expect(panel.fracFailsMinSize).toBe(0);
    expect(panel.dominantDisqualifier).toBe('band');
  });

  it("'size' dominant: comfortably in-band, but the stake fails min_size", () => {
    const events: EventReplayInput[] = [{ ...input(cheapRegimeTicks()), eventId: 'A', city: 'amsterdam' }];
    const panel = replayMakerExitPanel(
      events,
      cfg({ tpMode: 'abs', tpAbsTarget: 0.06, perPositionUsd: 1, cities: ['amsterdam'] }),
      new Map([['A', RESOLVE_MS]]),
    );
    expect(panel.fracWithinAdvertisedBand).toBe(1);
    expect(panel.fracFailsMinSize).toBe(1);
    expect(panel.dominantDisqualifier).toBe('size');
  });

  it("'both' dominant: mostly out-of-band AND the stake fails min_size", () => {
    const events: EventReplayInput[] = [{ ...input(bandFixtureTicks()), eventId: 'A', city: 'amsterdam' }];
    const panel = replayMakerExitPanel(
      events,
      cfg({ tpMode: 'abs', tpAbsTarget: 0.37, perPositionUsd: 1, cities: ['amsterdam'] }),
      new Map([['A', RESOLVE_MS]]),
    );
    expect(panel.fracWithinAdvertisedBand).toBeCloseTo(1 / 3, 9);
    expect(panel.fracFailsMinSize).toBe(1);
    expect(panel.dominantDisqualifier).toBe('both');
  });

  it("'none': band + size both mostly PASS yet qualifyingTickFrac is still 0 — the mid-regime residual (the live hypothesis)", () => {
    const events: EventReplayInput[] = [{ ...input(cheapRegimeTicks()), eventId: 'A', city: 'amsterdam' }];
    const panel = replayMakerExitPanel(events, cfg({ tpMode: 'abs', tpAbsTarget: 0.06, cities: ['amsterdam'] }), new Map([['A', RESOLVE_MS]]));
    expect(panel.qualifyingTickFrac).toBe(0);
    expect(panel.fracWithinAdvertisedBand).toBe(1);
    expect(panel.fracFailsMinSize).toBe(0);
    expect(panel.dominantDisqualifier).toBe('none');
  });

  it("'none' + every stat NaN when zero resting ticks have accrued (insufficient data, not a fabricated verdict)", () => {
    const panel = replayMakerExitPanel([], cfg(), new Map());
    expect(panel.nRestingTicks).toBe(0);
    expect(Number.isNaN(panel.meanDistFromMidPp)).toBe(true);
    expect(Number.isNaN(panel.fracWithinAdvertisedBand)).toBe(true);
    expect(Number.isNaN(panel.fracFailsMinSize)).toBe(true);
    expect(panel.dominantDisqualifier).toBe('none');
  });

  it('is TICK-WEIGHTED across the panel (sums the raw accumulators, not a simple mean of two trades own fractions)', () => {
    // both events replayed under the SAME shared cfg the panel call below uses (tpAbsTarget 0.37) — the panel's
    // totals must equal the exact sum of the two single-trade results (the aggregation contract, not a
    // re-derivation of the per-trade math already pinned by the tests above).
    const sharedCfg = cfg({ tpMode: 'abs', tpAbsTarget: 0.37, cities: ['amsterdam', 'chengdu'] });
    const tA = replayMakerExitEvent({ ...input(bandFixtureTicks()), eventId: 'A', city: 'amsterdam' }, sharedCfg, RESOLVE_MS);
    const tB = replayMakerExitEvent({ ...input(cheapRegimeTicks()), eventId: 'B', city: 'chengdu' }, sharedCfg, RESOLVE_MS);
    const expectedDistSum = tA.restingDistFromMidSumPp + tB.restingDistFromMidSumPp;
    const expectedMidKnown = tA.restingMidKnownTicks + tB.restingMidKnownTicks;
    const expectedWithinBand = tA.restingWithinBandTicks + tB.restingWithinBandTicks;
    const panel = replayMakerExitPanel(
      [
        { ...input(bandFixtureTicks()), eventId: 'A', city: 'amsterdam' },
        { ...input(cheapRegimeTicks()), eventId: 'B', city: 'chengdu' },
      ],
      sharedCfg,
      new Map([['A', RESOLVE_MS], ['B', RESOLVE_MS]]),
    );
    expect(panel.nRestingTicks).toBe(tA.restingTicks + tB.restingTicks);
    expect(panel.meanDistFromMidPp).toBeCloseTo(expectedDistSum / expectedMidKnown, 9);
    expect(panel.fracWithinAdvertisedBand).toBeCloseTo(expectedWithinBand / expectedMidKnown, 9);
  });
});

describe('dominantDisqualifier tie-breaks — the symmetric STRICT-majority-fails rule (lens-A fix, 2026-07-04)', () => {
  // an exact 50/50 tie on EITHER axis must resolve to NOT-failing: an axis "fails" only when its failing
  // fraction STRICTLY exceeds 0.5 — band fails iff (1 − fracWithinAdvertisedBand) > 0.5, size fails iff
  // fracFailsMinSize > 0.5. The pre-fix rule was asymmetric (band tie → not-failing, size tie → failing).

  it('BAND axis at exactly 0.5: fracWithinAdvertisedBand = 1/2 → band NOT failing → dominant "none"', () => {
    // 2 resting ticks: j=2's prior mid is the fill tick's default 0.15 (22c from the 0.37 target — OUT),
    // j=3's prior mid is 00:40's 0.365 (0.5c — IN) and the bid reaches the target there → TP fires. Exactly
    // half the mid-known resting ticks sit in-band; size passes at the default $20 stake (125 shares ≥ 50).
    const ticks = [
      ...entryTicks(),
      tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }),
      tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.37, execAsk: 0.38 }),
    ];
    const panel = replayMakerExitPanel(
      [{ ...input(ticks), eventId: 'A', city: 'amsterdam' }],
      cfg({ tpMode: 'abs', tpAbsTarget: 0.37, cities: ['amsterdam'] }),
      new Map([['A', RESOLVE_MS]]),
    );
    expect(panel.nRestingTicks).toBe(2);
    expect(panel.fracWithinAdvertisedBand).toBe(0.5); // the exact boundary
    expect(panel.fracFailsMinSize).toBe(0);
    expect(panel.dominantDisqualifier).toBe('none'); // 1 − 0.5 = 0.5, NOT > 0.5 → band not failing
  });

  it('SIZE axis at exactly 0.5: fracFailsMinSize = 3/6 → size NOT failing → dominant "none" (the pre-fix ">=" rule would have said "size")', () => {
    // Two events under ONE shared cfg (perPositionUsd $6). shares = $6 / entryPrice, and min_size fails at
    // the TRADE level (binary), so the panel mixes: event A fills maker at 0.16 → 37.5 shares < 50 (FAILS);
    // event B fills maker at 0.10 → 60 shares ≥ 50 (passes). Both rest exactly 3 ticks before the same 0.37
    // TP → fracFailsMinSize = 3/6 = 0.5 exactly. Band: per event the priors are 0.15 (out) / 0.365 (in) /
    // 0.365 (in) → panel fracWithinAdvertisedBand = 4/6, failing fraction 1/3 NOT > 0.5 → band not failing.
    const restTail = [
      tick('2026-06-20T00:40:00Z', 0.8, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }),
      tick('2026-06-20T00:50:00Z', 0.95, { execBid: 0.30, execAsk: 0.31, mid: 0.365 }),
      tick('2026-06-20T01:00:00Z', 1, { execBid: 0.37, execAsk: 0.38 }),
    ];
    const ticksA = [...entryTicks(), ...restTail]; // fills maker at 0.16
    const ticksB = [
      tick('2026-06-20T00:00:00Z', 0.1, { execAsk: 0.10, bestAsk: 0.10, execBid: 0.09 }),
      tick('2026-06-20T00:10:00Z', 0.3, { execAsk: 0.08, bestAsk: 0.08, execBid: 0.07 }), // runs through → fill @ 0.10
      ...restTail,
    ];
    const panel = replayMakerExitPanel(
      [
        { ...input(ticksA), eventId: 'A', city: 'amsterdam' },
        { ...input(ticksB), eventId: 'B', city: 'chengdu' },
      ],
      cfg({ tpMode: 'abs', tpAbsTarget: 0.37, perPositionUsd: 6, cities: ['amsterdam', 'chengdu'] }),
      new Map([['A', RESOLVE_MS], ['B', RESOLVE_MS]]),
    );
    expect(panel.nRealized).toBe(2);
    // pin the construction: A fails min size (37.5 shares), B passes (60), equal 3-tick resting windows.
    const byId = new Map(panel.ledger.map((t) => [t.eventId, t]));
    expect(byId.get('A')!.restingFailsMinSizeTicks).toBe(3);
    expect(byId.get('B')!.restingFailsMinSizeTicks).toBe(0);
    expect(byId.get('A')!.restingTicks).toBe(3);
    expect(byId.get('B')!.restingTicks).toBe(3);
    expect(panel.fracFailsMinSize).toBe(0.5); // the exact boundary
    expect(panel.fracWithinAdvertisedBand).toBeCloseTo(4 / 6, 9);
    expect(panel.dominantDisqualifier).toBe('none'); // 0.5 NOT > 0.5 → size not failing (pre-fix: 'size')
  });
});

describe('replayMakerExitPanelBasket — the v2 disqualifier aggregate mirrors the single-bucket panel (SIGNAL-BACKLOG #1 follow-on v2, 2026-07-04)', () => {
  it('carries the same meanDistFromMidPp / fracWithinAdvertisedBand / fracFailsMinSize / dominantDisqualifier shape, summed across every leg of every fully-realized basket', () => {
    const b0Base: Partial<OpeningBucket> = { houseProb: 0.35, execAsk: 0.10, bestAsk: 0.10, execBid: 0.09 };
    const winTicks: ReplayTick[] = [
      { capturedAt: '2026-06-20T00:00:00Z', hoursSinceListing: 0.1, tz: TZ, targetDate: DATE, buckets: [b(0, b0Base), b(1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }), b(2)] },
      { capturedAt: '2026-06-20T00:10:00Z', hoursSinceListing: 0.3, tz: TZ, targetDate: DATE, buckets: [b(0, { ...b0Base, execAsk: 0.08, bestAsk: 0.08, execBid: 0.07 }), b(1, { execAsk: 0.12, bestAsk: 0.12, execBid: 0.11 }), b(2)] },
      { capturedAt: '2026-06-20T01:00:00Z', hoursSinceListing: 1, tz: TZ, targetDate: DATE, buckets: [b(0, { ...b0Base, execBid: 0.36, execAsk: 0.37 }), b(1, { execBid: 0.36, execAsk: 0.37 }), b(2)] },
    ];
    const events: EventReplayInput[] = [
      { ...input(winTicks), eventId: 'A', city: 'amsterdam' },
      { ...input(winTicks), eventId: 'B', city: 'chengdu' },
    ];
    const res = new Map<string, number | null>([['A', RESOLVE_MS], ['B', RESOLVE_MS]]);
    const panel = replayMakerExitPanelBasket(
      events,
      cfg({ tpMode: 'abs', tpAbsTarget: 0.35, basketSize: 2, cities: ['amsterdam', 'chengdu'] }),
      res,
    );
    // every field is present + internally consistent (basket isn't the live path — this pins the wiring, not a
    // hand-derived number): the fraction fields are either NaN or within [0,1], and the aggregation matches a
    // manual sum over every leg of every fully-realized basket in the ledger.
    const manualDistSum = panel.ledger.reduce((a, t) => a + t.legs.reduce((la, l) => la + l.restingDistFromMidSumPp, 0), 0);
    const manualMidKnown = panel.ledger.reduce((a, t) => a + t.legs.reduce((la, l) => la + l.restingMidKnownTicks, 0), 0);
    expect(panel.meanDistFromMidPp).toBeCloseTo(manualMidKnown > 0 ? manualDistSum / manualMidKnown : NaN, 9);
    expect(['band', 'size', 'both', 'none']).toContain(panel.dominantDisqualifier);
    if (Number.isFinite(panel.fracWithinAdvertisedBand)) {
      expect(panel.fracWithinAdvertisedBand).toBeGreaterThanOrEqual(0);
      expect(panel.fracWithinAdvertisedBand).toBeLessThanOrEqual(1);
    }
  });

  it("'none' + NaN on an empty panel", () => {
    const panel = replayMakerExitPanelBasket([], cfg({ basketSize: 2 }), new Map());
    expect(panel.dominantDisqualifier).toBe('none');
    expect(Number.isNaN(panel.meanDistFromMidPp)).toBe(true);
    expect(Number.isNaN(panel.fracFailsMinSize)).toBe(true);
  });
});
