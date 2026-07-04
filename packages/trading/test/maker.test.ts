/**
 * MakerExecutor (§6.20 MAKER-EXIT extension — DORMANT, mock-tested) against a clob-client mock + a fake
 * OrderLedger: maker pricing enforced by price (strictly inside the spread, tick-rounded at the
 * boundary), the TRADE_MODE gate (off / dry-run never post / live), DB-ledger idempotency (a retry or
 * concurrent placer NEVER double-places), partial-fill accounting, cancel / cancel-all / reprice, and
 * the taker FAK exit leg. Mirrors the mock-factory injection idiom of live.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExecutionError } from '@weather-edge/core';
import {
  MakerExecutor,
  type MakerClobClientish,
  type MakerExecutorDeps,
  type MakerOrderRequest,
  type OrderLedger,
  type OrderLedgerRow,
  type TakerOrderRequest,
  type TradeAlert,
} from '../src/index.ts';

const req: MakerOrderRequest = {
  marketId: '0xcond',
  tokenId: 'tok-yes',
  side: 'BUY',
  purpose: 'entry',
  tradeDate: '2026-07-05',
  targetPrice: 0.18,
  size: 74,
  negRisk: true,
  minOrderSize: 5,
};

// Flat-open book: bestBid 0.10, bestAsk 0.20 (normalizeBook reverses raw asc-bids / desc-asks).
const flatBook = {
  bids: [{ price: '0.08', size: '500' }, { price: '0.1', size: '900' }],
  asks: [{ price: '0.22', size: '800' }, { price: '0.2', size: '700' }],
  tick_size: '0.01',
  min_order_size: '5',
};

function mockClient(overrides: Partial<MakerClobClientish> = {}): MakerClobClientish {
  return {
    getTickSize: vi.fn(async () => '0.01'),
    getOrderBook: vi.fn(async () => flatBook),
    createOrder: vi.fn(async (args, opts) => ({ signed: true, args, opts, signature: '0xSIGNATUREMATERIAL' })),
    postOrder: vi.fn(async () => ({ orderID: '0xORDER', success: true })),
    getOrder: vi.fn(async () => ({ status: 'live', original_size: '74', size_matched: '0', price: '0.18' })),
    getOpenOrders: vi.fn(async () => [{ id: '0xORDER', status: 'live', side: 'BUY', asset_id: 'tok-yes', original_size: '74', size_matched: '0', price: '0.18', order_type: 'GTC' }]),
    cancelOrder: vi.fn(async (p: { orderID: string }) => ({ canceled: [p.orderID], not_canceled: {} })),
    cancelOrders: vi.fn(async () => ({ canceled: ['0xORDER'], not_canceled: {} })),
    cancelAll: vi.fn(async () => ({ canceled: ['0xORDER'], not_canceled: {} })),
    cancelMarketOrders: vi.fn(async () => ({ canceled: ['0xORDER'], not_canceled: {} })),
    ...overrides,
  };
}

/** In-memory OrderLedger with call tracking, faked directly (like live.test's mockDb). */
function mockLedger(seedOpen: OrderLedgerRow | null = null) {
  const calls: { fn: string; args: unknown[] }[] = [];
  let open = seedOpen;
  const rows = new Map<string, OrderLedgerRow>();
  const ledger: OrderLedger = {
    findByIntentKey: vi.fn(async (k: string) => {
      calls.push({ fn: 'findByIntentKey', args: [k] });
      return open;
    }),
    reserveIntent: vi.fn(async (input) => {
      calls.push({ fn: 'reserveIntent', args: [input] });
      if (open) return 'exists';
      const row: OrderLedgerRow = { intentKey: input.intentKey, clientOrderId: input.clientOrderId, status: 'intent', orderId: null, side: input.side, purpose: input.purpose, price: input.price, size: input.size, sizeMatched: 0 };
      open = row;
      rows.set(input.clientOrderId, row);
      return 'reserved';
    }),
    recordPlaced: vi.fn(async (cid: string, oid: string) => {
      calls.push({ fn: 'recordPlaced', args: [cid, oid] });
      const r = rows.get(cid);
      if (r) { r.status = 'placed'; r.orderId = oid; }
    }),
    recordFill: vi.fn(async (cid, sm, ap, st) => {
      calls.push({ fn: 'recordFill', args: [cid, sm, ap, st] });
    }),
    recordCanceled: vi.fn(async (cid: string) => {
      calls.push({ fn: 'recordCanceled', args: [cid] });
      open = null;
    }),
    recordFailed: vi.fn(async (cid: string, err: string) => {
      calls.push({ fn: 'recordFailed', args: [cid, err] });
      open = null;
    }),
  };
  return { ledger, calls };
}

const deps = (
  mode: string,
  client: MakerClobClientish,
  ledger: OrderLedger,
  extra: Partial<MakerExecutorDeps> = {},
): MakerExecutorDeps => ({
  db: { rpc: async <T>() => [] as T[], getConfigRows: async () => [] },
  client: async () => client,
  ledger,
  getEnvVar: (n: string) => (n === 'TRADE_MODE' ? mode : undefined),
  newClientOrderId: () => 'cid-fixed',
  notify: async () => true,
  log: vi.fn(),
  ...extra,
});

describe('MakerExecutor.place — maker pricing + mode + idempotency', () => {
  it('live BUY: rests strictly below best ask (0.18<0.20), GTC + post_only=true, negRisk threaded; reserve→post→record', async () => {
    const client = mockClient();
    const { ledger, calls } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));

    const r = await exec.place(req);

    expect(client.createOrder).toHaveBeenCalledWith(
      { tokenID: 'tok-yes', price: 0.18, size: 74, side: 'BUY' },
      { tickSize: 0.01, negRisk: true },
    );
    expect(client.postOrder).toHaveBeenCalledTimes(1);
    expect(client.postOrder).toHaveBeenCalledWith(expect.anything(), 'GTC', true);
    // ordering: reserve BEFORE post, record AFTER
    const order = calls.map((c) => c.fn);
    expect(order).toEqual(['findByIntentKey', 'reserveIntent', 'recordPlaced']);
    expect(r).toMatchObject({ mode: 'live', status: 'placed', orderId: '0xORDER', limitPrice: 0.18, postOnly: true, orderType: 'GTC', sizeMatched: 0 });
  });

  it('live SELL take-profit rests strictly above best bid', async () => {
    const client = mockClient();
    const { ledger } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));
    await exec.place({ ...req, side: 'SELL', purpose: 'take_profit', targetPrice: 0.11 });
    // best bid 0.10 → snap up target 0.11 → 0.11 (>0.10) stays; strictly above bid
    expect(client.createOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL', price: 0.11 }), expect.anything());
  });

  it('dry-run: logs the redacted payload, returns synthetic dry_run, NEVER posts or writes the ledger', async () => {
    const client = mockClient();
    const { ledger, calls } = mockLedger();
    const log = vi.fn();
    const exec = new MakerExecutor(deps('dry-run', client, ledger, { log }));

    const r = await exec.place(req);

    expect(client.postOrder).not.toHaveBeenCalled();
    expect(calls.some((c) => c.fn === 'reserveIntent' || c.fn === 'recordPlaced')).toBe(false);
    expect(r).toMatchObject({ mode: 'dry-run', status: 'dry_run', orderId: null, limitPrice: 0.18, clientOrderId: 'cid-fixed' });
    const logged = log.mock.calls[0]![0] as Record<string, unknown>;
    expect(logged['msg']).toBe('maker.dry_run');
    const payload = logged['payload'] as Record<string, unknown>;
    expect(payload['signature']).toBe('…REDACTED');
    expect((payload['args'] as Record<string, unknown>)['tokenID']).toBe('tok-yes');
  });

  it('off: no-op, never constructs a client or posts', async () => {
    const client = mockClient();
    const { ledger } = mockLedger();
    const clientFactory = vi.fn(async () => client);
    const exec = new MakerExecutor({ ...deps('off', client, ledger), client: clientFactory });
    const r = await exec.place(req);
    expect(r.status).toBe('skipped_off');
    expect(clientFactory).not.toHaveBeenCalled();
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('idempotency: an OPEN intent for the key is NEVER re-placed (no createOrder/postOrder)', async () => {
    const client = mockClient();
    const openRow: OrderLedgerRow = { intentKey: '0xcond|BUY|entry|2026-07-05', clientOrderId: 'cid-old', status: 'placed', orderId: '0xOLD', side: 'BUY', purpose: 'entry', price: 0.18, size: 74, sizeMatched: 0 };
    const { ledger } = mockLedger(openRow);
    const exec = new MakerExecutor(deps('live', client, ledger));

    const r = await exec.place(req);

    expect(r).toMatchObject({ status: 'duplicate', clientOrderId: 'cid-old', orderId: '0xOLD' });
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('idempotency race: reserveIntent returns exists → duplicate, postOrder NOT called', async () => {
    const client = mockClient();
    const { ledger } = mockLedger();
    // findByIntentKey sees nothing, but reserveIntent races to 'exists'.
    (ledger.findByIntentKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (ledger.reserveIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce('exists');
    const exec = new MakerExecutor(deps('live', client, ledger));

    const r = await exec.place(req);

    expect(r.status).toBe('duplicate');
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('partial fill: records partial with cumulative size_matched', async () => {
    const client = mockClient({ getOrder: vi.fn(async () => ({ status: 'live', original_size: '74', size_matched: '30', price: '0.18' })) });
    const { ledger, calls } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));

    const r = await exec.place(req);

    expect(r.sizeMatched).toBe(30);
    expect(calls.find((c) => c.fn === 'recordFill')?.args).toEqual(['cid-fixed', 30, 0.18, 'partial']);
  });

  it('fully matched maker: records filled', async () => {
    const client = mockClient({ getOrder: vi.fn(async () => ({ status: 'matched', original_size: '74', size_matched: '74', price: '0.18' })) });
    const { ledger, calls } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));
    await exec.place(req);
    expect(calls.find((c) => c.fn === 'recordFill')?.args).toEqual(['cid-fixed', 74, 0.18, 'filled']);
  });

  it('not makeable: a crossing book returns not_makeable, no reserve/post', async () => {
    // bestAsk one tick above the floor → a BUY cannot rest below it
    const crossed = { bids: [], asks: [{ price: '0.01', size: '10' }], tick_size: '0.01', min_order_size: '5' };
    const client = mockClient({ getOrderBook: vi.fn(async () => crossed) });
    const { ledger, calls } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));

    const r = await exec.place({ ...req, targetPrice: 0.05 });

    expect(r.status).toBe('not_makeable');
    expect(client.postOrder).not.toHaveBeenCalled();
    expect(calls.some((c) => c.fn === 'reserveIntent')).toBe(false);
  });

  it('below market min size throws ERR_MIN_SIZE before any order call', async () => {
    const client = mockClient();
    const { ledger } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));
    await expect(exec.place({ ...req, size: 3 })).rejects.toMatchObject({ code: 'ERR_MIN_SIZE' });
    expect(client.createOrder).not.toHaveBeenCalled();
  });

  it('placement error: recordFailed + CRITICAL alert, NEVER retried (one postOrder), throws ExecutionError', async () => {
    const client = mockClient({ postOrder: vi.fn(async () => Promise.reject(new Error('clob 503'))) });
    const { ledger, calls } = mockLedger();
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));

    await expect(exec.place(req)).rejects.toThrow(ExecutionError);
    expect(client.postOrder).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.fn === 'recordFailed')).toBe(true);
    expect(alerts[0]).toMatchObject({ kind: 'ORDER_FAIL', severity: 'CRITICAL' });
  });

  it('postOrder returning no orderID is a placement error (recorded failed, thrown)', async () => {
    const client = mockClient({ postOrder: vi.fn(async () => ({ success: true })) });
    const { ledger, calls } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));
    await expect(exec.place(req)).rejects.toMatchObject({ code: 'ERR_CLOB_POST' });
    expect(calls.some((c) => c.fn === 'recordFailed')).toBe(true);
  });
});

describe('MakerExecutor.placeTaker — FAK exit leg', () => {
  it('live: FAK, worst-price snapped, post_only NOT set', async () => {
    const client = mockClient({ getOrder: vi.fn(async () => ({ status: 'matched', original_size: '74', size_matched: '74', price: '0.31' })) });
    const { ledger } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));

    const t: TakerOrderRequest = { marketId: '0xcond', tokenId: 'tok-yes', side: 'SELL', purpose: 'stop_loss', tradeDate: '2026-07-05', worstPrice: 0.312, size: 74 };
    const r = await exec.placeTaker(t);

    expect(client.postOrder).toHaveBeenCalledWith(expect.anything(), 'FAK', false);
    expect(client.createOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL', price: 0.31 }), expect.anything());
    expect(r).toMatchObject({ status: 'placed', orderType: 'FAK', postOnly: false, sizeMatched: 74 });
  });

  it('dry-run taker: no post', async () => {
    const client = mockClient();
    const { ledger } = mockLedger();
    const exec = new MakerExecutor(deps('dry-run', client, ledger));
    const r = await exec.placeTaker({ marketId: '0xcond', tokenId: 'tok-yes', side: 'SELL', purpose: 'time_stop', tradeDate: '2026-07-05', worstPrice: 0.3, size: 74 });
    expect(r.status).toBe('dry_run');
    expect(client.postOrder).not.toHaveBeenCalled();
  });
});

describe('MakerExecutor lifecycle — cancel / cancel-all / list / poll / reprice', () => {
  it('cancel: live cancels + records; dry-run is a no-op', async () => {
    const client = mockClient();
    const { ledger, calls } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));
    const res = await exec.cancel('0xORDER', 'cid-1');
    expect(client.cancelOrder).toHaveBeenCalledWith({ orderID: '0xORDER' });
    expect(res.allCanceled).toBe(true);
    expect(calls.some((c) => c.fn === 'recordCanceled')).toBe(true);

    const client2 = mockClient();
    const exec2 = new MakerExecutor(deps('dry-run', client2, mockLedger().ledger));
    await exec2.cancel('0xORDER');
    expect(client2.cancelOrder).not.toHaveBeenCalled();
  });

  it('cancelAllForMarket: cancelMarketOrders with market + asset_id', async () => {
    const client = mockClient();
    const exec = new MakerExecutor(deps('live', client, mockLedger().ledger));
    await exec.cancelAllForMarket('0xcond', 'tok-yes');
    expect(client.cancelMarketOrders).toHaveBeenCalledWith({ market: '0xcond', asset_id: 'tok-yes' });
  });

  it('listOpenOrders parses the venue response; non-live returns []', async () => {
    const client = mockClient();
    const exec = new MakerExecutor(deps('live', client, mockLedger().ledger));
    const open = await exec.listOpenOrders({ market: '0xcond' });
    expect(open[0]).toMatchObject({ orderId: '0xORDER', originalSize: 74 });
    const execDry = new MakerExecutor(deps('dry-run', client, mockLedger().ledger));
    expect(await execDry.listOpenOrders()).toEqual([]);
  });

  it('pollFill returns partial-fill state (live)', async () => {
    const client = mockClient({ getOrder: vi.fn(async () => ({ status: 'live', original_size: '74', size_matched: '40', price: '0.19' })) });
    const exec = new MakerExecutor(deps('live', client, mockLedger().ledger));
    expect(await exec.pollFill('0xORDER', 74)).toMatchObject({ partial: true, sizeMatched: 40 });
  });

  it('reprice: cancel succeeds → reposts remainder at the new price (same intent key freed by cancel)', async () => {
    const client = mockClient();
    const { ledger } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));
    const { cancel, placed } = await exec.reprice('0xOLD', 'cid-old', { ...req, targetPrice: 0.17 });
    expect(cancel.allCanceled).toBe(true);
    expect(client.createOrder).toHaveBeenCalledWith(expect.objectContaining({ price: 0.17, size: 74 }), expect.anything());
    expect(placed.status).toBe('placed');
  });

  it('reprice: cancel races a full fill (not_canceled) → does NOT repost (no double position)', async () => {
    const client = mockClient({
      cancelOrder: vi.fn(async () => ({ canceled: [], not_canceled: { '0xOLD': 'order is filled' } })),
      getOrder: vi.fn(async () => ({ status: 'matched', original_size: '74', size_matched: '74', price: '0.18' })),
    });
    const { ledger } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));
    const { cancel, placed } = await exec.reprice('0xOLD', 'cid-old', { ...req, minOrderSize: 5 });
    expect(cancel.allCanceled).toBe(false);
    expect(placed.status).toBe('rejected');
    expect(client.postOrder).not.toHaveBeenCalled();
  });
});
