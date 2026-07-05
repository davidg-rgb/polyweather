/**
 * 0084 trading-hardening twin tests (STAGED DARK — written, never applied to a live DB; exercised in PGlite,
 * the trade-config.test.ts idiom). Covers the four confirmed 2026-07-05 review findings the migration fixes:
 *
 *   #7  — trade_open_exposure(): a FILLED-held BUY counts toward openExposureUsd (deployed capital no longer
 *         vanishes from the total_concurrent_cap basis the moment an entry fills); partial rows split into
 *         unfilled-commitment + filled-cost without double-counting; sold inventory releases; dry-run never
 *         counts; and END-TO-END: the runner's decideTick blocks a new entry when deployed capital reaches
 *         the total cap (the exact F2 inequality, fed by the real preflight over the real ledger).
 *   #17 — bot_order_record_fill p_fee_usd: the fee lands on the delta's live_fills row (omitted/NULL → 0),
 *         and a SELL-side fee reaches trade_today_realized_loss (the N1 kill's fee terms are live).
 *   #18 — bot_order_record_resolution_loss: a hold-to-resolution full-stake loss is booked through the N1
 *         machinery (synthetic $0-proceeds SELL), idempotently, releasing the #7 exposure in the same breath.
 *   #19 — the record_fill row lock (SELECT … FOR UPDATE) + the N4 duplicate-echo idempotency it protects.
 */
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { loadTradeConfig, preflightLive } from '../../packages/trading/src/index.ts';
import { decideTick, type DecideCfg, type DiscoveredCandidate } from '../../scripts/lib/trade-bot-decide.ts';
import { asRole, freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };

let db: PGlite;
let port: ReturnType<typeof pglitePort>;

const asOperator = <T,>(fn: () => Promise<T>) => asRole(db, 'service_role', OPERATOR, fn);

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
});
afterAll(async () => {
  await db.close();
});

/** Wipe the ledger + gate rows and reset the config singleton to its seeded-dark defaults (superuser). */
async function resetAll(): Promise<void> {
  await db.exec(`delete from public.live_fills`);
  await db.exec(`delete from public.live_orders`);
  await db.exec(`delete from public.bot_gate_snapshot`);
  await db.exec(`delete from public.trade_gate_override`);
  await db.exec(
    `update public.trade_config set mode = 'off', stake_per_buy_usd = 10, per_position_cap_usd = 25,
       per_market_cap_usd = 40, total_concurrent_cap_usd = 100, daily_loss_kill_usd = 30,
       daily_loss_kill_frac = 0.25, city_allowlist = null, active_until = null where id = 1`,
  );
}

let seq = 0;
/** Insert a live_orders row directly (superuser) with a unique key; returns its id. */
async function seedOrder(opts: {
  mode?: 'live' | 'dry-run';
  side?: 'BUY' | 'SELL';
  status?: string;
  price: number;
  size: number;
  sizeMatched?: number;
  marketId?: string;
  tokenId?: string;
}): Promise<string> {
  seq += 1;
  const r = await rows<{ id: string }>(
    db,
    `insert into public.live_orders
       (intent_key, client_order_id, market_id, token_id, side, purpose, order_type,
        price, size, size_matched, avg_price, trade_date, mode, status)
     values ($1, $2, $3, $4, $5, 'entry', 'GTC', $6, $7, $8, $9, current_date, $10, $11)
     returning id`,
    [
      `hk-k${seq}`, `hk-c${seq}`, opts.marketId ?? 'mkt-1', opts.tokenId ?? 'tok',
      opts.side ?? 'BUY', opts.price, opts.size, opts.sizeMatched ?? 0,
      (opts.sizeMatched ?? 0) > 0 ? opts.price : null,
      opts.mode ?? 'live', opts.status ?? 'intent',
    ],
  );
  return r[0]!.id;
}

/** Insert a live_fills row (fill_notional = price × size, the N2 exact-cash column). */
async function seedFill(orderId: string, price: number, size: number, fee = 0, filledAt?: string): Promise<void> {
  await rows(
    db,
    `insert into public.live_fills (order_id, fill_price, fill_size, fill_notional, fee_usd, filled_at)
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))`,
    [orderId, price, size, price * size, fee, filledAt ?? null],
  );
}

/** A FILLED-held live BUY position: one 'filled' order row + its fill (cost = price × size). */
async function seedFilledBuy(marketId: string, price: number, size: number, tokenId = 'tok'): Promise<string> {
  const id = await seedOrder({ mode: 'live', side: 'BUY', status: 'filled', price, size, sizeMatched: size, marketId, tokenId });
  await seedFill(id, price, size);
  return id;
}

const exposure = async (): Promise<{ total: number; perMarket: Record<string, number> }> => {
  const [r] = await rows<{ v: { total: number; perMarket: Record<string, number> } }>(
    db,
    `select public.trade_open_exposure() as v`,
  );
  return { total: Number(r!.v.total), perMarket: r!.v.perMarket ?? {} };
};

const preflightChecks = async (): Promise<Record<string, unknown>> => {
  const [r] = await asOperator(() =>
    rows<{ checks: Record<string, unknown> }>(db, `select public.trade_live_preflight()->'checks' as checks`),
  );
  return r!.checks;
};

const todayLoss = async (): Promise<number> => {
  const [r] = await rows<{ v: string }>(db, `select public.trade_today_realized_loss() as v`);
  return Number(r!.v);
};

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0084 #7 — trade_open_exposure(): filled-held capital stays in the cap basis', () => {
  afterEach(resetAll);

  it('returns a jsonb OBJECT envelope (0081 tripwire) with zeroed figures on an empty ledger', async () => {
    const [t] = await rows<{ k: string }>(db, `select jsonb_typeof(public.trade_open_exposure()) as k`);
    expect(t!.k).toBe('object');
    const e = await exposure();
    expect(e.total).toBe(0);
    expect(e.perMarket).toEqual({});
  });

  it('a FILLED-held BUY counts toward openExposureUsd — deployed capital no longer vanishes on fill', async () => {
    await seedFilledBuy('m1', 0.25, 40); // $10 deployed, held
    const e = await exposure();
    expect(e.total).toBe(10);
    expect(Number(e.perMarket['m1'])).toBe(10);
    // …and the interlock's checks payload (the runner's F2 cap input) carries the same figure.
    const checks = await preflightChecks();
    expect(Number(checks['openExposureUsd'])).toBe(10);
    expect(Number((checks['perMarketExposureUsd'] as Record<string, unknown>)['m1'])).toBe(10);
  });

  it('a PARTIAL row splits: unfilled remainder at the limit + filled cost at the fill price (no double count)', async () => {
    // 50 sh @ limit 0.20; 20 filled @ 0.18 → unfilled 30 × 0.20 = $6 + held 20 × 0.18 = $3.60 → $9.60.
    const id = await seedOrder({ mode: 'live', side: 'BUY', status: 'partial', price: 0.2, size: 50, sizeMatched: 20, marketId: 'm1' });
    await seedFill(id, 0.18, 20);
    const e = await exposure();
    expect(e.total).toBeCloseTo(9.6, 9);
  });

  it('sold inventory releases exposure (net of sold) and the flat market drops out of perMarket', async () => {
    await seedFilledBuy('m1', 0.25, 40); // $10 in
    const sell = await seedOrder({ mode: 'live', side: 'SELL', status: 'filled', price: 0.3, size: 40, sizeMatched: 40, marketId: 'm1' });
    await seedFill(sell, 0.3, 40); // fully flattened
    const e = await exposure();
    expect(e.total).toBe(0);
    expect(e.perMarket).toEqual({});
  });

  it('a PARTIAL sell releases proportionally (lifetime-average basis)', async () => {
    await seedFilledBuy('m1', 0.25, 40); // $10 in
    const sell = await seedOrder({ mode: 'live', side: 'SELL', status: 'filled', price: 0.3, size: 15, sizeMatched: 15, marketId: 'm1' });
    await seedFill(sell, 0.3, 15); // 25 sh still held → 25 × 0.25 = $6.25
    const e = await exposure();
    expect(e.total).toBeCloseTo(6.25, 9);
  });

  it('a partial fill preserved on a CANCELED row (the reprice path) stays counted as deployed capital', async () => {
    // reprice books the partial then record_canceled's the row — the shares are still held in the wallet.
    const id = await seedOrder({ mode: 'live', side: 'BUY', status: 'canceled', price: 0.2, size: 30, sizeMatched: 10, marketId: 'm1' });
    await seedFill(id, 0.2, 10); // $2 of held basis on a terminal row
    const e = await exposure();
    expect(e.total).toBeCloseTo(2, 9);
  });

  it('dry-run rows and fills never count', async () => {
    const id = await seedOrder({ mode: 'dry-run', side: 'BUY', status: 'filled', price: 0.5, size: 100, sizeMatched: 100, marketId: 'm9' });
    await seedFill(id, 0.5, 100);
    await seedOrder({ mode: 'dry-run', side: 'BUY', status: 'intent', price: 0.3, size: 30, marketId: 'm9' });
    const e = await exposure();
    expect(e.total).toBe(0);
  });

  it('dash_trading.openExposureUsd reads the SAME shared definition', async () => {
    await seedFilledBuy('m1', 0.25, 40); // $10 held
    await seedOrder({ mode: 'live', side: 'BUY', status: 'placed', price: 0.2, size: 20, marketId: 'm2' }); // $4 resting
    const [d] = await asOperator(() =>
      rows<{ v: string }>(db, `select public.dash_trading()->>'openExposureUsd' as v`),
    );
    expect(Number(d!.v)).toBe(14);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0084 #7 — END-TO-END: the total-concurrent cap blocks a new entry once deployed capital reaches it', () => {
  afterEach(resetAll);

  const DECIDE_CFG: DecideCfg = {
    cities: ['testville'],
    maxEntryPrice: 0.3,
    depthFloorUsd: 150,
    entryEdgeMargin: 0.05,
    tpDeltaPp: 0.12,
    slDeltaPp: 0.2,
    slFrac: 0.5,
    makerFillWindowMin: 30,
    tstopHoursBeforeResolve: 18,
    timeStopLocalHour: 12,
    minOrderSizeShares: 5,
    negRisk: true,
  };

  const candidate = (marketId: string): DiscoveredCandidate => ({
    marketId,
    tokenId: `tok-${marketId}`,
    city: 'testville',
    targetDate: '2026-07-06',
    tz: 'Europe/Amsterdam',
    bucketIdx: 3,
    label: '27°C',
    execAsk: 0.2,
    modelProb: 0.35,
    depthUsd: 500,
    makerLimit: 0.19,
    bestBid: 0.1,
    bestAsk: 0.2,
    resolvesAtMs: Date.parse('2026-07-07T00:00:00Z'),
  });

  const goLiveWithGate = async (): Promise<void> => {
    await db.exec(`update public.trade_config set mode = 'live', active_until = current_date + 7 where id = 1`);
    await db.exec(
      `insert into public.bot_gate_snapshot (computed_at, mode, source, label)
       values (now(), 'paper', 'forward', 'PASS')`,
    );
  };

  it('10 × $10 FILLED-held positions = $100 deployed → the $100 cap blocks the 11th entry', async () => {
    await goLiveWithGate();
    for (let i = 0; i < 10; i++) await seedFilledBuy(`held-${i}`, 0.25, 40); // $10 each, all filled-held
    const [config, preflight] = await Promise.all([loadTradeConfig(port), preflightLive(port)]);
    expect(preflight.ok).toBe(true); // held positions are exposure, not a blocking reason
    expect(Number(preflight.checks.openExposureUsd)).toBe(100); // the pre-0084 figure was $0 here

    const plan = decideTick({
      mode: 'live',
      config,
      preflight,
      cfg: DECIDE_CFG,
      now: new Date('2026-07-05T12:00:00Z'),
      candidates: [candidate('fresh-market')],
      positions: [],
    });
    expect(plan.intents.filter((i) => i.kind === 'enter')).toHaveLength(0);
    expect(plan.skips.some((s) => /total-concurrent cap/.test(s.reason))).toBe(true);
  });

  it('at $90 deployed the same entry passes (headroom for one more $10 stake)', async () => {
    await goLiveWithGate();
    for (let i = 0; i < 9; i++) await seedFilledBuy(`held-${i}`, 0.25, 40); // $90 deployed
    const [config, preflight] = await Promise.all([loadTradeConfig(port), preflightLive(port)]);
    expect(Number(preflight.checks.openExposureUsd)).toBe(90);
    const plan = decideTick({
      mode: 'live',
      config,
      preflight,
      cfg: DECIDE_CFG,
      now: new Date('2026-07-05T12:00:00Z'),
      candidates: [candidate('fresh-market')],
      positions: [],
    });
    expect(plan.intents.filter((i) => i.kind === 'enter')).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0084 #17 — live_fills.fee_usd has a real write path', () => {
  afterEach(resetAll);

  const reserve = async (over: Record<string, unknown> = {}): Promise<void> => {
    seq += 1;
    await port.rpc('bot_order_reserve_intent', {
      p_mode: 'live', p_intent_key: `fee-k${seq}`, p_client_order_id: `fee-c${seq}`, p_market_id: 'mf',
      p_token_id: 'tok', p_side: 'BUY', p_purpose: 'entry', p_order_type: 'GTC', p_price: 0.3, p_size: 100,
      p_trade_date: '2026-07-05', ...over,
    });
  };

  it('record_fill writes p_fee_usd onto the delta fill row; an omitted arg (positional NULL) stays 0', async () => {
    await reserve();
    const cid = `fee-c${seq}`;
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: cid, p_size_matched: 40, p_avg_price: 0.3, p_status: 'partial', p_fee_usd: 0.25,
    });
    // second delta WITHOUT a fee arg → positional NULL → coalesce 0 (the N9 idiom).
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: cid, p_size_matched: 100, p_avg_price: 0.3, p_status: 'filled',
    });
    const fills = await rows<{ fill_size: string; fee_usd: string }>(
      db,
      `select fill_size, fee_usd from public.live_fills order by created_at asc, filled_at asc`,
    );
    expect(fills.map((f) => [Number(f.fill_size), Number(f.fee_usd)])).toEqual([
      [40, 0.25],
      [60, 0],
    ]);
  });

  it('a SELL-side fee reaches the N1 daily-loss definition (the kill fee terms are live, not dead code)', async () => {
    // BUY 100 @ 0.30 today ($30 basis), then SELL 100 @ 0.30 with a $1.50 taker fee → realized −$1.50.
    await reserve();
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: `fee-c${seq}`, p_size_matched: 100, p_avg_price: 0.3, p_status: 'filled',
    });
    await reserve({ p_side: 'SELL', p_purpose: 'time_stop', p_order_type: 'FAK' });
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: `fee-c${seq}`, p_size_matched: 100, p_avg_price: 0.3, p_status: 'filled', p_fee_usd: 1.5,
    });
    expect(await todayLoss()).toBeCloseTo(1.5, 9); // breakeven round trip; the fee IS the loss
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0084 #19 — record_fill row lock + duplicate-echo idempotency', () => {
  afterEach(resetAll);

  it('the recreated fn takes the row lock (SELECT … FOR UPDATE) before computing the delta', async () => {
    const [def] = await rows<{ d: string }>(
      db,
      `select pg_get_functiondef('public.bot_order_record_fill(text, numeric, numeric, text, numeric)'::regprocedure) as d`,
    );
    expect(def!.d.toLowerCase()).toContain('for update');
  });

  it('the same cumulative fill recorded twice writes ONE live_fills row — cash is never double-counted', async () => {
    seq += 1;
    await port.rpc('bot_order_reserve_intent', {
      p_mode: 'live', p_intent_key: `dup-k${seq}`, p_client_order_id: `dup-c${seq}`, p_market_id: 'md',
      p_token_id: 'tok', p_side: 'BUY', p_purpose: 'entry', p_order_type: 'GTC', p_price: 0.27, p_size: 74,
      p_trade_date: '2026-07-05',
    });
    const args = { p_client_order_id: `dup-c${seq}`, p_size_matched: 74, p_avg_price: 0.27, p_status: 'partial' };
    await port.rpc('bot_order_record_fill', args);
    await port.rpc('bot_order_record_fill', args); // the duplicate venue echo / concurrent second caller
    const fills = await rows<{ n: number; cash: string }>(
      db,
      `select count(*)::int as n, coalesce(sum(fill_notional), 0) as cash from public.live_fills`,
    );
    expect(fills[0]!.n).toBe(1);
    expect(Number(fills[0]!.cash)).toBeCloseTo(19.98, 6); // one $19.98 fill, not two
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0084 #18 — bot_order_record_resolution_loss: hold-to-resolution losses enter the ledger', () => {
  afterEach(resetAll);

  const book = async (mode = 'live', marketId = 'm1', tokenId = 'tok'): Promise<Record<string, unknown>> => {
    const [r] = await port.rpc<{ bot_order_record_resolution_loss: Record<string, unknown> }>(
      'bot_order_record_resolution_loss',
      { p_mode: mode, p_market_id: marketId, p_token_id: tokenId },
    );
    return r!.bot_order_record_resolution_loss;
  };

  it('books the FULL-STAKE loss through the N1 machinery — the daily-loss kill finally sees it', async () => {
    await seedFilledBuy('m1', 0.25, 40); // $10 deployed, market resolves against the position
    expect(await todayLoss()).toBe(0); // the pre-0084 blindness: no SELL fill ⇒ $0 "loss"

    const v = await book();
    expect(v['booked']).toBe(true);
    expect(Number(v['heldSize'])).toBe(40);
    expect(Number(v['lossUsd'])).toBeCloseTo(10, 6);

    expect(await todayLoss()).toBeCloseTo(10, 6); // proceeds $0 − basis $10 → realized −$10 today
    const checks = await preflightChecks();
    expect(Number(checks['todayLossUsd'])).toBeCloseTo(10, 6); // the kill input, same shared definition
    // …and the #7 exposure releases in the same breath (the position is no longer deployed capital).
    expect((await exposure()).total).toBe(0);
  });

  it('is IDEMPOTENT — the second call books nothing and the loss does not double', async () => {
    await seedFilledBuy('m1', 0.25, 40);
    expect((await book())['booked']).toBe(true);
    const second = await book();
    expect(second['booked']).toBe(false);
    expect(String(second['reason'])).toMatch(/already booked/);
    expect(await todayLoss()).toBeCloseTo(10, 6); // still exactly one $10 loss
    const sells = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from public.live_orders where side = 'SELL'`,
    );
    expect(sells[0]!.n).toBe(1);
  });

  it('books only the RESIDUAL after partial sells (net of sold, lifetime-average basis)', async () => {
    await seedFilledBuy('m1', 0.25, 40); // $10 in
    const sell = await seedOrder({ mode: 'live', side: 'SELL', status: 'filled', price: 0.3, size: 15, sizeMatched: 15, marketId: 'm1' });
    await seedFill(sell, 0.3, 15); // 15 sold; 25 held
    const v = await book();
    expect(v['booked']).toBe(true);
    expect(Number(v['heldSize'])).toBe(25);
    expect(Number(v['lossUsd'])).toBeCloseTo(6.25, 6); // 25 × $0.25 basis
  });

  it('no residual held shares → booked:false and NOTHING is written', async () => {
    const v = await book('live', 'never-traded');
    expect(v['booked']).toBe(false);
    const n = await rows<{ n: number }>(db, `select count(*)::int as n from public.live_orders`);
    expect(n[0]!.n).toBe(0);
  });

  it('mode-scoped: a dry-run booking never touches the LIVE loss figures', async () => {
    const id = await seedOrder({ mode: 'dry-run', side: 'BUY', status: 'filled', price: 0.25, size: 40, sizeMatched: 40, marketId: 'm1' });
    await seedFill(id, 0.25, 40);
    const v = await book('dry-run');
    expect(v['booked']).toBe(true);
    expect(await todayLoss()).toBe(0); // the N1 definition filters mode='live'
  });

  it('rejects an invalid mode', async () => {
    await expect(book('off')).rejects.toThrow(/p_mode must be dry-run\|live/);
  });
});
