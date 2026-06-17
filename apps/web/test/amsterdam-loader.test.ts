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
      armPoint(15, { nBets: 5, nGraded: 5, nWon: 5, staked: 50, pnl: 1, hitRate: 1, avgAsk: 0.85 }),
      armPoint(13, { nBets: 12, nGraded: 12, nWon: 6, staked: 120, pnl: 5, hitRate: 0.5, avgAsk: 0.3 }),
    ],
    leader: { hour: 13, pnl: 5, nGraded: 12 },
    equityByArm: { '13': [{ date: '2026-06-01', cum: 5 }], '15': [{ date: '2026-06-01', cum: 1 }] },
    betsByArm: {
      '13': [...repeat(6, { won: true, ask: 0.3 }), ...repeat(6, { won: false, ask: 0.3 })],
      '15': repeat(5, { won: true, ask: 0.85 }),
    },
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

  it('returns null when the RPC errors (degraded page)', async () => {
    expect(await getAmsterdamSim(stubDb(payload, { throws: true }))).toBeNull();
  });

  it('still carries equity forward onto the shared date axis', async () => {
    const v = (await getAmsterdamSim(stubDb(payload)))!;
    expect(v.chart.dates).toContain('2026-06-01');
    expect(v.chart.byHour[13]).toBeTruthy();
  });
});
