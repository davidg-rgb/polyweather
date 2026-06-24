/**
 * getMarketRewards + getWhaleTracker (0058) — the /rewards + /whaletracker loaders. Pure unit tests over a
 * stubbed WebDb: a crafted dash_* jsonb payload goes in, the typed view comes out (passthrough + defaults),
 * and an RPC error degrades to null (so the page can deploy ahead of the RPC).
 */
import { describe, expect, it } from 'vitest';
import { getMarketRewards, getWhaleTracker } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throws?: boolean } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throws) throw new Error('rpc absent');
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

describe('getMarketRewards (0058)', () => {
  const payload = {
    series: [
      { capturedAt: '2026-06-24T10:00:00Z', nMarkets: 2, totalPoolUsd: '150', totalInBandUsd: '2000' },
      { capturedAt: '2026-06-24T10:20:00Z', nMarkets: 2, totalPoolUsd: '180', totalInBandUsd: '3800' },
    ],
    latest: { capturedAt: '2026-06-24T10:20:00Z', nMarkets: 2, totalPoolUsd: '180', totalInBandUsd: '3800' },
    topMarkets: [{ slug: 'amsterdam-high', dailyPoolUsd: '120', mid: '0.51', bestBid: '0.49', bestAsk: '0.53', bidDepthUsd: '2000', askDepthUsd: '1000', maxSpreadCents: '3' }],
  };

  it('passes the payload through and echoes the requested window', async () => {
    const v = (await getMarketRewards(stubDb(payload), { days: 7 }))!;
    expect(v).not.toBeNull();
    expect(v.series).toHaveLength(2);
    expect(v.latest!.totalPoolUsd).toBe('180');
    expect(v.topMarkets[0]!.slug).toBe('amsterdam-high');
    expect(v.days).toBe(7);
  });

  it('defaults arrays + latest when the RPC returns a sparse object', async () => {
    const v = (await getMarketRewards(stubDb({}), {}))!;
    expect(v.series).toEqual([]);
    expect(v.topMarkets).toEqual([]);
    expect(v.latest).toBeNull();
    expect(v.days).toBe(7); // default window
  });

  it('returns null when the RPC errors (degraded page)', async () => {
    expect(await getMarketRewards(stubDb(payload, { throws: true }))).toBeNull();
  });
});

describe('getWhaleTracker (0058)', () => {
  const payload = {
    bets: [
      { tradedAt: '2026-06-24T11:00:00Z', proxyWallet: '0xaaa', trader: 'WhaleA', side: 'BUY', outcome: 'Yes', title: 'France spread', notionalUsd: '753000', price: '0.0627', sizeShares: '12000', link: 'https://polymarket.com/event/france', txHash: '0xtx1', eventSlug: 'france' },
      { tradedAt: '2026-06-22T11:00:00Z', proxyWallet: '0xbbb', trader: '0xbbb', side: 'SELL', outcome: 'No', title: 'UK rain', notionalUsd: '200000', price: '0.40', sizeShares: '5000', link: null, txHash: '0xtx2', eventSlug: 'uk' },
    ],
    daily: [
      { date: '2026-06-22', count: 1, totalUsd: '200000' },
      { date: '2026-06-24', count: 1, totalUsd: '753000' },
    ],
    meta: { days: 10, minUsd: '100000', count: 2, totalUsd: '953000' },
  };

  it('passes the payload through', async () => {
    const v = (await getWhaleTracker(stubDb(payload), { days: 10, minUsd: 100_000 }))!;
    expect(v.bets).toHaveLength(2);
    expect(v.bets[0]!.txHash).toBe('0xtx1');
    expect(v.daily).toHaveLength(2);
    expect(Number(v.meta.count)).toBe(2);
  });

  it('defaults to empty arrays + a synthesized meta when the RPC returns a sparse object', async () => {
    const v = (await getWhaleTracker(stubDb({}), {}))!;
    expect(v.bets).toEqual([]);
    expect(v.daily).toEqual([]);
    expect(v.meta).toEqual({ days: 10, minUsd: 100_000, count: 0, totalUsd: 0 });
  });

  it('returns null when the RPC errors (degraded page)', async () => {
    expect(await getWhaleTracker(stubDb(payload, { throws: true }))).toBeNull();
  });
});
