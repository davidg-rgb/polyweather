/**
 * getOperation (0124, the live cheap-early operation) — a crafted dash_operation payload goes in; the
 * passthrough + null-tolerant array defaults come out. Pure unit test over a stubbed WebDb (no PGlite).
 * Mirrors city-live-loader.test.ts / the getCheapEarly idiom.
 *
 * The load-bearing behaviours: a missing/erroring RPC degrades to null (the page ships ahead of the
 * migration rather than 500ing), absent collections become [] (day-1 armed-but-no-fills is a normal state,
 * not an error), and `lane` is the required discriminator — a payload without it is treated as no feed.
 */
import { describe, expect, it } from 'vitest';
import { getOperation } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throwsMessage?: string } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throwsMessage != null) throw new Error(opts.throwsMessage);
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

const LANE = {
  since: '2026-08-09',
  mode: 'live',
  activeUntil: '2026-09-15',
  stakePerBuyUsd: 5,
  allowlistSize: 46,
  tickEnabled: true,
  askFloor: 0.2,
  priceCap: 0.33,
  leadMinH: 24,
  leadMaxH: 36,
  maxBuysPerDay: 4,
  stopAfterFirstSuccess: false,
  buysToday: 1,
  laneHalted: false,
  override: { active: true, reason: 'operator-directed', expiresAt: '2026-09-08', createdAt: '2026-08-09', daysLeft: 30 },
};

const MONEY = {
  nOrders: 3, nFilled: 2, nResolved: 1, nWins: 0,
  stakedUsd: 10, realizedUsd: -5, atRiskUsd: 5, winRate: 0, meanNetPerDollar: -1,
};

describe('getOperation (dash_operation, 0124)', () => {
  it('passes the full payload through', async () => {
    const payload = {
      lane: LANE,
      money: MONEY,
      equity: [{ date: '2026-08-09', realizedUsd: -5, atRiskUsd: 5, n: 2 }],
      orders: [{
        createdAt: '2026-08-09T01:00:00Z', city: 'madrid', targetDate: '2026-08-10', label: '34–34C',
        side: 'BUY', price: 0.25, avgPrice: 0.24, size: 20, sizeMatched: 20, status: 'filled',
        resolved: true, won: false, costUsd: 4.8, realizedUsd: -4.8,
      }],
      byCity: [{ city: 'madrid', n: 1, nResolved: 1, wins: 0, winRate: 0, stakedUsd: 4.8, realizedUsd: -4.8, pruneFlag: false }],
      byBand: [{ band: '[0.20,0.25)', n: 1, nResolved: 1, wins: 0, winRate: 0, stakedUsd: 4.8, realizedUsd: -4.8 }],
      benchmark: { capturedAt: '2026-08-09T10:00:00Z', gateLabel: 'INSUFFICIENT_DATA', gateReason: 'need more', nMarkets: 5, nCities: 2, meanNetReturn: null, paperRealizedUsd: -39.1, paperRoi: 0.03, paperWinRate: 0.2 },
      skipTelemetry: { at: '2026-08-09T12:00:00Z', tags: { lead_window: 40, ask_floor: 3 }, skips: 43, captures: 44, candidates: 1, degraded: false },
    };
    const out = await getOperation(stubDb(payload));
    expect(out?.lane.askFloor).toBe(0.2);
    expect(out?.lane.override?.daysLeft).toBe(30);
    expect(out?.money.realizedUsd).toBe(-5);
    expect(out?.orders[0]!.city).toBe('madrid');
    expect(out?.byCity[0]!.pruneFlag).toBe(false);
    expect(out?.skipTelemetry?.tags['lead_window']).toBe(40);
    expect(out?.benchmark?.gateLabel).toBe('INSUFFICIENT_DATA');
  });

  it('day-1 armed-but-no-fills: absent collections default to [] rather than throwing', async () => {
    const out = await getOperation(stubDb({ lane: LANE, money: MONEY }));
    expect(out).not.toBeNull();
    expect(out?.equity).toEqual([]);
    expect(out?.orders).toEqual([]);
    expect(out?.byCity).toEqual([]);
    expect(out?.byBand).toEqual([]);
    expect(out?.benchmark).toBeNull();
    expect(out?.skipTelemetry).toBeNull();
  });

  it('degrades to null when the RPC is absent (the page ships ahead of migration 0124)', async () => {
    const out = await getOperation(stubDb(null, { throwsMessage: 'could not find the function public.dash_operation' }));
    expect(out).toBeNull();
  });

  it('degrades to null on ANY rpc error (never a thrown 500 on the operator dashboard)', async () => {
    expect(await getOperation(stubDb(null, { throwsMessage: 'statement timeout' }))).toBeNull();
  });

  it('a payload without `lane` is treated as no feed (the required discriminator)', async () => {
    expect(await getOperation(stubDb({ money: MONEY }))).toBeNull();
    expect(await getOperation(stubDb(null))).toBeNull();
  });
});
