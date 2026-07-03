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

  it('is total on an empty panel', () => {
    const panel = replayMakerExitPanel([], cfg(), new Map());
    expect(panel.ledger.length).toBe(0);
    expect(panel.verdict.label).toBe('INSUFFICIENT_DATA');
  });
});
