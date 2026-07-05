/**
 * Contract tests for scripts/lib/trading-db — the daemon's ONLY bridge to every 0082 money-path RPC
 * (review finding #25: the production `select public.fn(k => $n) as fn` string-builder had ZERO coverage;
 * the suite only ever exercised the RPCs through the pglite-port's different positional encoding — the
 * exact port-shape seam class that shipped the 0044/0081/0083 defects).
 *
 * Two layers:
 *   1. ENCODING (mock ScriptDb): the three arg-encoding branches (array → inline text[], object →
 *      JSON.stringify + ::jsonb, scalar bind), the no-arg form, the `[{ [fn]: value }]` row-shape
 *      passthrough, `listOpenEntryRows` SQL/mapping, and the advisory-lock probe.
 *   2. END-TO-END (PGlite + the REAL migration chain): makeTradingDb → rpcOrderLedger/loadTradeConfig/
 *      preflightLive against the REAL 0082 functions — the named-arg SQL actually parses, the RPCs
 *      execute, the row shapes decode, RAISEs cross the seam as rejections, and the idempotency-critical
 *      reserve → record_placed → record_fill → record_canceled chain round-trips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from '../../supabase/tests/harness.ts';
import {
  danglingEnvelopeReady,
  loadTradeConfig,
  preflightLive,
  rpcOrderLedger,
} from '../../packages/trading/src/index.ts';
import type { ScriptDb } from './script-db.ts';
import {
  acquireTradeBotLock,
  makeTradingDb,
  OPEN_ENTRY_LOOKBACK_DAYS,
  TRADE_BOT_LOCK_CLASS,
  tradeBotLockObj,
  type ScriptTradingDb,
} from './trading-db.ts';

// ── layer 1 · ENCODING against a capturing mock ScriptDb ────────────────────────────────────────────

interface Captured {
  sql: string;
  params: unknown[];
}

function mockSdb(result: unknown[] = [], captured: Captured[] = []): { sdb: ScriptDb; captured: Captured[] } {
  const sdb: ScriptDb = {
    query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
      captured.push({ sql, params });
      return result as T[];
    },
    end: async () => {},
  };
  return { sdb, captured };
}

describe('makeTradingDb.rpc — the SQL/arg-encoding contract (finding #25)', () => {
  it('no args → `select public.fn() as fn` with no params', async () => {
    const { sdb, captured } = mockSdb([{ fn_a: 1 }]);
    await makeTradingDb(sdb).rpc('fn_a', {});
    expect(captured[0]!.sql).toBe('select public.fn_a() as fn_a');
    expect(captured[0]!.params).toEqual([]);
  });

  it('scalars bind as named args in key order', async () => {
    const { sdb, captured } = mockSdb();
    await makeTradingDb(sdb).rpc('fn_b', { p_key: 'k1', p_mode: 'live', p_n: 3, p_null: null });
    expect(captured[0]!.sql).toBe('select public.fn_b(p_key => $1, p_mode => $2, p_n => $3, p_null => $4) as fn_b');
    expect(captured[0]!.params).toEqual(['k1', 'live', 3, null]);
  });

  it('an ARRAY arg inlines element placeholders cast text[] (the discovery p_cities shape)', async () => {
    const { sdb, captured } = mockSdb();
    await makeTradingDb(sdb).rpc('fn_c', { p_days: 2, p_cities: ['amsterdam', 'paris'] });
    expect(captured[0]!.sql).toBe('select public.fn_c(p_days => $1, p_cities => array[$2, $3]::text[]) as fn_c');
    expect(captured[0]!.params).toEqual([2, 'amsterdam', 'paris']);
  });

  it('an OBJECT arg is JSON-stringified and cast ::jsonb (the record_bot_tick p_payload shape)', async () => {
    const { sdb, captured } = mockSdb();
    await makeTradingDb(sdb).rpc('fn_d', { p_payload: { mode: 'live', ran: true } });
    expect(captured[0]!.sql).toBe('select public.fn_d(p_payload => $1::jsonb) as fn_d');
    expect(captured[0]!.params).toEqual(['{"mode":"live","ran":true}']);
  });

  it('returns the driver rows UNCHANGED — the `[{ [fn]: value }]` shape the port readers depend on', async () => {
    const rows = [{ fn_e: { config: { mode: 'off' } } }];
    const { sdb } = mockSdb(rows);
    expect(await makeTradingDb(sdb).rpc('fn_e', {})).toBe(rows);
  });

  it('getConfigRows reads public.config verbatim', async () => {
    const { sdb, captured } = mockSdb([{ key: 'bot.cities', value: 'amsterdam' }]);
    const out = await makeTradingDb(sdb).getConfigRows();
    expect(captured[0]!.sql).toContain('select key, value from public.config');
    expect(out).toEqual([{ key: 'bot.cities', value: 'amsterdam' }]);
  });

  it('listOpenEntryRows: open BUY/entry rows for the mode, canceled/failed excluded, lookback-bounded', async () => {
    const rows = [{ marketId: 'mA', tokenId: 'tokA', tradeDate: '2026-07-06' }];
    const { sdb, captured } = mockSdb(rows);
    const out = await makeTradingDb(sdb).listOpenEntryRows('dry-run');
    expect(out).toEqual(rows);
    const sql = captured[0]!.sql;
    expect(sql).toContain('from public.live_orders');
    expect(sql).toContain(`side = 'BUY'`);
    expect(sql).toContain(`purpose = 'entry'`);
    expect(sql).toContain(`status not in ('canceled', 'failed')`);
    expect(sql).toContain(`interval '${OPEN_ENTRY_LOOKBACK_DAYS} days'`);
    expect(captured[0]!.params).toEqual(['dry-run']);
  });

  it('acquireTradeBotLock: pg_try_advisory_lock(class, mode-obj); false / missing rows are NOT acquired', async () => {
    {
      const { sdb, captured } = mockSdb([{ locked: true }]);
      expect(await acquireTradeBotLock(sdb, 'live')).toBe(true);
      expect(captured[0]!.sql).toContain('pg_try_advisory_lock($1, $2)');
      expect(captured[0]!.params).toEqual([TRADE_BOT_LOCK_CLASS, tradeBotLockObj('live')]);
    }
    const { sdb: held } = mockSdb([{ locked: false }]);
    expect(await acquireTradeBotLock(held, 'live')).toBe(false); // another instance holds it
    const { sdb: empty } = mockSdb([]);
    expect(await acquireTradeBotLock(empty, 'live')).toBe(false); // a shapeless result never passes
  });

  it('the lock is MODE-scoped: dry-run and live use distinct object ids (they may coexist)', () => {
    expect(tradeBotLockObj('dry-run')).not.toBe(tradeBotLockObj('live'));
    expect(TRADE_BOT_LOCK_CLASS).toBeLessThanOrEqual(2_147_483_647); // int4 — pg_try_advisory_lock(int, int)
  });
});

// ── layer 2 · END-TO-END against PGlite + the REAL migration chain (0082 included) ─────────────────

describe('makeTradingDb ⋈ the real 0082 RPCs (PGlite)', () => {
  let pg: PGlite;
  let tdb: ScriptTradingDb;

  beforeAll(async () => {
    pg = await freshDb();
    const sdb: ScriptDb = {
      query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => (await pg.query<T>(sql, params)).rows,
      end: async () => {},
    };
    tdb = makeTradingDb(sdb);
  }, 240_000);

  afterAll(async () => {
    await pg.close();
  });

  it('loadTradeConfig round-trips the seeded 0082 singleton through the no-arg encoding', async () => {
    const cfg = await loadTradeConfig(tdb);
    expect(cfg.mode).toBe('off'); // the shipped default — never live at birth
    expect(cfg.stakePerBuyUsd).toBe(10);
    expect(cfg.perPositionCapUsd).toBe(25);
    expect(cfg.totalConcurrentCapUsd).toBe(100);
  });

  it('preflightLive decodes the real verdict envelope (blocking at birth — mode off, no gate PASS)', async () => {
    const pf = await preflightLive(tdb);
    expect(pf.ok).toBe(false);
    expect(pf.reasons.length).toBeGreaterThan(0);
    expect(pf.checks).toBeTruthy();
  });

  it('the discovery call executes with the ARRAY-inline encoding and returns the {captures,resolutions} envelope', async () => {
    const rows = await tdb.rpc<{ convergence_capture_inputs: { captures: unknown[]; resolutions: unknown[] } }>(
      'convergence_capture_inputs',
      { p_days: 2, p_cities: ['amsterdam', 'paris'] },
    );
    expect(Array.isArray(rows[0]!.convergence_capture_inputs.captures)).toBe(true);
    expect(Array.isArray(rows[0]!.convergence_capture_inputs.resolutions)).toBe(true);
  });

  it('record_bot_tick executes with the OBJECT→jsonb encoding (the heartbeat write path)', async () => {
    const rows = await tdb.rpc<{ record_bot_tick: number | string }>('record_bot_tick', {
      p_payload: { mode: 'dry-run', ran: true, placed: 0, filled: 0, exited: 0, gateReason: 'contract test [DEGRADED: x]' },
    });
    expect(Number(rows[0]!.record_bot_tick)).toBeGreaterThan(0);
    const logged = await pg.query<{ gate_reason: string }>(`select gate_reason from bot_tick_log order by id desc limit 1`);
    expect(logged.rows[0]!.gate_reason).toContain('[DEGRADED');
  });

  it('the idempotency-critical ledger chain round-trips: reserve → exists → placed → fill → filled stays visible', async () => {
    const ledger = rpcOrderLedger(tdb);
    const intent = {
      mode: 'dry-run' as const, intentKey: 'mA|BUY|entry|2026-07-06', clientOrderId: 'cid-1',
      marketId: 'mA', tokenId: 'tokA', side: 'BUY' as const, purpose: 'entry' as const,
      orderType: 'GTC' as const, price: 0.15, size: 66, tradeDate: '2026-07-06',
    };
    expect(await ledger.reserveIntent(intent)).toBe('reserved');
    expect(await ledger.reserveIntent({ ...intent, clientOrderId: 'cid-1b' })).toBe('exists'); // never a double

    const row = await ledger.findByIntentKey(intent.intentKey, 'dry-run');
    expect(row).toMatchObject({ marketId: 'mA', tokenId: 'tokA', status: 'intent', orderId: null, size: 66, price: 0.15 });
    expect(await ledger.findByIntentKey(intent.intentKey, 'live')).toBeNull(); // mode-scoped

    await ledger.recordPlaced('cid-1', 'venue-1');
    await ledger.recordFill('cid-1', 30, 0.15, 'partial');
    expect(await ledger.findByIntentKey(intent.intentKey, 'dry-run')).toMatchObject({ status: 'partial', sizeMatched: 30, orderId: 'venue-1' });
    await ledger.recordFill('cid-1', 66, 0.15, 'filled');
    // filled is NOT terminal-hidden — a filled entry IS the open position the daemon must keep managing
    expect(await ledger.findByIntentKey(intent.intentKey, 'dry-run')).toMatchObject({ status: 'filled', sizeMatched: 66 });
  });

  it('recordCanceled frees the key (row invisible to by_intent) and the intent re-reserves cleanly', async () => {
    const ledger = rpcOrderLedger(tdb);
    const intent = {
      mode: 'dry-run' as const, intentKey: 'mB|SELL|time_stop|2026-07-06', clientOrderId: 'cid-2',
      marketId: 'mB', tokenId: 'tokB', side: 'SELL' as const, purpose: 'time_stop' as const,
      orderType: 'FAK' as const, price: 0.2, size: 26, tradeDate: '2026-07-06',
    };
    expect(await ledger.reserveIntent(intent)).toBe('reserved');
    await ledger.recordPlaced('cid-2', 'venue-2');
    await ledger.recordFill('cid-2', 10, 0.2, 'partial');
    await ledger.recordCanceled('cid-2'); // the FAK-adjudication transition — fills preserved in the DB
    expect(await ledger.findByIntentKey(intent.intentKey, 'dry-run')).toBeNull();
    const kept = await pg.query<{ size_matched: string }>(`select size_matched from live_orders where client_order_id = 'cid-2'`);
    expect(Number(kept.rows[0]!.size_matched)).toBe(10); // recordCanceled PRESERVES size_matched (the seam contract)
    expect(await ledger.reserveIntent({ ...intent, clientOrderId: 'cid-2b' })).toBe('reserved'); // key freed
  });

  it('a record_* RAISE (unknown client_order_id) crosses the seam as a REJECTION — never a silent success', async () => {
    const ledger = rpcOrderLedger(tdb);
    await expect(ledger.recordFill('cid-ghost', 10, 0.2, 'partial')).rejects.toThrow(/unknown client_order_id/);
    await expect(ledger.recordCanceled('cid-ghost')).rejects.toThrow(/unknown client_order_id/);
  });

  it('bot_order_list_dangling returns the {rows:[…]} envelope (danglingEnvelopeReady true; young intents hidden)', async () => {
    expect(await danglingEnvelopeReady(tdb, 'dry-run')).toBe(true);
    const ledger = rpcOrderLedger(tdb);
    // cid-1b above is a dangling 'intent' (no orderId) but YOUNGER than the 5-min staleness floor → hidden
    expect(await ledger.listDanglingIntents('dry-run')).toEqual([]);
  });

  it('listOpenEntryRows enumerates exactly the open BUY/entry rows: filled kept, canceled/SELL/other-mode/stale-date excluded', async () => {
    const ledger = rpcOrderLedger(tdb);
    // a live-mode entry (other mode), a canceled entry, and a stale-dated entry — all must be excluded
    await ledger.reserveIntent({ mode: 'live', intentKey: 'mC|BUY|entry|2026-07-06', clientOrderId: 'cid-3', marketId: 'mC', tokenId: 'tokC', side: 'BUY', purpose: 'entry', orderType: 'GTC', price: 0.1, size: 10, tradeDate: '2026-07-06' });
    await ledger.reserveIntent({ mode: 'dry-run', intentKey: 'mD|BUY|entry|2026-07-06', clientOrderId: 'cid-4', marketId: 'mD', tokenId: 'tokD', side: 'BUY', purpose: 'entry', orderType: 'GTC', price: 0.1, size: 10, tradeDate: '2026-07-06' });
    await ledger.recordCanceled('cid-4');
    await ledger.reserveIntent({ mode: 'dry-run', intentKey: 'mE|BUY|entry|2026-05-01', clientOrderId: 'cid-5', marketId: 'mE', tokenId: 'tokE', side: 'BUY', purpose: 'entry', orderType: 'GTC', price: 0.1, size: 10, tradeDate: '2026-05-01' });
    await pg.query(`update live_orders set trade_date = (now() - interval '30 days')::date where client_order_id = 'cid-5'`);

    const open = await tdb.listOpenEntryRows('dry-run');
    const ids = open.map((r) => r.marketId).sort();
    expect(ids).toContain('mA'); // the FILLED entry stays enumerated (a held position)
    expect(ids).not.toContain('mB'); // SELL/time_stop purpose — not an entry
    expect(ids).not.toContain('mC'); // other mode
    expect(ids).not.toContain('mD'); // canceled
    expect(ids).not.toContain('mE'); // outside the lookback
    const mA = open.find((r) => r.marketId === 'mA')!;
    expect(mA).toEqual({ marketId: 'mA', tokenId: 'tokA', tradeDate: '2026-07-06' }); // date as YYYY-MM-DD text

    const live = await tdb.listOpenEntryRows('live');
    expect(live.map((r) => r.marketId)).toEqual(['mC']);
  });

  it('acquireTradeBotLock acquires against a real Postgres (single-session PGlite always grants)', async () => {
    const sdb: ScriptDb = { query: async <T,>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows, end: async () => {} };
    expect(await acquireTradeBotLock(sdb, 'dry-run')).toBe(true);
  });
});
