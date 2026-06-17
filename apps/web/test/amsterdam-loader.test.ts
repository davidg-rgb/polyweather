/**
 * getAmsterdamSim (0042) — the per-arm hit/edge/EV confidence-interval wiring. Pure unit test over a
 * stubbed WebDb (no PGlite): a crafted dash_amsterdam_sim payload with betsByArm goes in, the computed
 * CI bundle comes out, exercised against by-hand expectations. Mirrors the core/sim/stats armEdgeStats
 * contract from the loader's side (the page just renders these numbers).
 */
import { describe, expect, it } from 'vitest';
import { getAmsterdamSim } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throws?: boolean } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throws) throw new Error('rpc absent');
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

const armPoint = (hour: number, over: Record<string, unknown> = {}) => ({
  hour, nBets: 0, nGraded: 0, nPending: 0, nWon: 0, staked: 0, pnl: 0, roi: 0,
  hitRate: 0, avgAsk: 0, pnlAtCompare: 0, ...over,
});

const repeat = <T,>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

describe('getAmsterdamSim — edge/EV confidence intervals (0042)', () => {
  // arm 13: 12 graded, 6 wins, constant ask 0.3 → edge = 0.5 − 0.3 = 0.2 ; EV = (6·(1/0.3−1) − 6)/12.
  // arm 15: 5 graded, all wins, constant ask 0.85 → edge = 0.15 (degenerate CI), EV = 1/0.85−1 (degenerate).
  const payload = {
    config: { primaryHour: 15, armHours: [13, 14, 15, 16], compareDays: 14, stakeUsd: 10 },
    coverage: { firstDate: '2026-06-01', lastDate: '2026-06-10', nDays: 10, nGradedDays: 10, nPending: 0 },
    arms: [
      armPoint(15, { nBets: 5, nGraded: 5, nWon: 5, staked: 50, pnl: 1, hitRate: 1, avgAsk: 0.85, nTruth: 5, truthHitRate: 0.8, mae: 0.4, bias: -0.1 }),
      armPoint(13, { nBets: 12, nGraded: 12, nWon: 6, staked: 120, pnl: 5, hitRate: 0.5, avgAsk: 0.3, nTruth: 12, truthHitRate: 0.5, mae: 0.9, bias: 0.3 }),
    ],
    leader: { hour: 13, pnl: 5, nGraded: 12 },
    equityByArm: { '13': [{ date: '2026-06-01', cum: 5 }], '15': [{ date: '2026-06-01', cum: 1 }] },
    betsByArm: {
      '13': [...repeat(6, { won: true, ask: 0.3 }), ...repeat(6, { won: false, ask: 0.3 })],
      '15': repeat(5, { won: true, ask: 0.85 }),
    },
    truthByArm: {
      '13': [...repeat(6, { truthWon: true, signedErrorC: 0.3 }), ...repeat(6, { truthWon: false, signedErrorC: -0.5 })],
      '15': repeat(5, { truthWon: true, signedErrorC: -0.1 }),
    },
    truthCoverage: { nBetsWithTruth: 17, nDaysWithTruth: 10, tableFirstDate: '2024-01-01', tableLastDate: '2026-06-10', tableNDays: 880 },
    betLog: [],
    latest: { date: '2026-06-10', byHour: {} },
  };

  it('computes Wilson/edge/EV CIs per arm, sorted by hour, leader flagged', async () => {
    const v = (await getAmsterdamSim(stubDb(payload)))!;
    expect(v).not.toBeNull();
    expect(v.arms.map((a) => a.hour)).toEqual([13, 15]); // sorted

    const a13 = v.arms.find((a) => a.hour === 13)!;
    expect(a13.isLeader).toBe(true);
    // edge = mean(won − ask) = 0.2 ; its CI brackets the point estimate
    expect(a13.edge).toBeCloseTo(0.2, 10);
    expect(a13.edgeCiLo).toBeLessThan(0.2);
    expect(a13.edgeCiHi).toBeGreaterThan(0.2);
    // EV/$1 = (6·(1/0.3−1) + 6·(−1)) / 12 = 0.6667
    expect(a13.ev).toBeCloseTo((6 * (1 / 0.3 - 1) - 6) / 12, 6);
    expect(a13.evCiLo).toBeLessThanOrEqual(a13.ev);
    expect(a13.evCiHi).toBeGreaterThanOrEqual(a13.ev);
    // Wilson hit CI brackets 0.5 and stays in [0,1]
    expect(a13.hitCiLo).toBeGreaterThanOrEqual(0);
    expect(a13.hitCiLo).toBeLessThan(0.5);
    expect(a13.hitCiHi).toBeGreaterThan(0.5);
    expect(a13.hitCiHi).toBeLessThanOrEqual(1);
  });

  it('a constant-outcome arm yields a degenerate (collapsed) CI', async () => {
    const v = (await getAmsterdamSim(stubDb(payload)))!;
    const a15 = v.arms.find((a) => a.hour === 15)!;
    expect(a15.edge).toBeCloseTo(0.15, 10);
    expect(a15.edgeCiLo).toBeCloseTo(0.15, 10); // all 5 gaps identical → SE 0
    expect(a15.edgeCiHi).toBeCloseTo(0.15, 10);
    expect(a15.ev).toBeCloseTo(1 / 0.85 - 1, 10);
    expect(a15.evCiLo).toBeCloseTo(a15.evCiHi, 10); // bootstrap of identical values → no spread
  });

  it('degrades to NaN CIs when betsByArm is absent (page deploys ahead of 0042)', async () => {
    const noBets = { ...payload, betsByArm: undefined };
    const v = (await getAmsterdamSim(stubDb(noBets)))!;
    const a13 = v.arms.find((a) => a.hour === 13)!;
    expect(Number.isNaN(a13.edge)).toBe(true);
    expect(Number.isNaN(a13.ev)).toBe(true);
    // n=0 Wilson is the maximally-uncertain [0,1] by design (not NaN) — no evidence, full width
    expect(a13.hitCiLo).toBe(0);
    expect(a13.hitCiHi).toBe(1);
    // the point-estimate fields from the RPC still flow through
    expect(Number(a13.hitRate)).toBe(0.5);
  });

  it('computes floor-truth Wilson/bias CIs per arm and passes truthCoverage through (0043)', async () => {
    const v = (await getAmsterdamSim(stubDb(payload)))!;
    const a13 = v.arms.find((a) => a.hour === 13)!;
    // truth hit-rate point (from RPC) is 0.5; the Wilson CI brackets it and stays in [0,1]
    expect(Number(a13.truthHitRate)).toBe(0.5);
    expect(a13.truthHitCiLo).toBeGreaterThanOrEqual(0);
    expect(a13.truthHitCiLo).toBeLessThan(0.5);
    expect(a13.truthHitCiHi).toBeGreaterThan(0.5);
    expect(a13.truthHitCiHi).toBeLessThanOrEqual(1);
    // bias = mean signed error = (6·0.3 + 6·(−0.5))/12 = −0.1 ; its CI brackets the point
    expect(a13.biasCiLo).toBeLessThan(-0.1 + 1e-9);
    expect(a13.biasCiHi).toBeGreaterThan(-0.1 - 1e-9);

    const a15 = v.arms.find((a) => a.hour === 15)!;
    expect(a15.truthHitCiHi).toBeCloseTo(1, 6); // 5/5 wins → Wilson upper clamps to 1
    expect(a15.truthHitCiLo).toBeGreaterThan(0); // …lo is informative, < 1
    expect(a15.truthHitCiLo).toBeLessThan(1);
    expect(a15.biasCiLo).toBeCloseTo(-0.1, 10); // all signed errors identical → SE 0 → degenerate
    expect(a15.biasCiHi).toBeCloseTo(-0.1, 10);

    expect(v.truthCoverage?.tableNDays).toBe(880);
    expect(v.truthCoverage?.nBetsWithTruth).toBe(17);
  });

  it('truthCoverage is null when the RPC predates 0043', async () => {
    const noTruth = { ...payload, truthCoverage: undefined, truthByArm: undefined };
    const v = (await getAmsterdamSim(stubDb(noTruth)))!;
    expect(v.truthCoverage).toBeNull();
    const a13 = v.arms.find((a) => a.hour === 13)!;
    // no truthByArm → n=0 Wilson is [0,1]; bias CIs NaN
    expect(a13.truthHitCiLo).toBe(0);
    expect(a13.truthHitCiHi).toBe(1);
    expect(Number.isNaN(a13.biasCiLo)).toBe(true);
  });

  it('returns null when the RPC errors (degraded page)', async () => {
    expect(await getAmsterdamSim(stubDb(payload, { throws: true }))).toBeNull();
  });

  it('still carries equity forward onto the shared date axis', async () => {
    const v = (await getAmsterdamSim(stubDb(payload)))!;
    expect(v.chart.dates).toContain('2026-06-01');
    expect(v.chart.byHour[13]).toBeTruthy();
  });
});

describe('getAmsterdamSim — best-time fusion + hero chart (0044)', () => {
  // A June day with four armed lock hours, the latest day's running max climbing, and a hot forecast.
  const payload = {
    config: { primaryHour: 15, armHours: [13, 14, 15, 16], compareDays: 14, stakeUsd: 10 },
    coverage: { firstDate: '2026-06-01', lastDate: '2026-06-15', nDays: 15, nGradedDays: 14, nPending: 1 },
    arms: [13, 14, 15, 16].map((hour, i) => ({
      hour, nBets: 14, nGraded: 14, nPending: 0, nWon: 7 + i, staked: 140, pnl: i, roi: 0,
      hitRate: [0.45, 0.6, 0.82, 0.95][i], avgAsk: [0.34, 0.55, 0.8, 0.97][i], pnlAtCompare: 0,
    })),
    leader: { hour: 15, pnl: 3, nGraded: 14 },
    equityByArm: { '15': [{ date: '2026-06-15', cum: 3 }] },
    betsByArm: {},
    betLog: [],
    latest: {
      date: '2026-06-15',
      byHour: {
        13: { predictedC: 26, label: null, ask: 0.34, runMaxC: 24.5, forecastC: 28, status: 'pending', won: null, pnl: 0, actualC: null, actualDecimalC: null, signedErrorC: null, truthWon: null },
        15: { predictedC: 27, label: null, ask: 0.8, runMaxC: 26.8, forecastC: 28, status: 'pending', won: null, pnl: 0, actualC: null, actualDecimalC: null, signedErrorC: null, truthWon: null },
      },
    },
  };
  const june = new Date('2026-06-15T12:00:00Z');

  it('builds a best-time view for the injected month with one row per armed hour', async () => {
    const v = (await getAmsterdamSim(stubDb(payload), { now: june }))!;
    expect(v.bestTime.month).toBe(6);
    expect(v.bestTime.rows.map((r) => r.hour)).toEqual([13, 14, 15, 16]);
    expect(v.bestTime.recommendedHour).not.toBeNull();
    // Each row fuses floor confidence (climatology) with the empirical hit rate it was given.
    const r15 = v.bestTime.rows.find((r) => r.hour === 15)!;
    expect(r15.empiricalHitRate).toBe(0.82);
    expect(r15.floorConfidence).toBeGreaterThan(0);
    expect(r15.predictiveConfidence).toBeGreaterThan(0);
  });

  it('selects the hot-day climatology when the latest forecast is ≥25°C', async () => {
    const v = (await getAmsterdamSim(stubDb(payload), { now: june }))!;
    expect(v.bestTime.hot).toBe(true);
    expect(v.bestTime.usedHotClimatology).toBe(true);
    expect(v.peakHourChart.hot).toBe(true);
  });

  it('assembles the hero chart: 24h curves, peak band, and the latest live running-max overlay', async () => {
    const v = (await getAmsterdamSim(stubDb(payload), { now: june }))!;
    const c = v.peakHourChart;
    expect(c.avgTempC).toHaveLength(24);
    expect(c.avgRunMaxC).toHaveLength(24);
    expect(c.peakHistogram).toHaveLength(24);
    expect(c.peakWindow.fromHour).toBeLessThanOrEqual(c.peakWindow.modeHour);
    expect(c.latestDate).toBe('2026-06-15');
    // Only the two armed hours with a runMaxC become overlay points.
    expect(c.todayRunMax).toEqual([
      { hour: 13, runMaxC: 24.5 },
      { hour: 15, runMaxC: 26.8 },
    ]);
    expect(c.recommendedHour).toBe(v.bestTime.recommendedHour);
  });
});

describe('getAmsterdamSim — present-but-null coercion (the toNum/num null-guard)', () => {
  const latestRow = (over: Record<string, unknown>) => ({
    predictedC: 26, label: null, ask: 0.8, runMaxC: 25, forecastC: 28, status: 'pending', won: null,
    pnl: 0, actualC: null, actualDecimalC: null, signedErrorC: null, truthWon: null, ...over,
  });
  const base = {
    config: { primaryHour: 15, armHours: [13, 14, 15, 16], compareDays: 14, stakeUsd: 10 },
    coverage: { firstDate: '2026-06-01', lastDate: '2026-06-15', nDays: 15, nGradedDays: 14, nPending: 1 },
    arms: [13, 14, 15, 16].map((hour) => ({
      hour, nBets: 0, nGraded: 0, nPending: 0, nWon: 0, staked: 0, pnl: 0, roi: 0, hitRate: 0, avgAsk: 0, pnlAtCompare: 0,
    })),
    leader: null,
    equityByArm: {},
    betsByArm: {},
    betLog: [],
  };
  const june = new Date('2026-06-15T12:00:00Z');

  it('selects the hot climatology when only a LATER arm carries the forecast (early arm null)', async () => {
    // Early arm 13 has forecastC=null; primary arm 15 has 28. A null must NOT short-circuit to 0 (cold).
    const payload = {
      ...base,
      latest: { date: '2026-06-15', byHour: { 13: latestRow({ forecastC: null }), 15: latestRow({ forecastC: 28 }) } },
    };
    const v = (await getAmsterdamSim(stubDb(payload), { now: june }))!;
    expect(v.bestTime.hot).toBe(true);
    expect(v.bestTime.usedHotClimatology).toBe(true);
    expect(v.peakHourChart.hot).toBe(true);
  });

  it('drops a null running-max arm from the overlay (no phantom 0°C point)', async () => {
    const payload = {
      ...base,
      latest: { date: '2026-06-15', byHour: { 13: latestRow({ runMaxC: null }), 15: latestRow({ runMaxC: 26.8 }) } },
    };
    const v = (await getAmsterdamSim(stubDb(payload), { now: june }))!;
    expect(v.peakHourChart.todayRunMax).toEqual([{ hour: 15, runMaxC: 26.8 }]);
    expect(v.peakHourChart.todayRunMax.some((p) => p.runMaxC === 0)).toBe(false);
  });
});

describe('getAmsterdamSim — floor-truth point estimates share the CI population (0044)', () => {
  it('excludes a truth row with null signed error from BOTH nTruth and its CI', async () => {
    const payload = {
      config: { primaryHour: 15, armHours: [13, 14, 15, 16], compareDays: 14, stakeUsd: 10 },
      coverage: { firstDate: '2026-06-01', lastDate: '2026-06-10', nDays: 10, nGradedDays: 10, nPending: 0 },
      arms: [{ hour: 15, nBets: 2, nGraded: 2, nPending: 0, nWon: 2, staked: 20, pnl: 1, roi: 0, hitRate: 1, avgAsk: 0.85, pnlAtCompare: 0, nTruth: 2, truthHitRate: 1, mae: 0.4, bias: 0.1 }],
      leader: null,
      equityByArm: {},
      betsByArm: {},
      // one usable truth row + one with a null signed error (e.g. a null running max) → must drop from both
      truthByArm: { '15': [{ truthWon: true, signedErrorC: 0.3 }, { truthWon: true, signedErrorC: null }] },
      betLog: [],
      latest: { date: '2026-06-10', byHour: {} },
    };
    const v = (await getAmsterdamSim(stubDb(payload), { now: new Date('2026-06-10T12:00:00Z') }))!;
    const a15 = v.arms.find((a) => a.hour === 15)!;
    // point estimate now recomputed from the CI bundle → n=1 (the finite-signed-error row), not the RPC's 2.
    expect(Number(a15.nTruth)).toBe(1);
  });
});
