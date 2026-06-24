/**
 * dash_market_rewards + dash_whale_tracker (migration 0058) — the /rewards + /whaletracker read RPCs.
 *
 * End-to-end against PGlite (the real SQL functions): seed the live feeds (market_rewards 0057 + whale_trades
 * 0055), then call each RPC AS the operator and check the jsonb-object shape, the time-series aggregation, the
 * window + min-USD filters, the latest-capture headline, and the top-by-pool ordering. Plus the two guards that
 * bite in prod but not in unit tests: the 0044 jsonb-OBJECT contract (never a top-level array) and operator_guard
 * (a non-operator authenticated caller is refused).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };
const INTRUDER = { email: 'not-the-operator@example.com' };

describe('dash_market_rewards + dash_whale_tracker (0058)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();

    // Two reward captures (timestamps relative to now() so the 7-day window is wall-clock-independent).
    // Capture 1 (older): pool 150, in-band 2000. Capture 2 (latest): pool 180, in-band 3800 (capital thickened).
    await db.exec(`
      insert into public.market_rewards
        (captured_at, condition_id, slug, daily_pool_usd, max_spread_cents, mid, best_bid, best_ask, bid_depth_usd, ask_depth_usd) values
        (now() - interval '40 minutes', 'c-ams', 'amsterdam-high', 100, 3, 0.50, 0.48, 0.52, 1000, 500),
        (now() - interval '40 minutes', 'c-lon', 'london-high',     50, 3, 0.40, 0.38, 0.42,  200, 300),
        (now() - interval '20 minutes', 'c-ams', 'amsterdam-high', 120, 3, 0.51, 0.49, 0.53, 2000, 1000),
        (now() - interval '20 minutes', 'c-lon', 'london-high',     60, 3, 0.41, 0.39, 0.43,  400, 400);
    `);

    // Whale trades: w1 (753k, named, -1h), w2 (200k, anon, -2d), w3 (120k, -3d), w4 (999k, -15d → outside 10d).
    await db.exec(`
      insert into public.whale_trades
        (trade_key, transaction_hash, proxy_wallet, trader_name, condition_id, outcome, side,
         size_shares, price, notional_usd, title, event_slug, link, traded_at) values
        ('k1','0xtx1','0xaaa','WhaleA','cw1','Yes','BUY',  12000, 0.0627, 753000, 'France spread', 'france', 'https://polymarket.com/event/france', now() - interval '1 hour'),
        ('k2','0xtx2','0xbbb', null,   'cw2','No', 'SELL',  5000, 0.40,   200000, 'UK rain',       'uk',     null,                                  now() - interval '2 days'),
        ('k3','0xtx3','0xccc','WhaleC','cw3','Yes','BUY',   3000, 0.40,   120000, 'Madrid heat',   'madrid', 'https://polymarket.com/event/madrid', now() - interval '3 days'),
        ('k4','0xtx4','0xddd','WhaleD','cw4','Yes','BUY',  10000, 0.0999, 999000, 'old whale',     'old',    'https://polymarket.com/event/old',    now() - interval '15 days');
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  const rewards = (days = 7, top = 20): Promise<Record<string, unknown>> =>
    asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ out: Record<string, unknown> }>(
        db,
        `select public.dash_market_rewards($1, $2) as out`,
        [days, top],
      );
      return r[0]!.out;
    });

  const whales = (days = 10, minUsd = 0): Promise<Record<string, unknown>> =>
    asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ out: Record<string, unknown> }>(
        db,
        `select public.dash_whale_tracker($1, $2) as out`,
        [days, minUsd],
      );
      return r[0]!.out;
    });

  it('dash_market_rewards: per-capture series (ascending), latest headline, top-by-pool markets', async () => {
    const out = await rewards();
    const series = out.series as { nMarkets: number; totalPoolUsd: string; totalInBandUsd: string }[];
    expect(series).toHaveLength(2);
    // ascending: older capture first (pool 150 / in-band 2000), then latest (pool 180 / in-band 3800)
    expect(Number(series[0]!.totalPoolUsd)).toBe(150);
    expect(Number(series[0]!.totalInBandUsd)).toBe(2000);
    expect(Number(series[1]!.totalPoolUsd)).toBe(180);
    expect(Number(series[1]!.totalInBandUsd)).toBe(3800);

    const latest = out.latest as { nMarkets: number; totalPoolUsd: string; totalInBandUsd: string };
    expect(Number(latest.nMarkets)).toBe(2);
    expect(Number(latest.totalPoolUsd)).toBe(180);
    expect(Number(latest.totalInBandUsd)).toBe(3800);

    const top = out.topMarkets as { slug: string; dailyPoolUsd: string }[];
    expect(top.map((t) => t.slug)).toEqual(['amsterdam-high', 'london-high']); // pool desc
    expect(Number(top[0]!.dailyPoolUsd)).toBe(120); // latest capture's amsterdam pool
  });

  it('dash_market_rewards: p_top caps the latest-capture market list', async () => {
    const out = await rewards(7, 1);
    expect((out.topMarkets as unknown[]).length).toBe(1);
  });

  it('dash_whale_tracker: window-scoped bets newest-first, daily series, uncapped meta totals', async () => {
    const out = await whales(10, 0);
    const bets = out.bets as { txHash: string; trader: string; notionalUsd: string }[];
    // w4 (-15d) is outside the 10-day window; the rest are newest-first.
    expect(bets.map((b) => b.txHash)).toEqual(['0xtx1', '0xtx2', '0xtx3']);
    // anonymous trader (w2) coalesces to the proxy wallet
    expect(bets.find((b) => b.txHash === '0xtx2')!.trader).toBe('0xbbb');

    const daily = out.daily as { date: string; count: string; totalUsd: string }[];
    expect(daily.length).toBe(3); // three distinct UTC days
    // ascending by date
    expect([...daily].map((d) => d.date)).toEqual([...daily].map((d) => d.date).sort());

    const meta = out.meta as { days: number; minUsd: string; count: string; totalUsd: string };
    expect(Number(meta.count)).toBe(3);
    expect(Number(meta.totalUsd)).toBe(1_073_000); // 753k + 200k + 120k (w4 excluded)
  });

  it('dash_whale_tracker: p_min_usd filters below the floor', async () => {
    const out = await whales(10, 500_000);
    const bets = out.bets as { txHash: string }[];
    expect(bets.map((b) => b.txHash)).toEqual(['0xtx1']); // only the 753k bet clears 500k
    expect(Number((out.meta as { count: string }).count)).toBe(1);
  });

  // Regression guard (migration 0044 trap): a RETURNS jsonb dash_* fn must be a jsonb OBJECT, never a top-level
  // array — the prod supabasePort misreads a bare array as a RETURNS TABLE row set and silently zeroes it.
  it('both RPCs return a jsonb OBJECT with array members (never a top-level array)', async () => {
    const out = await asRole(db, 'authenticated', OPERATOR, async () =>
      rows<{ rt: string; rseries: string; wt: string; wbets: string; wdaily: string }>(
        db,
        `select jsonb_typeof(public.dash_market_rewards(7,20))                 as rt,
                jsonb_typeof(public.dash_market_rewards(7,20) -> 'series')     as rseries,
                jsonb_typeof(public.dash_whale_tracker(10,0))                  as wt,
                jsonb_typeof(public.dash_whale_tracker(10,0) -> 'bets')        as wbets,
                jsonb_typeof(public.dash_whale_tracker(10,0) -> 'daily')       as wdaily`,
      ),
    );
    expect(out[0]).toMatchObject({ rt: 'object', rseries: 'array', wt: 'object', wbets: 'array', wdaily: 'array' });
  });

  it('operator_guard: a non-operator authenticated caller is refused (ERR_FORBIDDEN)', async () => {
    await expect(
      asRole(db, 'authenticated', INTRUDER, () =>
        rows(db, `select public.dash_market_rewards(7,20)`),
      ),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
    await expect(
      asRole(db, 'authenticated', INTRUDER, () =>
        rows(db, `select public.dash_whale_tracker(10,0)`),
      ),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
  });

  it('empty feeds → empty arrays + a null/zero latest, never a throw', async () => {
    const empty = await freshDb();
    try {
      const out = await asRole(empty, 'authenticated', OPERATOR, async () => {
        const r = await rows<{ r: Record<string, unknown>; w: Record<string, unknown> }>(
          empty,
          `select public.dash_market_rewards(7,20) as r, public.dash_whale_tracker(10,0) as w`,
        );
        return r[0]!;
      });
      expect(out.r.series).toEqual([]);
      expect(out.r.topMarkets).toEqual([]);
      expect((out.w as { bets: unknown[] }).bets).toEqual([]);
      expect(Number((out.w.meta as { count: string }).count)).toBe(0);
    } finally {
      await empty.close();
    }
  });
});
