/**
 * rpcOrderLedger — the binding of the abstract OrderLedger port to `TradingDb.rpc`. Verifies the exact
 * MODE-SCOPED RPC contract (T3 F4 amendment, final @ 2c9afef): names + `p_`-prefixed args verbatim,
 * p_mode on by_intent + reserve_intent ONLY (record_* keyed by the globally-unique client_order_id),
 * jsonb single-row returns, and the snake_case→camelCase row mapping. Faked db.rpc (mockDb idiom).
 */
import { describe, expect, it } from 'vitest';
import { mapLedgerRow, rpcOrderLedger, type TradingDb } from '../src/index.ts';

function mockDb(returns: Record<string, unknown> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: TradingDb = {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      calls.push({ fn, args });
      return (fn in returns ? [{ [fn]: returns[fn] }] : []) as T[];
    },
    async getConfigRows() {
      return [];
    },
  };
  return { db, calls };
}

const dbRow = {
  mode: 'live',
  intent_key: '0xc|BUY|entry|d',
  client_order_id: 'cid',
  status: 'placed',
  order_id: '0xO',
  side: 'BUY',
  purpose: 'entry',
  price: '0.18',
  size: '74',
  size_matched: '20',
  token_id: 'tokA',
  market_id: '0xc',
  created_at: '2026-07-05T00:00:00Z',
};

describe('rpcOrderLedger — the mode-scoped RPC contract for T3', () => {
  it('findByIntentKey → bot_order_by_intent(p_intent_key, p_mode) → mapped row', async () => {
    const { db, calls } = mockDb({ bot_order_by_intent: dbRow });
    const led = rpcOrderLedger(db);
    const out = await led.findByIntentKey('0xc|BUY|entry|d', 'live');
    expect(calls[0]).toEqual({ fn: 'bot_order_by_intent', args: { p_intent_key: '0xc|BUY|entry|d', p_mode: 'live' } });
    expect(out).toEqual({
      mode: 'live',
      intentKey: '0xc|BUY|entry|d',
      clientOrderId: 'cid',
      status: 'placed',
      orderId: '0xO',
      side: 'BUY',
      purpose: 'entry',
      price: 0.18,
      size: 74,
      sizeMatched: 20,
      tokenId: 'tokA',
      marketId: '0xc',
      createdAt: '2026-07-05T00:00:00Z',
    });
  });

  it('findByIntentKey → null when no open row', async () => {
    const { db } = mockDb({ bot_order_by_intent: null });
    expect(await rpcOrderLedger(db).findByIntentKey('k', 'dry-run')).toBeNull();
  });

  it('reserveIntent → bot_order_reserve_intent(p_mode + all p_ args) → reserved|exists', async () => {
    const { db, calls } = mockDb({ bot_order_reserve_intent: 'reserved' });
    const led = rpcOrderLedger(db);
    const res = await led.reserveIntent({ mode: 'live', intentKey: 'k', clientOrderId: 'cid', marketId: '0xc', tokenId: 'tok', side: 'BUY', purpose: 'entry', orderType: 'GTC', price: 0.18, size: 74, tradeDate: '2026-07-05' });
    expect(res).toBe('reserved');
    expect(calls[0]).toEqual({
      fn: 'bot_order_reserve_intent',
      args: { p_mode: 'live', p_intent_key: 'k', p_client_order_id: 'cid', p_market_id: '0xc', p_token_id: 'tok', p_side: 'BUY', p_purpose: 'entry', p_order_type: 'GTC', p_price: 0.18, p_size: 74, p_trade_date: '2026-07-05' },
    });

    const { db: db2 } = mockDb({ bot_order_reserve_intent: 'exists' });
    expect(await rpcOrderLedger(db2).reserveIntent({ mode: 'dry-run', intentKey: 'k', clientOrderId: 'c', marketId: 'm', tokenId: 't', side: 'BUY', purpose: 'entry', orderType: 'GTC', price: 0.1, size: 5, tradeDate: 'd' })).toBe('exists');
  });

  it('listDanglingIntents → bot_order_list_dangling(p_mode) → mapped rows; non-array → []', async () => {
    const { db, calls } = mockDb({ bot_order_list_dangling: [{ ...dbRow, status: 'intent', order_id: null }] });
    const out = await rpcOrderLedger(db).listDanglingIntents('live');
    expect(calls[0]).toEqual({ fn: 'bot_order_list_dangling', args: { p_mode: 'live' } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'intent', orderId: null, tokenId: 'tokA' });

    const { db: db2 } = mockDb({ bot_order_list_dangling: null });
    expect(await rpcOrderLedger(db2).listDanglingIntents('live')).toEqual([]);
  });

  it('record{Placed,Fill,Canceled,Failed} map to their RPCs with p_ args and NO mode (client_order_id is unambiguous)', async () => {
    const { db, calls } = mockDb();
    const led = rpcOrderLedger(db);
    await led.recordPlaced('cid', '0xO');
    await led.recordFill('cid', 30, 0.18, 'partial');
    await led.recordCanceled('cid');
    await led.recordFailed('cid', 'boom');
    expect(calls).toEqual([
      { fn: 'bot_order_record_placed', args: { p_client_order_id: 'cid', p_order_id: '0xO' } },
      { fn: 'bot_order_record_fill', args: { p_client_order_id: 'cid', p_size_matched: 30, p_avg_price: 0.18, p_status: 'partial' } },
      { fn: 'bot_order_record_canceled', args: { p_client_order_id: 'cid' } },
      { fn: 'bot_order_record_failed', args: { p_client_order_id: 'cid', p_error: 'boom' } },
    ]);
    for (const c of calls) expect(Object.keys(c.args)).not.toContain('p_mode');
  });
});

describe('mapLedgerRow', () => {
  it('accepts camelCase too and defaults mode/orderId/createdAt', () => {
    expect(mapLedgerRow({ intentKey: 'k', clientOrderId: 'c', status: 'intent', side: 'SELL', purpose: 'take_profit', price: 0.3, size: 10, tokenId: 't', marketId: 'm' })).toMatchObject({
      mode: 'live',
      orderId: null,
      createdAt: null,
      side: 'SELL',
      purpose: 'take_profit',
      sizeMatched: 0,
      tokenId: 't',
    });
  });
  it('null / empty → null', () => {
    expect(mapLedgerRow(null)).toBeNull();
    expect(mapLedgerRow({})).toBeNull();
  });
});
