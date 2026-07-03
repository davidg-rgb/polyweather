/**
 * Tests for scripts/research/sim-maker-exit — the pure improvement-lever helpers (2026-07-03):
 *   - wilsonLower: the shrinkage bound the city gate ranks on (never the point estimate);
 *   - gateCities / CITY_GATE_PRE0613: the per-city selector-accuracy gate, fitted PRE-panel (2026-05-13 →
 *     2026-06-12) so its application to the archive replay (2026-06-13+) is temporally out-of-sample;
 *   - cfgFrom: the SimParams → MakerExitCfg plumbing for the new levers (tpMode/tpAbs/minEntryAgeH).
 */
import { describe, expect, it } from 'vitest';
import { wilsonLower, gateCities, CITY_GATE_PRE0613, cfgFrom, DEFAULT_PARAMS, run, type SimParams } from './sim-maker-exit.ts';
import {
  replayMakerExitPanel,
  replayMakerExitPanelBasket,
} from '../../packages/core/src/sim/opening-maker-exit-replay.ts';
import type { EventReplayInput, ReplayTick } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import type { OpeningBucket } from '../../packages/core/src/sim/opening-convergence.ts';

describe('wilsonLower', () => {
  it('matches the known 95% bound at p=0.5, n=100 (~0.4038)', () => {
    expect(wilsonLower(50, 100)).toBeCloseTo(0.4038, 3);
  });
  it('is 0 on an empty/degenerate sample and bounded in [0, p]', () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(5, 10)).toBeGreaterThan(0);
    expect(wilsonLower(5, 10)).toBeLessThan(0.5);
    expect(wilsonLower(10, 10)).toBeLessThan(1); // even a perfect small sample stays below 1 (shrinkage)
  });
  it('grows with n at fixed p (more evidence → a tighter bound)', () => {
    expect(wilsonLower(90, 100)).toBeGreaterThan(wilsonLower(9, 10));
  });
});

describe('gateCities (the pre-panel city gate)', () => {
  it('minLb ≤ 0 admits every table city (no gate)', () => {
    expect(gateCities(CITY_GATE_PRE0613, 'hit1', 0).length).toBe(Object.keys(CITY_GATE_PRE0613).length);
  });
  it('excludes the weak selectors and keeps the strong ones at a 0.7 hit1 floor', () => {
    const gated = new Set(gateCities(CITY_GATE_PRE0613, 'hit1', 0.7));
    expect(gated.has('madrid')).toBe(true); // 55/58 — LB ≈ .86
    expect(gated.has('karachi')).toBe(true); // 54/58
    expect(gated.has('amsterdam')).toBe(false); // 20/58 — LB ≈ .24 (the worst major selector)
    expect(gated.has('chongqing')).toBe(false); // 32/58
    expect(gated.has('lucknow')).toBe(false); // n=2 — the Wilson bound rejects the tiny sample naturally
  });
  it('hit0 gates on the exact-bucket pick (chw0 quality) — a different, stricter set', () => {
    const g0 = new Set(gateCities(CITY_GATE_PRE0613, 'hit0', 0.5));
    expect(g0.has('mexico-city')).toBe(true); // 41/58 exact — LB ≈ .58
    expect(g0.has('london')).toBe(false); // 9/58 exact
    expect(g0.size).toBeLessThan(gateCities(CITY_GATE_PRE0613, 'hit1', 0.5).length);
  });
  it('is monotone: a higher floor never admits more cities', () => {
    for (const metric of ['hit0', 'hit1'] as const) {
      let prev = gateCities(CITY_GATE_PRE0613, metric, 0).length;
      for (const lb of [0.3, 0.5, 0.6, 0.7, 0.8, 0.9]) {
        const n = gateCities(CITY_GATE_PRE0613, metric, lb).length;
        expect(n).toBeLessThanOrEqual(prev);
        prev = n;
      }
    }
  });
});

describe('cfgFrom (SimParams → MakerExitCfg plumbing)', () => {
  it('maps the new levers onto the engine cfg', () => {
    const c = cfgFrom({ ...DEFAULT_PARAMS, tpMode: 'abs', tpAbs: 0.4, minEntryAgeH: 2 }, ['madrid']);
    expect(c.tpMode).toBe('abs');
    expect(c.tpAbsTarget).toBe(0.4);
    expect(c.minEntryAgeH).toBe(2);
    expect(c.cities).toEqual(['madrid']);
  });
  it('the defaults are the historical behavior (delta mode, no age gate, no city gate)', () => {
    const c = cfgFrom(DEFAULT_PARAMS, ['madrid']);
    expect(c.tpMode).toBe('delta');
    expect(c.minEntryAgeH).toBe(0);
    expect(DEFAULT_PARAMS.cityGateLb).toBe(0);
  });

  it('SIGNAL-BACKLOG #1b: rewardCfg stays unset at the default (rewardPoolUsd=0) — byte-identical', () => {
    const c = cfgFrom(DEFAULT_PARAMS, ['madrid']);
    expect(c.rewardCfg).toBeUndefined();
  });
  it('SIGNAL-BACKLOG #1b: rewardCfg is built from rewardPoolUsd/rewardMaxSpreadCents/rewardShare once the pool is on', () => {
    const c = cfgFrom({ ...DEFAULT_PARAMS, rewardPoolUsd: 240, rewardMaxSpreadCents: 4.5, rewardShare: 0.01 }, ['madrid']);
    expect(c.rewardCfg).toEqual({ dailyPoolUsd: 240, maxSpreadCents: 4.5, myPoolShareIfQualifying: 0.01 });
  });
  it('SIGNAL-BACKLOG #5: basketSize stays unset at the default (basketSize=1) — byte-identical', () => {
    const c = cfgFrom(DEFAULT_PARAMS, ['madrid']);
    expect(c.basketSize).toBeUndefined();
  });
  it('SIGNAL-BACKLOG #5: basketSize is passed through once raised above 1', () => {
    const c = cfgFrom({ ...DEFAULT_PARAMS, basketSize: 3 }, ['madrid']);
    expect(c.basketSize).toBe(3);
  });
});

// ── run() dispatch — synthetic in-memory fixture, NO DB / NO cache (does not touch out/maker-exit-cache) ──
describe('run — basket dispatch + reward accrual wiring (SIGNAL-BACKLOG #1b/#5)', () => {
  const TZ = 'Europe/Amsterdam';
  const DATE = '2026-06-20';
  const RESOLVE_MS = new Date('2026-06-21T10:00:00Z').getTime();

  const b = (idx: number, over: Partial<OpeningBucket> = {}): OpeningBucket => ({
    idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.15, bestAsk: 0.16, execAsk: 0.16, depthUsd: 100,
    bestBid: 0.14, sellbackUsd: 100, execBid: 0.14, sellbackDepthUsd: 100, houseProb: idx === 1 ? 0.4 : 0.15,
    tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
  });
  const tick = (iso: string, age: number, center: Partial<OpeningBucket>): ReplayTick => ({
    capturedAt: iso, hoursSinceListing: age, tz: TZ, targetDate: DATE, buckets: [b(0), b(1, center), b(2)],
  });
  const input = (ticks: ReplayTick[]): EventReplayInput => ({
    eventId: 'E1', city: 'amsterdam', targetDate: DATE, tz: TZ, ticks, resolution: { winnerIdx: 1, gradingMismatch: false },
  });
  const soloTicks = (): ReplayTick[] => [
    tick('2026-06-20T00:00:00Z', 0.1, { execAsk: 0.16, bestAsk: 0.16, execBid: 0.14 }),
    // mid: 0.405 sits within maxSpreadCents(4.5c) of the exit target (entry 0.16 + tp 0.25 = 0.41) — so the
    // resting sell qualifies for reward while it waits for the final tick's bid to actually reach it.
    tick('2026-06-20T00:10:00Z', 0.3, { execAsk: 0.12, bestAsk: 0.12, execBid: 0.11, mid: 0.405 }),
    tick('2026-06-20T01:00:00Z', 1, { execBid: 0.45, execAsk: 0.46 }),
  ];
  const events = [input(soloTicks())];
  const resolves = new Map<string, number | null>([['E1', RESOLVE_MS]]);
  const baseParams: SimParams = { ...DEFAULT_PARAMS, tp: 0.25, chw: 0, maxEntry: 0.2, depth: 50, makerWindow: 15 };

  it('basketSize=1 (default) matches calling replayMakerExitPanel directly with the SAME cfgFrom cfg', () => {
    const out = run(baseParams, events, resolves, false);
    const cfg = cfgFrom(baseParams, ['amsterdam']);
    expect(cfg.basketSize).toBeUndefined(); // confirms the byte-identical cfg path
    const direct = replayMakerExitPanel(events, cfg, resolves);
    expect(out['nRealized']).toBe(direct.nRealized);
    expect(out['nExecuted']).toBe(direct.nExecuted);
    expect(out['totalNetUsd']).toBeCloseTo(direct.totalNetUsd, 9);
    expect(out['meanNetReturn']).toBeCloseTo(direct.meanNetReturn, 9);
  });

  it('basketSize>1 dispatches to replayMakerExitPanelBasket with the SAME cfgFrom cfg', () => {
    const p: SimParams = { ...baseParams, chw: 1, basketSize: 2 };
    const out = run(p, events, resolves, false);
    const cfg = cfgFrom(p, ['amsterdam']);
    expect(cfg.basketSize).toBe(2);
    const direct = replayMakerExitPanelBasket(events, cfg, resolves);
    expect(out['nRealized']).toBe(direct.nRealized);
    expect(out['totalNetUsd']).toBeCloseTo(direct.totalNetUsd, 9);
  });

  it('turning on the reward pool strictly improves totalNetUsd over the identical fixture with it off', () => {
    const off = run(baseParams, events, resolves, false);
    const on = run({ ...baseParams, rewardPoolUsd: 240, rewardMaxSpreadCents: 4.5, rewardShare: 0.02 }, events, resolves, false);
    expect(on['totalNetUsd'] as number).toBeGreaterThan(off['totalNetUsd'] as number);
  });

  it('rewardPoolUsd=0 (default) leaves totalNetUsd unchanged — byte-identical', () => {
    const a = run(baseParams, events, resolves, false);
    const b2 = run({ ...baseParams, rewardPoolUsd: 0 }, events, resolves, false);
    expect(a['totalNetUsd']).toBe(b2['totalNetUsd']);
  });
});
