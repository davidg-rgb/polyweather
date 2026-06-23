/**
 * getReplicaSim (0053) — the /replica loader scores persisted positions through the SAME core engine the
 * scripts use (scoreLocked → summarize/dailyLedger/rankCitiesByRoi). Pure unit test over a stubbed WebDb:
 * a crafted dash_replica_sim payload goes in, the three-curve roll-up comes out, checked against by-hand
 * expectations (incl. the adverse-selection case where the cheap bid fills on the LOSER, not the winner).
 */
import { describe, expect, it } from 'vitest';
import { getReplicaSim } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throws?: boolean } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throws) throw new Error('rpc absent');
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

const pos = (over: Record<string, unknown>) => ({
  source: 'backtest',
  conditionId: 'c',
  eventId: 'e',
  citySlug: 'chicago',
  region: 'us',
  targetDate: '2026-05-01',
  bucketIdx: 3,
  bucketLabel: '70–71°F',
  resolutionTs: 1_700_000_000,
  entryTs: 1_699_870_000,
  entryDayUtc: '2026-04-29',
  makerPrice: 0.2,
  takerPrice: 0.25,
  stakeUsd: 12,
  feeRate: 0,
  bucketWon: true,
  makerRealisticFilled: true,
  status: 'resolved',
  placedAtUtc: null,
  closedAtUtc: null,
  ...over,
});

const STRAT = {
  cheapBandLo: 0.1, cheapBandHi: 0.25, entryLeadHours: 36, breadthPerCityDay: 3,
  positionStakeUsd: 12, dailyBankrollCapUsd: 250, tickSize: 0.01, feeRate: 0.05,
};

describe('getReplicaSim — three-curve roll-up + open positions (0053)', () => {
  // Backtest: A (winner, maker bid does NOT fill realistically), B (loser, maker bid DOES fill) — the §12
  // adverse-selection shape (cheap bids land on the losers). makerIdeal + taker always fill.
  //   makerIdeal:     A won (12@0.2 → +48), B lost (−12)  → nResolved 2, gross 36, ROI 36/24 = 1.5
  //   makerRealistic: only B filled (loser, −12)          → nResolved 1, gross −12, ROI −1.0
  //   taker:          A won (12@0.25 → +36), B lost (−12) → nResolved 2, gross 24, ROI 24/24 = 1.0
  const payload = {
    positions: [
      pos({ eventId: 'A', citySlug: 'chicago', targetDate: '2026-05-01', makerPrice: 0.2, takerPrice: 0.25, bucketWon: true, makerRealisticFilled: false }),
      pos({ eventId: 'B', citySlug: 'denver', targetDate: '2026-05-02', makerPrice: 0.1, takerPrice: 0.15, bucketWon: false, makerRealisticFilled: true }),
      // forward: one resolved winner + one open (awaiting resolution).
      pos({ source: 'forward', eventId: 'F1', citySlug: 'beijing', targetDate: '2026-06-22', makerPrice: 0.2, takerPrice: 0.22, bucketWon: true, makerRealisticFilled: true, status: 'resolved', placedAtUtc: '2026-06-20T07:00:00Z' }),
      pos({ source: 'forward', eventId: 'F2', citySlug: 'busan', targetDate: '2026-06-24', makerPrice: 0.18, takerPrice: 0.21, bucketWon: null, makerRealisticFilled: false, status: 'open', placedAtUtc: '2026-06-23T07:00:00Z' }),
    ],
    runs: {
      backtest: { mode: 'backtest', ranAt: '2026-06-23T06:00:00Z', seedFrom: '2026-04-21', seedTo: '2026-06-21', whitelist: [], strat: STRAT, nCandidates: 5000, nBand: 900, nSelected: 300, nAllocated: 180, nOpen: 0, nClosed: 180, nOpened: 0, nReconciled: 0 },
      forward: { mode: 'forward', ranAt: '2026-06-23T07:08:00Z', seedFrom: '2026-04-21', seedTo: null, whitelist: ['chicago', 'beijing', 'busan'], strat: STRAT, nCandidates: 0, nBand: 0, nSelected: 0, nAllocated: 2, nOpen: 1, nClosed: 1, nOpened: 1, nReconciled: 0 },
    },
    recentRuns: [{ mode: 'forward', ranAt: '2026-06-23T07:08:00Z', nOpen: 1, nClosed: 1, nOpened: 1, nReconciled: 0 }],
  };

  it('rolls the backtest curves + the two tax deltas up by hand', async () => {
    const v = (await getReplicaSim(stubDb(payload)))!;
    expect(v).not.toBeNull();
    const b = v.backtest.summary;
    expect(b.makerIdeal.nResolved).toBe(2);
    expect(b.makerIdeal.roiGross).toBeCloseTo(1.5, 10);
    expect(b.makerRealistic.nResolved).toBe(1); // only the loser's bid filled
    expect(b.makerRealistic.roiGross).toBeCloseTo(-1.0, 10);
    expect(b.taker.nResolved).toBe(2);
    expect(b.taker.roiGross).toBeCloseTo(1.0, 10);
    expect(b.spreadTaxRoi).toBeCloseTo(0.5, 10); // 1.5 − 1.0
    expect(b.adverseSelTaxRoi).toBeCloseTo(2.5, 10); // 1.5 − (−1.0)
    expect(b.makerFillRate).toBeCloseTo(0.5, 10); // 1 of 2 rests filled
    expect(v.backtest.daily.length).toBe(2);
  });

  it('separates the forward scope + lists open positions soonest-first', async () => {
    const v = (await getReplicaSim(stubDb(payload)))!;
    expect(v.forward.summary.makerIdeal.nResolved).toBe(1);
    expect(v.forward.summary.makerIdeal.roiGross).toBeCloseTo(4.0, 10); // 12@0.2 won → +48 on 12
    expect(v.forwardPlaced).toBe(2);
    expect(v.forwardResolved).toBe(1);
    expect(v.forwardOpen).toBe(1);
    expect(v.backtestResolved).toBe(2);
    expect(v.open).toHaveLength(1);
    expect(v.open[0]!.citySlug).toBe('busan');
    expect(v.open[0]!.stakeUsd).toBe(12);
  });

  it('surfaces the strategy + whitelist + backtest funnel from the run rows', async () => {
    const v = (await getReplicaSim(stubDb(payload)))!;
    expect(v.strat.positionStakeUsd).toBe(12);
    expect(v.strat.cheapBandLo).toBe(0.1);
    expect(v.whitelist).toEqual(['chicago', 'beijing', 'busan']);
    expect(v.backtestFunnel).toEqual({ nCandidates: 5000, nBand: 900, nSelected: 300, nAllocated: 180 });
    expect(v.lastForwardRunAt).toBe('2026-06-23T07:08:00Z');
    expect(v.hasData).toBe(true);
  });

  it('degrades to the §15 default strategy + empty scopes when no positions/runs exist', async () => {
    const v = (await getReplicaSim(stubDb({ positions: [], runs: { backtest: null, forward: null }, recentRuns: [] })))!;
    expect(v.hasData).toBe(false);
    expect(v.strat.positionStakeUsd).toBe(12); // DEFAULT_REPLICA_STRATEGY
    expect(v.backtest.summary.makerIdeal.nResolved).toBe(0);
    expect(v.open).toEqual([]);
  });

  it('returns null when the RPC errors (degraded page)', async () => {
    expect(await getReplicaSim(stubDb(payload, { throws: true }))).toBeNull();
  });
});
