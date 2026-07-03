/**
 * Tests for core/sim/opening-fluctuation-replay — the FLUCTUATION-TAKER variant (BUILD-STATE 2026-07-03 #3).
 * Pins the decisive properties:
 *   - the dip/momentum path signal fires only when the move within the trailing window clears dipDepth,
 *     and the rolling reference NEVER reads ticks outside the window or after the signal tick;
 *   - the key set is LEAD-AWARE with no look-ahead: a fresher forecast (later made_at) cannot steer an
 *     earlier tick; re-centering moves the enterable set only after the dist exists;
 *   - taker fee curve (rate·p·(1−p)) on BOTH legs + pessimistic entry slippage — exact P&L arithmetic;
 *   - the exit family: fixed-TP bracket, trailing peak-bid drawdown, the ternary SL, the optional
 *     recenter path exit, the hard resolvesAt−N h time-stop (with lastBid fallback);
 *   - NO LOOK-AHEAD: a huge up-tick AFTER a stop fired must not rescue the trade;
 *   - the panel verdict (realized-only) + VerdictOpts threading (dayBlockNull); totality on junk.
 */
import { describe, expect, it } from 'vitest';
import {
  replayFluctuationEvent,
  replayFluctuationPanel,
  activeDistIdx,
  distCenterIdx,
  FLUCTUATION_DEFAULTS,
  type FluctuationCfg,
  type FluctuationDist,
} from '../src/sim/opening-fluctuation-replay.ts';
import type { EventReplayInput, ReplayTick } from '../src/sim/opening-bracket-replay.ts';
import type { OpeningBucket } from '../src/sim/opening-convergence.ts';
import { takerFeePerShare } from '../src/fees.ts';

const TZ = 'Europe/Amsterdam';
const DATE = '2026-06-20';
const RESOLVE_MS = new Date('2026-06-21T10:00:00Z').getTime(); // next-morning resolution
// default tstop 18h ⇒ the hard time-stop clock = 2026-06-20T16:00:00Z

const cfg = (over: Partial<FluctuationCfg> = {}): FluctuationCfg => ({
  ...FLUCTUATION_DEFAULTS, cities: ['amsterdam'], ...over,
});

/** tick minutes after 2026-06-20T06:00Z (a 20-min cadence unless a test says otherwise). */
const iso = (min: number): string => new Date(Date.UTC(2026, 5, 20, 6, 0) + min * 60_000).toISOString();

// a 5-bucket ladder (idx 0..4), every bucket defaulting to a flat 0.20 mid / 0.21 ask / 0.19 bid book.
const b = (idx: number, over: Partial<OpeningBucket> = {}): OpeningBucket => ({
  idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.2, bestAsk: 0.21, execAsk: 0.21, depthUsd: 200,
  bestBid: 0.19, sellbackUsd: 200, execBid: 0.19, sellbackDepthUsd: 200, houseProb: null,
  tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
});
const tick = (min: number, over: Record<number, Partial<OpeningBucket>> = {}): ReplayTick => ({
  capturedAt: iso(min), hoursSinceListing: 30 + min / 60, tz: TZ, targetDate: DATE,
  buckets: [0, 1, 2, 3, 4].map((i) => b(i, over[i] ?? {})),
});
const input = (ticks: ReplayTick[], winnerIdx: number | null = 1): EventReplayInput => ({
  eventId: 'E', city: 'amsterdam', targetDate: DATE, tz: TZ, ticks, resolution: { winnerIdx, gradingMismatch: false },
});

/** a production dist made at `madeAtIso` centering `center` (0.4 there, 0.05 elsewhere). */
const dist = (madeAtIso: string, center: number): FluctuationDist => ({
  madeAtMs: new Date(madeAtIso).getTime(),
  probsByIdx: new Map([0, 1, 2, 3, 4].map((i) => [i, i === center ? 0.4 : 0.05] as [number, number])),
});
const D0 = [dist('2026-06-20T00:00:00Z', 1)]; // one pre-series dist centering bucket 1

// the standard dip path: bucket 1 flat at 0.20 (t0,t1) then dips to 0.14 (ask 0.15) at t2 → mag 0.06 ≥ 0.05.
const dipTicks = (): ReplayTick[] => [
  tick(0),
  tick(20),
  tick(40, { 1: { mid: 0.14, execAsk: 0.15, bestAsk: 0.15, execBid: 0.13, bestBid: 0.13 } }),
];

describe('replayFluctuationEvent — entry', () => {
  it('a dip ≥ dipDepth within the window enters as a TAKER (ask + slippage, real fee curve)', () => {
    const ticks = [...dipTicks(), tick(60, { 1: { execBid: 0.45, bestBid: 0.45, mid: 0.46, execAsk: 0.47 } })];
    const t = replayFluctuationEvent(input(ticks), D0, cfg(), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.bucketIdx).toBe(1);
    expect(t.entryTickIndex).toBe(2); // the dip tick IS the fill tick
    expect(t.entryPrice).toBeCloseTo(0.15 + 0.01, 9); // execAsk + paperSlippage
    expect(t.signalMagnitude).toBeCloseTo(0.06, 9);
    expect(t.entryLead).toBe(0); // the target day is in progress locally
    // exact two-leg taker P&L: TP at bid 0.45 (≥ entry+0.10)
    expect(t.exitKind).toBe('taker_take_profit');
    const shares = 20 / 0.16;
    const fees = takerFeePerShare(0.16, 0.05) * shares + takerFeePerShare(0.45, 0.05) * shares;
    expect(t.feeUsd).toBeCloseTo(fees, 9);
    expect(t.netPnlUsd).toBeCloseTo(shares * (0.45 - 0.16) - fees, 9);
    expect(t.netReturn).toBeGreaterThan(0);
  });

  it('a dip smaller than dipDepth never enters', () => {
    const ticks = [tick(0), tick(20), tick(40, { 1: { mid: 0.17, execAsk: 0.18 } })]; // mag 0.03 < 0.05
    const t = replayFluctuationEvent(input(ticks), D0, cfg(), RESOLVE_MS);
    expect(t.executed).toBe(false);
    expect(t.exitKind).toBe('never_signaled');
  });

  it('the rolling reference respects momentumWindowMin (an old high outside the window does not count)', () => {
    const ticks = [
      tick(0, { 1: { mid: 0.25 } }),
      tick(20, { 1: { mid: 0.21 } }),
      tick(40, { 1: { mid: 0.21 } }),
      tick(60, { 1: { mid: 0.195, execAsk: 0.2 } }), // vs the 40-min window max (0.21): mag 0.015
    ];
    const narrow = replayFluctuationEvent(input(ticks), D0, cfg({ momentumWindowMin: 40 }), RESOLVE_MS);
    expect(narrow.executed).toBe(false); // the 0.25 high is outside the 40-min window
    const wide = replayFluctuationEvent(input(ticks), D0, cfg({ momentumWindowMin: 240 }), RESOLVE_MS);
    expect(wide.executed).toBe(true); // the same path signals once the window reaches the 0.25 high
    expect(wide.entryTickIndex).toBe(3);
    expect(wide.signalMagnitude).toBeCloseTo(0.055, 9);
  });

  it("entryMode 'momentum' enters on a rise of ≥ dipDepth", () => {
    const ticks = [
      tick(0, { 1: { mid: 0.14 } }),
      tick(20, { 1: { mid: 0.16 } }),
      tick(40, { 1: { mid: 0.2, execAsk: 0.21 } }), // +0.06 vs the window min
    ];
    const t = replayFluctuationEvent(input(ticks), D0, cfg({ entryMode: 'momentum' }), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.entryTickIndex).toBe(2);
    expect(t.signalMagnitude).toBeCloseTo(0.06, 9);
  });

  it('a dip OUTSIDE the current key set (center ± chw) never enters', () => {
    // bucket 3 dips while the center is 1 (chw 1 ⇒ key set {0,1,2})
    const ticks = [tick(0), tick(20), tick(40, { 3: { mid: 0.14, execAsk: 0.15 } })];
    const out = replayFluctuationEvent(input(ticks), D0, cfg(), RESOLVE_MS);
    expect(out.executed).toBe(false);
    const wider = replayFluctuationEvent(input(ticks), D0, cfg({ centerHalfWidth: 2 }), RESOLVE_MS);
    expect(wider.executed).toBe(true); // chw 2 admits |3−1| = 2
    expect(wider.bucketIdx).toBe(3);
  });

  it('re-centering is made_at-anchored: a fresher forecast cannot steer a tick before it existed', () => {
    // dist A (pre-series) centers 1; dist B (made 07:10Z = min 70) re-centers to 3.
    const dists = [dist('2026-06-20T00:00:00Z', 1), dist('2026-06-20T07:10:00Z', 3)];
    const ticks = [
      tick(0),
      tick(20),
      tick(40, { 3: { mid: 0.14, execAsk: 0.15 } }), // bucket 3 dips BEFORE B exists → not enterable
      tick(60, { 3: { mid: 0.2 } }), // recovers
      tick(80, { 3: { mid: 0.14, execAsk: 0.15 } }), // dips again AFTER B (07:10) → enterable
    ];
    const t = replayFluctuationEvent(input(ticks), dists, cfg(), RESOLVE_MS);
    expect(t.executed).toBe(true);
    expect(t.entryTickIndex).toBe(4); // NOT 2 — the earlier dip predates the re-center
    expect(t.bucketIdx).toBe(3);
  });

  it('no dist made before any tick → no_dist (the key set never existed)', () => {
    const t = replayFluctuationEvent(input(dipTicks()), [dist('2026-06-21T00:00:00Z', 1)], cfg(), RESOLVE_MS);
    expect(t.executed).toBe(false);
    expect(t.exitKind).toBe('no_dist');
  });

  it('the maxEntryPrice cap and the depth floor gate the signal tick', () => {
    const expensive = [tick(0, { 1: { mid: 0.45, execAsk: 0.46, execBid: 0.44 } }), tick(20, { 1: { mid: 0.45, execAsk: 0.46 } }),
      tick(40, { 1: { mid: 0.38, execAsk: 0.39 } })]; // dip 0.07 but ask 0.39 > 0.30 cap
    expect(replayFluctuationEvent(input(expensive), D0, cfg(), RESOLVE_MS).executed).toBe(false);
    const thin = [tick(0), tick(20), tick(40, { 1: { mid: 0.14, execAsk: 0.15, depthUsd: 40 } })]; // depth 40 < 100
    expect(replayFluctuationEvent(input(thin), D0, cfg(), RESOLVE_MS).executed).toBe(false);
    const ok = [tick(0), tick(20), tick(40, { 1: { mid: 0.14, execAsk: 0.15, depthUsd: 100 } })];
    expect(replayFluctuationEvent(input(ok), D0, cfg(), RESOLVE_MS).executed).toBe(true);
  });

  it('no entry at/after the hard time-stop clock (no runway left)', () => {
    // resolvesAt 2026-06-21T10:00Z, tstop 18h ⇒ time-stop 16:00Z = min 600. A dip at min 620 must not enter.
    const ticks = [tick(580), tick(600), tick(620, { 1: { mid: 0.14, execAsk: 0.15 } })];
    const t = replayFluctuationEvent(input(ticks), D0, cfg(), RESOLVE_MS);
    expect(t.executed).toBe(false);
    expect(t.exitKind).toBe('never_signaled');
  });

  it('the deepest firing dip wins a same-tick tie', () => {
    const ticks = [
      tick(0),
      tick(20),
      tick(40, { 1: { mid: 0.14, execAsk: 0.15 }, 2: { mid: 0.12, execAsk: 0.13 } }), // mags 0.06 vs 0.08
    ];
    const t = replayFluctuationEvent(input(ticks), D0, cfg(), RESOLVE_MS);
    expect(t.bucketIdx).toBe(2);
    expect(t.signalMagnitude).toBeCloseTo(0.08, 9);
  });
});

describe('replayFluctuationEvent — exit', () => {
  it('the ternary stop-loss: relative floor for cheap entries, absolute delta where positive', () => {
    // cheap: entry 0.16 → 0.16−0.20 ≤ 0 → floor 0.16×0.5 = 0.08; bid 0.07 fires it.
    const cheap = [...dipTicks(), tick(60, { 1: { execBid: 0.07, mid: 0.08, execAsk: 0.09 } })];
    const t1 = replayFluctuationEvent(input(cheap), D0, cfg(), RESOLVE_MS);
    expect(t1.exitKind).toBe('taker_stop_loss');
    expect(t1.feeUsd).toBeGreaterThan(0);
    expect(t1.netReturn).toBeLessThan(0);
    // expensive: entry 0.25 with slDeltaPp 0.06 → stop 0.19; bid 0.18 fires; bid 0.20 holds.
    const exp = (lateBid: number): ReplayTick[] => [
      tick(0, { 1: { mid: 0.3, execAsk: 0.31, execBid: 0.29 } }),
      tick(20, { 1: { mid: 0.3, execAsk: 0.31 } }),
      tick(40, { 1: { mid: 0.24, execAsk: 0.24, execBid: 0.23 } }), // dip 0.06 → entry at 0.25
      tick(60, { 1: { execBid: lateBid, mid: lateBid + 0.01, execAsk: lateBid + 0.02 } }),
    ];
    const fired = replayFluctuationEvent(input(exp(0.18)), D0, cfg({ slDeltaPp: 0.06 }), RESOLVE_MS);
    expect(fired.entryPrice).toBeCloseTo(0.25, 9);
    expect(fired.exitKind).toBe('taker_stop_loss');
    const held = replayFluctuationEvent(input(exp(0.2)), D0, cfg({ slDeltaPp: 0.06 }), RESOLVE_MS);
    expect(held.exitKind).toMatch(/resolution_settle/); // held to the end, settles on the winner
  });

  it("exitRule 'trail' exits on a peak-bid drawdown ≥ trailPp — and has NO fixed take-profit", () => {
    const rise = [
      ...dipTicks(),
      tick(60, { 1: { execBid: 0.3, mid: 0.31, execAsk: 0.32 } }), // peak 0.30 (a bracket TP would have fired)
      tick(80, { 1: { execBid: 0.24, mid: 0.25, execAsk: 0.26 } }), // drawdown 0.06 ≥ trailPp 0.05
    ];
    const t = replayFluctuationEvent(input(rise), D0, cfg({ exitRule: 'trail', trailPp: 0.05 }), RESOLVE_MS);
    expect(t.exitKind).toBe('taker_trail_stop');
    expect(t.exitPrice).toBeCloseTo(0.24, 9);
    expect(t.exitTickIndex).toBe(4);
    // a monotone rise never trail-exits — it rides to the series end and settles at resolution.
    const mono = [
      ...dipTicks(),
      tick(60, { 1: { execBid: 0.3, mid: 0.31, execAsk: 0.32 } }),
      tick(80, { 1: { execBid: 0.5, mid: 0.51, execAsk: 0.52 } }),
    ];
    const held = replayFluctuationEvent(input(mono), D0, cfg({ exitRule: 'trail', trailPp: 0.05 }), RESOLVE_MS);
    expect(held.exitKind).toBe('resolution_settle:win');
    expect(held.exitPrice).toBe(1);
  });

  it('NO LOOK-AHEAD: a later huge up-tick cannot rescue a fired stop', () => {
    const ticks = [
      ...dipTicks(),
      tick(60, { 1: { execBid: 0.07, mid: 0.08, execAsk: 0.09 } }), // SL fires here (floor 0.08)
      tick(80, { 1: { execBid: 0.9, mid: 0.91, execAsk: 0.92 } }), // the rescue that must not happen
    ];
    const t = replayFluctuationEvent(input(ticks), D0, cfg(), RESOLVE_MS);
    expect(t.exitKind).toBe('taker_stop_loss');
    expect(t.exitTickIndex).toBe(3);
    expect(t.exitPrice).toBeCloseTo(0.07, 9);
  });

  it('exitOnRecenter flattens when a fresher forecast moves the key set off the held bucket', () => {
    const dists = [dist('2026-06-20T00:00:00Z', 1), dist('2026-06-20T07:10:00Z', 4)]; // |1−4| = 3 > chw 1
    const ticks = [...dipTicks(), tick(60), tick(80)]; // holds otherwise (bids 0.19, stop 0.08, tp 0.26)
    const armed = replayFluctuationEvent(input(ticks), dists, cfg({ exitOnRecenter: true }), RESOLVE_MS);
    expect(armed.exitKind).toBe('taker_recenter');
    expect(armed.exitTickIndex).toBe(4); // min 80 — the first tick after the 07:10 re-center
    expect(armed.feeUsd).toBeGreaterThan(0); // a taker flatten
    const off = replayFluctuationEvent(input(ticks), dists, cfg({ exitOnRecenter: false }), RESOLVE_MS);
    expect(off.exitKind).toBe('resolution_settle:win'); // disarmed → holds to settle
  });

  it('the hard time-stop (resolvesAt − N h) taker-flattens, with the lastBid fallback', () => {
    // time-stop 16:00Z = min 600; bids hold in-region before it.
    const ticks = [...dipTicks(), tick(300), tick(610)];
    const t = replayFluctuationEvent(input(ticks), D0, cfg(), RESOLVE_MS);
    expect(t.exitKind).toBe('taker_time_stop');
    expect(t.exitPrice).toBeCloseTo(0.19, 9);
    expect(t.feeUsd).toBeGreaterThan(0);
    // the fallback: the time-stop tick has no bid for the held bucket → flatten at the LAST seen bid.
    const noBid = [...dipTicks(), tick(300, { 1: { execBid: 0.17, mid: 0.18 } }),
      tick(610, { 1: { execBid: null, bestBid: null, mid: null, execAsk: null, bestAsk: null } })];
    const fb = replayFluctuationEvent(input(noBid), D0, cfg(), RESOLVE_MS);
    expect(fb.exitKind).toBe('taker_time_stop');
    expect(fb.exitPrice).toBeCloseTo(0.17, 9);
  });

  it('settles at resolution ($1/$0, no exit fee) or marks to the last bid when unresolved', () => {
    const win = replayFluctuationEvent(input(dipTicks(), 1), D0, cfg(), RESOLVE_MS);
    expect(win.exitKind).toBe('resolution_settle:win');
    expect(win.exitPrice).toBe(1);
    const shares = 20 / 0.16;
    expect(win.feeUsd).toBeCloseTo(takerFeePerShare(0.16, 0.05) * shares, 9); // the entry leg only
    const lose = replayFluctuationEvent(input(dipTicks(), 0), D0, cfg(), RESOLVE_MS);
    expect(lose.exitKind).toBe('resolution_settle:lose');
    expect(lose.exitPrice).toBe(0);
    const mtm = replayFluctuationEvent(input(dipTicks(), null), D0, cfg(), RESOLVE_MS);
    expect(mtm.exitKind).toBe('mtm_unresolved');
    expect(mtm.exitPrice).toBeCloseTo(0.13, 9); // the dip tick's own bid is the last seen
  });
});

describe('replayFluctuationPanel', () => {
  const winEvent = (): EventReplayInput => ({
    ...input([...dipTicks(), tick(60, { 1: { execBid: 0.45, mid: 0.46, execAsk: 0.47 } })]),
    eventId: 'W',
  });
  const mtmEvent = (): EventReplayInput => ({ ...input(dipTicks(), null), eventId: 'M' });

  it('scores REALIZED trades only (mtm excluded from the gate) and threads VerdictOpts', () => {
    // a second realized market in another city on another DAY, so the day-clustered CI has ≥2 clusters.
    const win2: EventReplayInput = { ...winEvent(), eventId: 'W2', city: 'paris', targetDate: '2026-06-21' };
    const items = [{ event: winEvent(), dists: D0 }, { event: win2, dists: D0 }, { event: mtmEvent(), dists: D0 }];
    const resolves = new Map<string, number | null>([
      ['W', RESOLVE_MS], ['W2', RESOLVE_MS + 86_400_000], ['M', RESOLVE_MS],
    ]);
    const p = replayFluctuationPanel(items, cfg(), resolves);
    expect(p.nExecuted).toBe(3);
    expect(p.nRealized).toBe(2);
    expect(p.verdict.label).toBe('INSUFFICIENT_DATA'); // the frozen floors hold
    // relaxed floors + the day-block tightening → the day-block fields must be present and finite
    const tight = replayFluctuationPanel(items, cfg(), resolves, {
      minMarkets: 1, minCities: 1, minDistinctDays: 1, dayBlockNull: true,
    });
    expect(typeof tight.verdict.zeroSkillPassRateDayBlock).toBe('number');
    expect(Number.isFinite(tight.verdict.dayBlockCiLow)).toBe(true);
  });

  it('skips grading_mismatch events entirely', () => {
    const gm = { ...winEvent(), resolution: { winnerIdx: 1, gradingMismatch: true } };
    const p = replayFluctuationPanel([{ event: gm, dists: D0 }], cfg(), new Map([['W', RESOLVE_MS]]));
    expect(p.nExecuted).toBe(0);
  });

  it('is total on junk', () => {
    expect(replayFluctuationEvent(null as unknown as EventReplayInput, [], cfg(), null).executed).toBe(false);
    expect(replayFluctuationEvent(input([]), D0, cfg(), RESOLVE_MS).exitKind).toBe('no_ticks');
    const junkDists = [{ madeAtMs: NaN, probsByIdx: new Map() }, null] as unknown as FluctuationDist[];
    expect(replayFluctuationEvent(input(dipTicks()), junkDists, cfg(), RESOLVE_MS).exitKind).toBe('no_dist');
    const p = replayFluctuationPanel(
      [null, { event: null }, { event: input(dipTicks()), dists: D0 }] as unknown as Parameters<typeof replayFluctuationPanel>[0],
      cfg(), new Map(),
    );
    expect(p.verdict.label).toBe('INSUFFICIENT_DATA');
  });
});

describe('helpers', () => {
  it('activeDistIdx: −1 before the first dist, exact made_at is visible, latest wins after', () => {
    const ds = [dist(iso(0), 1), dist(iso(60), 2)];
    expect(activeDistIdx(ds, new Date(iso(-10)).getTime())).toBe(-1);
    expect(activeDistIdx(ds, new Date(iso(0)).getTime())).toBe(0);
    expect(activeDistIdx(ds, new Date(iso(60)).getTime())).toBe(1);
    expect(activeDistIdx(ds, new Date(iso(999)).getTime())).toBe(1);
    expect(activeDistIdx([], 0)).toBe(-1);
  });

  it('distCenterIdx: argmax prob; −1 on empty/junk', () => {
    expect(distCenterIdx(new Map([[3, 0.5], [1, 0.2]]))).toBe(3);
    expect(distCenterIdx(new Map())).toBe(-1);
    expect(distCenterIdx(new Map([[0, NaN]]))).toBe(-1);
  });
});
