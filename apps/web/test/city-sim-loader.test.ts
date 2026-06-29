/**
 * getCitySim (0070) — the multi-city paper-trade loader. A crafted dash_city_sim payload (Singapore + an
 * empty Karachi) goes in; the per-arm CI bundle + carry-forward equity axis + leader flag come out, checked
 * against by-hand expectations. Pure unit test over a stubbed WebDb (no PGlite). Mirrors amsterdam-loader.
 */
import { describe, expect, it } from 'vitest';
import { getCitySim } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throws?: boolean } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throws) throw new Error('rpc absent');
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

const repeat = <T,>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

const armPoint = (hour: number, over: Record<string, unknown> = {}) => ({
  hour, nBets: 0, nGraded: 0, nPending: 0, nWon: 0, staked: 0, pnl: 0, roi: 0, hitRate: 0, avgAsk: 0, ...over,
});

describe('getCitySim — per-arm CIs, carry-forward equity, leader', () => {
  const payload = {
    generatedAt: '2026-06-30T10:00:00Z',
    config: { stakeUsd: 10, compareDays: 14 },
    cities: [
      {
        slug: 'singapore', displayName: 'Singapore', icao: 'WSSS', unit: 'C', tz: 'Asia/Singapore',
        armHours: [11, 12, 13, 14], stakeUsd: 10,
        coverage: { firstDate: '2026-06-20', lastDate: '2026-06-29', nDays: 10, nGradedDays: 9, nPending: 4 },
        // arm 12: 12 graded, 6 wins, constant ask 0.7 → edge = mean(won−ask) = 0.5−0.7 = −0.2
        arms: [
          armPoint(12, { nBets: 12, nGraded: 12, nWon: 6, staked: 120, pnl: -8, roi: -0.066, hitRate: 0.5, avgAsk: 0.7 }),
          armPoint(11, { nBets: 12, nGraded: 12, nWon: 3, staked: 120, pnl: -30, roi: -0.25, hitRate: 0.25, avgAsk: 0.25 }),
        ],
        leader: { hour: 12 },
        totals: { pnl: -38, nGraded: 24, nWon: 9, staked: 240 },
        equityByArm: {
          '11': [{ date: '2026-06-20', cum: -10, status: 'lost' }, { date: '2026-06-22', cum: -20, status: 'lost' }],
          '12': [{ date: '2026-06-21', cum: 3, status: 'won' }],
        },
        betsByArm: {
          '12': [...repeat(6, { won: true, ask: 0.7 }), ...repeat(6, { won: false, ask: 0.7 })],
          '11': [...repeat(3, { won: true, ask: 0.25 }), ...repeat(9, { won: false, ask: 0.25 })],
        },
        betLog: [{ date: '2026-06-29', hour: 12, predictedC: 32, label: '32°C', ask: 0.7, runMaxC: 31.9, forecastC: null, status: 'pending', won: null, pnl: null, actualC: null }],
        latest: { date: '2026-06-29', byHour: { '12': { predictedC: 32, label: '32°C', ask: 0.7, status: 'pending', won: null, pnl: null, actualC: null, runMaxC: 31.9 } } },
      },
      {
        slug: 'karachi', displayName: 'Karachi', icao: 'OPKC', unit: 'C', tz: 'Asia/Karachi',
        armHours: [11, 12, 13, 14], stakeUsd: 10,
        coverage: { firstDate: null, lastDate: null, nDays: 0, nGradedDays: 0, nPending: 0 },
        arms: [], leader: null, totals: { pnl: 0, nGraded: 0, nWon: 0, staked: 0 },
        equityByArm: {}, betsByArm: {}, betLog: [], latest: { date: null, byHour: {} },
      },
    ],
    overall: { pnl: -38, nGraded: 24, nWon: 9 },
  };

  it('maps cities, computes edge CIs, flags the leader, and degrades empty cities', async () => {
    const v = (await getCitySim(stubDb(payload)))!;
    expect(v).not.toBeNull();
    expect(v.cities.map((c) => c.slug)).toEqual(['singapore', 'karachi']);

    const sg = v.cities[0]!;
    expect(sg.arms.map((a) => a.hour)).toEqual([11, 12]); // sorted by hour
    const a12 = sg.arms.find((a) => a.hour === 12)!;
    expect(a12.isLeader).toBe(true);
    expect(a12.edge).toBeCloseTo(-0.2, 10); // mean(won − ask) over 6 wins @0.7 + 6 losses @0.7
    expect(a12.edgeCiLo).toBeLessThan(-0.2);
    expect(a12.edgeCiHi).toBeGreaterThan(-0.2);
    expect(a12.hitCiLo).toBeGreaterThanOrEqual(0);
    expect(a12.hitCiHi).toBeLessThanOrEqual(1);

    // carry-forward: union axis [06-20, 06-21, 06-22]; arm 11 has no bet on 06-21 → carries -10.
    expect(sg.chart.dates).toEqual(['2026-06-20', '2026-06-21', '2026-06-22']);
    expect(sg.chart.byHour[11]).toEqual([-10, -10, -20]);
    expect(sg.chart.byHour[12]).toEqual([null, 3, 3]); // no bet until 06-21

    // empty Karachi degrades cleanly
    const khi = v.cities[1]!;
    expect(khi.arms).toEqual([]);
    expect(khi.leaderHour).toBeNull();
    expect(khi.chart.dates).toEqual([]);

    expect(v.overall.nGraded).toBe(24);
  });

  it('returns null when the RPC is absent', async () => {
    expect(await getCitySim(stubDb(null, { throws: true }))).toBeNull();
  });
});
