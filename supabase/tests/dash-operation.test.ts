/**
 * Migration 0124 (`dash_operation`) — the PGlite twin against the real migration chain.
 *
 * Pins the things the /operation page's correctness rests on:
 *   • the 0081 tripwire — ONE jsonb OBJECT envelope, never SETOF / never a bare array;
 *   • operator gating — forbidden without the operator role, readable with it;
 *   • the money model — cost/realized/atRisk computed off `size_matched` (NOT `size`), so a PARTIAL fill
 *     is valued at what it actually matched, and an UNRESOLVED market contributes at-risk but never P&L;
 *   • a no-fill row (failed / zero-fill canceled) contributes ZERO to staked, realized and at-risk;
 *   • the binding weekly PRUNE rule surfaces as `pruneFlag` at exactly <=20% win on n>=8 resolved;
 *   • the empty state is a populated envelope with empty collections, not null — day-1 "armed, no fills".
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };

describe('0124 dash_operation — the live cheap-early operation read', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db?.close(); });

  const asOperator = <T>(fn: () => Promise<T>): Promise<T> => asRole(db, 'authenticated', OPERATOR, fn);
  const call = async (): Promise<Record<string, any>> =>
    (await rows<{ out: Record<string, any> }>(db, `select public.dash_operation() as out`))[0]!.out;

  /** One resolved-or-open market with a single bucket, plus an optional live BUY order against it. */
  async function seedMarket(opts: {
    slug: string;
    /** event key — defaults to `slug`; pass a distinct stem to put MANY events in ONE city. */
    stem?: string;
    /** market_events has a natural key over (city, target_date), so many events in ONE city need distinct dates. */
    targetDate?: string;
    winnerIdx: number | null;
    order?: { price: number; avgPrice: number | null; size: number; sizeMatched: number; status: string; createdAt?: string };
  }): Promise<void> {
    const stem = opts.stem ?? opts.slug;
    const targetDate = opts.targetDate ?? '2026-08-10';
    const region = (await rows<{ region: string }>(db, `select region from public.clusters limit 1`))[0]!.region;
    const cityId = (await rows<{ city_id: string }>(
      db, `select city_id from public.upsert_city($1, $1, 'US', 'C', 'UTC', $2)`, [opts.slug, region],
    ))[0]!.city_id;
    const eventId = (await rows<{ id: string }>(
      db,
      `insert into public.market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx)
       values ('pe-' || $1, 'ev-' || $1, $2, $4::date, 'C', true, $3) returning id`,
      [stem, cityId, opts.winnerIdx, targetDate],
    ))[0]!.id;
    const conditionId = `cond-${stem}`;
    await rows(
      db,
      `insert into public.market_buckets (event_id, bucket_idx, label, condition_id, token_yes, token_no)
       values ($1, 0, '34-34C', $2, $3, $3 || '-no')`,
      [eventId, conditionId, `tok-${stem}`],
    );
    if (opts.order) {
      await rows(
        db,
        `insert into public.live_orders
           (intent_key, client_order_id, market_id, token_id, side, purpose, order_type, price, avg_price,
            size, size_matched, trade_date, mode, status, strategy, created_at)
         values ($1, $1, $2, $3, 'BUY', 'entry', 'FAK', $4, $5, $6, $7, $10::date, 'live', $8, 'buy-table', $9)`,
        [
          `ik-${stem}`, conditionId, `tok-${stem}`,
          opts.order.price, opts.order.avgPrice, opts.order.size, opts.order.sizeMatched,
          opts.order.status, opts.order.createdAt ?? '2026-08-09T01:00:00Z', targetDate,
        ],
      );
    }
  }

  afterEach(async () => {
    await db.exec(`delete from public.live_orders`);
    await db.exec(`delete from public.market_buckets`);
    await db.exec(`delete from public.market_events`);
  });

  it('is operator-guarded and returns ONE jsonb OBJECT envelope (0081 tripwire)', async () => {
    await expect(rows(db, `select public.dash_operation() as out`)).rejects.toThrow();
    const [shape] = await asOperator(() =>
      rows<{ typ: string }>(db, `select jsonb_typeof(public.dash_operation()) as typ`),
    );
    expect(shape!.typ).toBe('object');
    const out = await asOperator(call);
    for (const k of ['lane', 'money', 'equity', 'orders', 'byCity', 'byBand']) {
      expect(out).toHaveProperty(k);
    }
  });

  it('EMPTY state — armed with no fills returns zeros + empty arrays, never null', async () => {
    const out = await asOperator(call);
    expect(out.money.nOrders).toBe(0);
    expect(Number(out.money.stakedUsd)).toBe(0);
    expect(Number(out.money.realizedUsd)).toBe(0);
    expect(out.money.winRate).toBeNull();
    expect(out.orders).toEqual([]);
    expect(out.byCity).toEqual([]);
    expect(out.equity).toEqual([]);
  });

  it('money model: a LOSS is valued off size_matched × avg_price, not size × price', async () => {
    // bucket 0 seeded; winner is bucket 1 ⇒ our pick lost. 20 matched of 40 requested @ 0.24 (limit 0.25).
    await seedMarket({
      slug: 'lossville', winnerIdx: 1,
      order: { price: 0.25, avgPrice: 0.24, size: 40, sizeMatched: 20, status: 'partial' },
    });
    const out = await asOperator(call);
    expect(Number(out.money.stakedUsd)).toBeCloseTo(4.8, 6);   // 20 × 0.24, NOT 40 × 0.25
    expect(Number(out.money.realizedUsd)).toBeCloseTo(-4.8, 6); // total loss of the matched cost
    expect(Number(out.money.atRiskUsd)).toBe(0);               // resolved ⇒ nothing at risk
    expect(out.money.nWins).toBe(0);
    expect(Number(out.money.winRate)).toBe(0);
  });

  it('money model: a WIN pays $1/share on the matched size', async () => {
    await seedMarket({
      slug: 'winville', winnerIdx: 0,
      order: { price: 0.25, avgPrice: 0.20, size: 25, sizeMatched: 25, status: 'filled' },
    });
    const out = await asOperator(call);
    expect(Number(out.money.stakedUsd)).toBeCloseTo(5, 6);     // 25 × 0.20
    expect(Number(out.money.realizedUsd)).toBeCloseTo(20, 6);  // payoff 25 − cost 5
    expect(out.money.nWins).toBe(1);
  });

  it('an UNRESOLVED market is at-risk, never P&L', async () => {
    await seedMarket({
      slug: 'openville', winnerIdx: null,
      order: { price: 0.30, avgPrice: 0.30, size: 10, sizeMatched: 10, status: 'filled' },
    });
    const out = await asOperator(call);
    expect(Number(out.money.atRiskUsd)).toBeCloseTo(3, 6);
    expect(Number(out.money.realizedUsd)).toBe(0);
    expect(out.money.nResolved).toBe(0);
    expect(out.orders[0]!.resolved).toBe(false);
  });

  it('a NO-FILL row (failed) costs nothing and risks nothing', async () => {
    await seedMarket({
      slug: 'failville', winnerIdx: 1,
      order: { price: 0.25, avgPrice: null, size: 20, sizeMatched: 0, status: 'failed' },
    });
    const out = await asOperator(call);
    expect(out.money.nOrders).toBe(1);
    expect(out.money.nFilled).toBe(0);
    expect(Number(out.money.stakedUsd)).toBe(0);
    expect(Number(out.money.realizedUsd)).toBe(0);
    expect(Number(out.money.atRiskUsd)).toBe(0);
  });

  it('pruneFlag fires at exactly <=20% win on n>=8 resolved, and not below the n floor', async () => {
    // ONE city, 8 resolved, exactly 1 win => 12.5% <= 20% on n=8 => FLAGGED.
    for (let i = 0; i < 8; i++) {
      await seedMarket({
        slug: 'bleedcity', stem: `bleed${i}`, targetDate: `2026-08-${String(10 + i).padStart(2, '0')}`, winnerIdx: i === 0 ? 0 : 1,
        order: { price: 0.25, avgPrice: 0.25, size: 4, sizeMatched: 4, status: 'filled' },
      });
    }
    // ONE city, 4 resolved, 0 wins => 0% but UNDER the n>=8 floor => NOT flagged (the floor is what stops
    // a two-loss cold streak from pruning a city that has barely traded).
    for (let i = 0; i < 4; i++) {
      await seedMarket({
        slug: 'smallcity', stem: `small${i}`, targetDate: `2026-08-${String(10 + i).padStart(2, '0')}`, winnerIdx: 1,
        order: { price: 0.25, avgPrice: 0.25, size: 4, sizeMatched: 4, status: 'filled' },
      });
    }
    // ONE city, 8 resolved, 3 wins => 37.5% > 20% => NOT flagged.
    for (let i = 0; i < 8; i++) {
      await seedMarket({
        slug: 'okcity', stem: `ok${i}`, targetDate: `2026-08-${String(10 + i).padStart(2, '0')}`, winnerIdx: i < 3 ? 0 : 1,
        order: { price: 0.25, avgPrice: 0.25, size: 4, sizeMatched: 4, status: 'filled' },
      });
    }
    const out = await asOperator(call);
    const byCity = out.byCity as Array<{ city: string; nResolved: number; wins: number; pruneFlag: boolean }>;
    const get = (c: string) => byCity.find((r) => r.city === c)!;

    expect(get('bleedcity').nResolved).toBe(8);
    expect(get('bleedcity').wins).toBe(1);
    expect(get('bleedcity').pruneFlag).toBe(true);

    expect(get('smallcity').nResolved).toBe(4);
    expect(get('smallcity').pruneFlag).toBe(false); // 0% win, but under the n floor

    expect(get('okcity').wins).toBe(3);
    expect(get('okcity').pruneFlag).toBe(false);

    // and the invariant the rule rests on: nothing under the floor is EVER flagged
    expect(byCity.some((r) => r.pruneFlag && r.nResolved < 8)).toBe(false);
  });

  it('the ledger row carries the bucket label, city, status and outcome the page renders', async () => {
    await seedMarket({
      slug: 'ledgerville', winnerIdx: 0,
      order: { price: 0.25, avgPrice: 0.22, size: 20, sizeMatched: 20, status: 'filled' },
    });
    const out = await asOperator(call);
    const row = out.orders[0]!;
    expect(row.city).toBe('ledgerville');
    expect(row.label).toBe('34-34C');
    expect(row.status).toBe('filled');
    expect(row.won).toBe(true);
    expect(row.side).toBe('BUY');
  });

  it('lane state mirrors the config keys the tick reads (defaults when unset)', async () => {
    await rows(db, `insert into public.config (key, value) values
      ('buy_table.ask_floor','0.20'), ('buy_table.price_cap','0.33'),
      ('buy_table.lead_min_h','24'), ('buy_table.lead_max_h','36'),
      ('buy_table.max_buys_per_day','4'), ('buy_table.tick_enabled','true')
      on conflict (key) do update set value = excluded.value`);
    const out = await asOperator(call);
    expect(Number(out.lane.askFloor)).toBe(0.2);
    expect(Number(out.lane.priceCap)).toBe(0.33);
    expect(Number(out.lane.leadMinH)).toBe(24);
    expect(Number(out.lane.leadMaxH)).toBe(36);
    expect(out.lane.maxBuysPerDay).toBe(4);
    expect(out.lane.tickEnabled).toBe(true);
  });
});
