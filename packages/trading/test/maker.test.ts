/**
 * MakerExecutor (§6.20 MAKER-EXIT extension — DORMANT, mock-tested) against a clob-client mock + a
 * mode-scoped fake OrderLedger: maker pricing enforced by price, the TRADE_MODE gate (off never touches
 * ledger or venue / dry-run records intents but never posts / live), (mode, intent_key)-scoped
 * idempotency (a retry, crash-restart, or concurrent placer NEVER double-places; a dry-run row never
 * blocks a live intent), the CRITICAL-1 post-succeeded failure semantics (key stays reserved +
 * needs-reconcile), partial-fill accounting, error-string redaction, cancel / cancel-all / reprice
 * (remainder from the LEDGER original size), the taker FAK exit leg, and the startup reconcile sweep
 * (adopt / freed / held-on-ambiguity). Mirrors the mock-factory injection idiom of live.test.ts.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
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
const KEY = '0xcond|BUY|entry|2026-07-05';

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
    getTrades: vi.fn(async () => []),
    cancelOrder: vi.fn(async (p: { orderID: string }) => ({ canceled: [p.orderID], not_canceled: {} })),
    cancelOrders: vi.fn(async () => ({ canceled: [], not_canceled: {} })),
    cancelAll: vi.fn(async () => ({ canceled: [], not_canceled: {} })),
    cancelMarketOrders: vi.fn(async () => ({ canceled: [], not_canceled: {} })),
    ...overrides,
  };
}

/** Row factory for seeding the fake ledger. */
const row = (over: Partial<OrderLedgerRow> = {}): OrderLedgerRow => ({
  mode: 'live',
  intentKey: KEY,
  clientOrderId: 'cid-old',
  status: 'placed',
  orderId: '0xOLD',
  side: 'BUY',
  purpose: 'entry',
  price: 0.18,
  size: 74,
  sizeMatched: 0,
  tokenId: 'tok-yes',
  marketId: '0xcond',
  createdAt: null,
  ...over,
});

/**
 * Stateful in-memory OrderLedger enforcing the (mode, intent_key) partial-unique semantics — only
 * OPEN rows (status not canceled/failed) block a reserve. Faked directly, the live.test mockDb idiom.
 */
function mockLedger(seed: OrderLedgerRow[] = []) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rows = new Map<string, OrderLedgerRow>(); // by clientOrderId
  const open = new Map<string, OrderLedgerRow>(); // by `${mode}|${intentKey}`, OPEN rows only
  const okey = (mode: string, k: string): string => `${mode}|${k}`;
  for (const r of seed) {
    rows.set(r.clientOrderId, r);
    if (r.status !== 'canceled' && r.status !== 'failed') open.set(okey(r.mode, r.intentKey), r);
  }
  const ledger: OrderLedger = {
    findByIntentKey: vi.fn(async (k: string, mode) => {
      calls.push({ fn: 'findByIntentKey', args: [k, mode] });
      return open.get(okey(mode, k)) ?? null;
    }),
    reserveIntent: vi.fn(async (input) => {
      calls.push({ fn: 'reserveIntent', args: [input] });
      if (open.has(okey(input.mode, input.intentKey))) return 'exists';
      const r = row({ mode: input.mode, intentKey: input.intentKey, clientOrderId: input.clientOrderId, status: 'intent', orderId: null, side: input.side, purpose: input.purpose, price: input.price, size: input.size, tokenId: input.tokenId, marketId: input.marketId });
      open.set(okey(input.mode, input.intentKey), r);
      rows.set(input.clientOrderId, r);
      return 'reserved';
    }),
    listDanglingIntents: vi.fn(async (mode) => {
      calls.push({ fn: 'listDanglingIntents', args: [mode] });
      return [...rows.values()].filter((r) => r.mode === mode && r.status === 'intent' && r.orderId === null);
    }),
    // T3 round-2 fidelity: record_* on an UNKNOWN client_order_id RAISES (reconcile-bug surfacing);
    // a late record_placed never regresses a partial/filled status.
    recordPlaced: vi.fn(async (cid: string, oid: string) => {
      calls.push({ fn: 'recordPlaced', args: [cid, oid] });
      const r = rows.get(cid);
      if (!r) throw new Error(`bot_order_record_placed: no ledger row for ${cid}`);
      r.orderId = oid;
      if (r.status === 'intent') r.status = 'placed';
    }),
    recordFill: vi.fn(async (cid, sm, ap, st) => {
      calls.push({ fn: 'recordFill', args: [cid, sm, ap, st] });
      const r = rows.get(cid);
      if (!r) throw new Error(`bot_order_record_fill: no ledger row for ${cid}`);
      r.sizeMatched = sm;
      r.status = st; // 'filled' stays OPEN for uniqueness (blocks the key)
    }),
    recordCanceled: vi.fn(async (cid: string) => {
      calls.push({ fn: 'recordCanceled', args: [cid] });
      const r = rows.get(cid);
      if (!r) throw new Error(`bot_order_record_canceled: no ledger row for ${cid}`);
      r.status = 'canceled';
      open.delete(okey(r.mode, r.intentKey));
    }),
    recordFailed: vi.fn(async (cid: string, err: string) => {
      calls.push({ fn: 'recordFailed', args: [cid, err] });
      const r = rows.get(cid);
      if (!r) throw new Error(`bot_order_record_failed: no ledger row for ${cid}`);
      r.status = 'failed';
      open.delete(okey(r.mode, r.intentKey));
    }),
  };
  return { ledger, calls, rows, open };
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

const callOrder = (fn: unknown): number => (fn as Mock).mock.invocationCallOrder[0]!;

describe('MakerExecutor.place — maker pricing + mode + idempotency', () => {
  it('live BUY: rests strictly below best ask (0.18<0.20), GTC + post_only=true, negRisk threaded; find→reserve(mode live)→post→record', async () => {
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
    expect(calls.map((c) => c.fn)).toEqual(['findByIntentKey', 'reserveIntent', 'recordPlaced']);
    expect(calls[0]!.args).toEqual([KEY, 'live']);
    expect(calls[1]!.args[0]).toMatchObject({ mode: 'live', intentKey: KEY });
    expect(r).toMatchObject({ mode: 'live', status: 'placed', orderId: '0xORDER', limitPrice: 0.18, postOnly: true, orderType: 'GTC', sizeMatched: 0 });
  });

  it('live SELL take-profit rests strictly above best bid', async () => {
    const client = mockClient();
    const { ledger } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));
    await exec.place({ ...req, side: 'SELL', purpose: 'take_profit', targetPrice: 0.11 });
    expect(client.createOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL', price: 0.11 }), expect.anything());
  });

  it('dry-run: reserves + synthetic recordPlaced under mode dry-run, logs the redacted payload, venue NEVER posted/canceled', async () => {
    const client = mockClient();
    const { ledger, rows } = mockLedger();
    const log = vi.fn();
    const exec = new MakerExecutor(deps('dry-run', client, ledger, { log }));

    const r = await exec.place(req);

    expect(client.postOrder).not.toHaveBeenCalled();
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect(client.cancelMarketOrders).not.toHaveBeenCalled();
    expect(r).toMatchObject({ mode: 'dry-run', status: 'dry_run', orderId: 'dry-run:cid-fixed', limitPrice: 0.18, clientOrderId: 'cid-fixed' });
    expect(rows.get('cid-fixed')).toMatchObject({ mode: 'dry-run', status: 'placed', orderId: 'dry-run:cid-fixed' });
    const logged = log.mock.calls[0]![0] as Record<string, unknown>;
    expect(logged['msg']).toBe('maker.dry_run');
    const payload = logged['payload'] as Record<string, unknown>;
    expect(payload['signature']).toBe('…REDACTED');
    expect((payload['args'] as Record<string, unknown>)['tokenID']).toBe('tok-yes');
  });

  it('dry-run idempotency: a second dry-run place for the same intent is a duplicate', async () => {
    const client = mockClient();
    const { ledger } = mockLedger();
    const exec = new MakerExecutor(deps('dry-run', client, ledger));
    await exec.place(req);
    const r2 = await exec.place(req);
    expect(r2.status).toBe('duplicate');
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('F4 seam: a live reserve SUCCEEDS beside a same-key dry-run row (mode-scoped partial-unique)', async () => {
    const client = mockClient();
    const { ledger } = mockLedger([row({ mode: 'dry-run', clientOrderId: 'cid-dry', status: 'placed', orderId: 'dry-run:cid-dry' })]);
    const exec = new MakerExecutor(deps('live', client, ledger));

    const r = await exec.place(req);

    expect(r.status).toBe('placed');
    expect(client.postOrder).toHaveBeenCalledTimes(1);
  });

  it("off: no-op — never constructs a client, never posts, and NEVER writes the ledger ('off' fails the schema mode CHECK)", async () => {
    const client = mockClient();
    const { ledger, calls } = mockLedger();
    const clientFactory = vi.fn(async () => client);
    const exec = new MakerExecutor({ ...deps('off', client, ledger), client: clientFactory });

    const r = await exec.place(req);
    const t = await exec.placeTaker({ marketId: '0xcond', tokenId: 'tok-yes', side: 'SELL', purpose: 'stop_loss', tradeDate: '2026-07-05', worstPrice: 0.3, size: 74 });

    expect(r.status).toBe('skipped_off');
    expect(t.status).toBe('skipped_off');
    expect(clientFactory).not.toHaveBeenCalled();
    expect(client.postOrder).not.toHaveBeenCalled();
    expect(calls).toEqual([]); // zero ledger calls of ANY kind
  });

  it('idempotency: an OPEN live intent for the key is NEVER re-placed (no createOrder/postOrder)', async () => {
    const client = mockClient();
    const { ledger } = mockLedger([row()]);
    const exec = new MakerExecutor(deps('live', client, ledger));

    const r = await exec.place(req);

    expect(r).toMatchObject({ status: 'duplicate', clientOrderId: 'cid-old', orderId: '0xOLD' });
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('idempotency race: reserveIntent returns exists → duplicate, postOrder NOT called', async () => {
    const client = mockClient();
    const { ledger } = mockLedger();
    (ledger.findByIntentKey as Mock).mockResolvedValueOnce(null);
    (ledger.reserveIntent as Mock).mockResolvedValueOnce('exists');
    const exec = new MakerExecutor(deps('live', client, ledger));

    const r = await exec.place(req);

    expect(r.status).toBe('duplicate');
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('partial fill: records partial with the CUMULATIVE size_matched', async () => {
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

  it('HIGH-A (a): postOrder transport-throws (lost response) → row HELD at intent, NO recordFailed, needs-reconcile CRITICAL names the intent, retry is duplicate, the reconcile sweep sees the row', async () => {
    const client = mockClient({ postOrder: vi.fn(async () => Promise.reject(new Error('ECONNRESET clob 503; bearer: tok_abcdef123456'))) });
    const { ledger, calls, rows } = mockLedger();
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));

    await expect(exec.place(req)).rejects.toThrow(ExecutionError);
    expect(client.postOrder).toHaveBeenCalledTimes(1);
    // The venue MAY hold the order — the key must NOT be freed.
    expect(calls.some((c) => c.fn === 'recordFailed')).toBe(false);
    expect(rows.get('cid-fixed')).toMatchObject({ status: 'intent', orderId: null });
    expect(alerts[0]).toMatchObject({ kind: 'ORDER_NEEDS_RECONCILE', severity: 'CRITICAL' });
    expect(alerts[0]!.body).toContain(KEY); // names the intent
    expect(alerts[0]!.body).not.toContain('tok_abcdef123456'); // redacted (MEDIUM-4)
    // A retried place() is a duplicate — the reserved intent still blocks the key.
    const r2 = await exec.place(req);
    expect(r2.status).toBe('duplicate');
    expect(client.postOrder).toHaveBeenCalledTimes(1);
    // And the reconcile sweep's input INCLUDES the row (status='intent', orderId null).
    const dangling = await ledger.listDanglingIntents('live');
    expect(dangling.map((d) => d.clientOrderId)).toContain('cid-fixed');
  });

  it('HIGH-A (b): a throw BEFORE any venue interaction (book read rejects) leaves ZERO ledger writes — the key is never held', async () => {
    const failing = mockClient({ getOrderBook: vi.fn(async () => Promise.reject(new Error('gateway timeout'))) });
    const { ledger, calls } = mockLedger();
    const exec = new MakerExecutor(deps('live', failing, ledger));

    await expect(exec.place(req)).rejects.toThrow();
    expect(calls.filter((c) => c.fn !== 'findByIntentKey')).toEqual([]); // no reserve, no record*

    // ...and a subsequent attempt with a healthy client succeeds — nothing was left blocking the key.
    const healthy = mockClient();
    const exec2 = new MakerExecutor(deps('live', healthy, ledger));
    const r = await exec2.place(req);
    expect(r.status).toBe('placed');
  });

  it('HIGH-A (c): a CLEAN venue rejection (success=false — processed, refused, no order created) frees the key: recordFailed + ORDER_FAIL', async () => {
    const client = mockClient({ postOrder: vi.fn(async () => ({ success: false, errorMsg: 'not enough balance / allowance' })) });
    const { ledger, calls, rows } = mockLedger();
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));

    await expect(exec.place(req)).rejects.toMatchObject({ code: 'ERR_CLOB_REJECTED' });
    expect(calls.some((c) => c.fn === 'recordFailed')).toBe(true);
    expect(rows.get('cid-fixed')!.status).toBe('failed');
    expect(alerts[0]).toMatchObject({ kind: 'ORDER_FAIL', severity: 'CRITICAL' });
  });

  it('CRITICAL-1 regression: post SUCCEEDS then fill-poll throws → row stays placed (NOT terminal), key NOT re-reservable, needs-reconcile CRITICAL names the order, second place() is duplicate with NO second post', async () => {
    const client = mockClient({ getOrder: vi.fn(async () => Promise.reject(new Error('poll timeout'))) });
    const { ledger, calls, rows } = mockLedger();
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));

    await expect(exec.place(req)).rejects.toThrow(ExecutionError);

    // NEVER recordFailed once an orderId exists — the key must stay reserved.
    expect(calls.some((c) => c.fn === 'recordFailed')).toBe(false);
    expect(rows.get('cid-fixed')).toMatchObject({ status: 'placed', orderId: '0xORDER' });
    // Loud needs-reconcile alert naming the resting orderId.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'ORDER_NEEDS_RECONCILE', severity: 'CRITICAL' });
    expect(alerts[0]!.body).toContain('0xORDER');
    // The key is NOT re-reservable...
    await expect(
      ledger.reserveIntent({ mode: 'live', intentKey: KEY, clientOrderId: 'cid-2', marketId: '0xcond', tokenId: 'tok-yes', side: 'BUY', purpose: 'entry', orderType: 'GTC', price: 0.18, size: 74, tradeDate: '2026-07-05' }),
    ).resolves.toBe('exists');
    // ...and a retried place() is a duplicate — postOrder was called exactly ONCE in total.
    const r2 = await exec.place(req);
    expect(r2.status).toBe('duplicate');
    expect(client.postOrder).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL-1: recordPlaced itself failing still keeps the key (best-effort re-record + reconcile alert, no recordFailed)', async () => {
    const client = mockClient();
    const { ledger, calls } = mockLedger();
    (ledger.recordPlaced as Mock).mockRejectedValue(new Error('db down'));
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));

    await expect(exec.place(req)).rejects.toThrow(ExecutionError);
    expect(calls.some((c) => c.fn === 'recordFailed')).toBe(false);
    expect(alerts[0]).toMatchObject({ kind: 'ORDER_NEEDS_RECONCILE', severity: 'CRITICAL' });
  });

  it('T3 round-2: a record_fill RAISE (e.g. reconcile bug) after a successful post routes to the needs-reconcile alert path, NEVER the key-freeing recordFailed', async () => {
    const client = mockClient({ getOrder: vi.fn(async () => ({ status: 'matched', original_size: '74', size_matched: '74', price: '0.18' })) });
    const { ledger, calls } = mockLedger();
    (ledger.recordFill as Mock).mockRejectedValue(new Error('bot_order_record_fill: no ledger row for cid-fixed'));
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));

    await expect(exec.place(req)).rejects.toThrow(ExecutionError);
    expect(calls.some((c) => c.fn === 'recordFailed')).toBe(false);
    expect(alerts[0]).toMatchObject({ kind: 'ORDER_NEEDS_RECONCILE', severity: 'CRITICAL' });
  });

  it('HIGH-A: a SHAPELESS post response (no orderID, not an explicit rejection) HOLDS at intent — order state unknown', async () => {
    const client = mockClient({ postOrder: vi.fn(async () => ({ success: true })) });
    const { ledger, calls, rows } = mockLedger();
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));
    await expect(exec.place(req)).rejects.toMatchObject({ code: 'ERR_CLOB_POST' });
    expect(calls.some((c) => c.fn === 'recordFailed')).toBe(false);
    expect(rows.get('cid-fixed')!.status).toBe('intent');
    expect(alerts[0]).toMatchObject({ kind: 'ORDER_NEEDS_RECONCILE', severity: 'CRITICAL' });
  });

  it('MEDIUM-4: authent-shaped material in a venue rejection is redacted from the ledger arg, the alert body, AND the thrown message', async () => {
    const client = mockClient({
      postOrder: vi.fn(async () => ({ success: false, errorMsg: '403 POLY_PASSPHRASE: hunter2secret42; signature=0xabcdef1234567890abcdef' })),
    });
    const { ledger, calls } = mockLedger();
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));

    const thrown = await exec.place(req).catch((e: Error) => e);

    const failedArg = String(calls.find((c) => c.fn === 'recordFailed')!.args[1]);
    for (const s of [failedArg, alerts[0]!.body, (thrown as Error).message]) {
      expect(s).not.toContain('hunter2secret42');
      expect(s).not.toContain('0xabcdef1234567890abcdef');
      expect(s).toContain('REDACTED');
    }
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

  it('dry-run taker: reserves + synthetic recordPlaced, never posts', async () => {
    const client = mockClient();
    const { ledger, rows } = mockLedger();
    const exec = new MakerExecutor(deps('dry-run', client, ledger));
    const r = await exec.placeTaker({ marketId: '0xcond', tokenId: 'tok-yes', side: 'SELL', purpose: 'time_stop', tradeDate: '2026-07-05', worstPrice: 0.3, size: 74 });
    expect(r).toMatchObject({ status: 'dry_run', orderId: 'dry-run:cid-fixed' });
    expect(rows.get('cid-fixed')).toMatchObject({ mode: 'dry-run', status: 'placed' });
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('LOW-7: reads minOrderSize from the book when the caller omits it — sub-min rejected locally, never reaches the venue', async () => {
    const client = mockClient(); // book min_order_size 5
    const { ledger } = mockLedger();
    const exec = new MakerExecutor(deps('live', client, ledger));
    await expect(
      exec.placeTaker({ marketId: '0xcond', tokenId: 'tok-yes', side: 'SELL', purpose: 'stop_loss', tradeDate: '2026-07-05', worstPrice: 0.3, size: 3 }),
    ).rejects.toMatchObject({ code: 'ERR_MIN_SIZE' });
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.postOrder).not.toHaveBeenCalled();
  });
});

describe('MakerExecutor lifecycle — cancel / cancel-all / list / poll', () => {
  it('cancel: live cancels + records; dry-run never touches the venue', async () => {
    const client = mockClient();
    const { ledger, calls } = mockLedger([row()]);
    const exec = new MakerExecutor(deps('live', client, ledger));
    const res = await exec.cancel('0xOLD', 'cid-old');
    expect(client.cancelOrder).toHaveBeenCalledWith({ orderID: '0xOLD' });
    expect(res.allCanceled).toBe(true);
    expect(calls.some((c) => c.fn === 'recordCanceled')).toBe(true);

    const client2 = mockClient();
    const exec2 = new MakerExecutor(deps('dry-run', client2, mockLedger().ledger));
    await exec2.cancel('0xORDER');
    expect(client2.cancelOrder).not.toHaveBeenCalled();
  });

  it('cancelAllForMarket: live → cancelMarketOrders with market + asset_id; dry-run never calls the venue', async () => {
    const client = mockClient();
    const exec = new MakerExecutor(deps('live', client, mockLedger().ledger));
    await exec.cancelAllForMarket('0xcond', 'tok-yes');
    expect(client.cancelMarketOrders).toHaveBeenCalledWith({ market: '0xcond', asset_id: 'tok-yes' });

    const client2 = mockClient();
    const execDry = new MakerExecutor(deps('dry-run', client2, mockLedger().ledger));
    await execDry.cancelAllForMarket('0xcond');
    expect(client2.cancelMarketOrders).not.toHaveBeenCalled();
  });

  it('listOpenOrders parses the venue response; non-live returns [] without a venue call', async () => {
    const client = mockClient();
    const exec = new MakerExecutor(deps('live', client, mockLedger().ledger));
    const open = await exec.listOpenOrders({ market: '0xcond' });
    expect(open[0]).toMatchObject({ orderId: '0xORDER', originalSize: 74 });

    const client2 = mockClient();
    const execDry = new MakerExecutor(deps('dry-run', client2, mockLedger().ledger));
    expect(await execDry.listOpenOrders()).toEqual([]);
    expect(client2.getOpenOrders).not.toHaveBeenCalled();
  });

  it('pollFill returns partial-fill state (live); dry-run is synthetic-resting without a venue call', async () => {
    const client = mockClient({ getOrder: vi.fn(async () => ({ status: 'live', original_size: '74', size_matched: '40', price: '0.19' })) });
    const exec = new MakerExecutor(deps('live', client, mockLedger().ledger));
    expect(await exec.pollFill('0xORDER', 74)).toMatchObject({ partial: true, sizeMatched: 40 });

    const client2 = mockClient();
    const execDry = new MakerExecutor(deps('dry-run', client2, mockLedger().ledger));
    expect(await execDry.pollFill('0xORDER', 74)).toMatchObject({ resting: true });
    expect(client2.getOrder).not.toHaveBeenCalled();
  });
});

describe('MakerExecutor.reprice — cancel-then-repost the ledger remainder (MEDIUM-5/LOW-6)', () => {
  const stateClient = (
    oldState: { status: string; original_size: string; size_matched: string; price: string },
    overrides: Partial<MakerClobClientish> = {},
  ): MakerClobClientish =>
    mockClient({
      getOrder: vi.fn(async (id: string) =>
        id === '0xOLD' ? oldState : { status: 'live', original_size: '74', size_matched: '0', price: '0.18' },
      ),
      ...overrides,
    });

  it('clean reprice (no fills): frees the old row AFTER the venue cancel and BEFORE the replacement post', async () => {
    const client = stateClient({ status: 'canceled', original_size: '74', size_matched: '0', price: '0.18' });
    const { ledger } = mockLedger([row()]);
    const exec = new MakerExecutor(deps('live', client, ledger));

    const { cancel, placed } = await exec.reprice('0xOLD', 'cid-old', { ...req, targetPrice: 0.17 });

    expect(cancel.allCanceled).toBe(true);
    expect(placed.status).toBe('placed');
    expect(client.createOrder).toHaveBeenCalledWith(expect.objectContaining({ price: 0.17, size: 74 }), expect.anything());
    // crash-safety ordering: venue cancel → free the key → post the replacement
    expect(callOrder(client.cancelOrder)).toBeLessThan(callOrder(ledger.recordCanceled));
    expect(callOrder(ledger.recordCanceled)).toBeLessThan(callOrder(client.postOrder));
  });

  it('cancel races a COMPLETE fill: books the fill, does NOT free the key, does NOT repost', async () => {
    const client = stateClient(
      { status: 'matched', original_size: '74', size_matched: '74', price: '0.18' },
      { cancelOrder: vi.fn(async () => ({ canceled: [], not_canceled: { '0xOLD': 'order is filled' } })) },
    );
    const { ledger, calls } = mockLedger([row()]);
    const exec = new MakerExecutor(deps('live', client, ledger));

    const { cancel, placed } = await exec.reprice('0xOLD', 'cid-old', req);

    expect(cancel.allCanceled).toBe(false);
    expect(placed.status).toBe('rejected');
    expect(placed.reason).toContain('fully filled');
    expect(calls.find((c) => c.fn === 'recordFill')?.args).toEqual(['cid-old', 74, 0.18, 'filled']);
    expect(calls.some((c) => c.fn === 'recordCanceled')).toBe(false);
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('LOW-8: partial fill before the cancel → books the partial FIRST, frees, reposts ONLY the remainder (74−30=44)', async () => {
    const client = stateClient({ status: 'canceled', original_size: '74', size_matched: '30', price: '0.18' });
    const { ledger, calls } = mockLedger([row()]);
    const exec = new MakerExecutor(deps('live', client, ledger));

    const { placed } = await exec.reprice('0xOLD', 'cid-old', { ...req, targetPrice: 0.17 });

    expect(calls.find((c) => c.fn === 'recordFill')?.args).toEqual(['cid-old', 30, 0.18, 'partial']);
    const fillIdx = calls.findIndex((c) => c.fn === 'recordFill');
    const cancelIdx = calls.findIndex((c) => c.fn === 'recordCanceled');
    expect(fillIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeGreaterThan(fillIdx); // accounting booked BEFORE the free
    expect(placed.status).toBe('placed');
    expect(client.createOrder).toHaveBeenCalledWith(expect.objectContaining({ size: 44 }), expect.anything());
  });

  it('cancel failed and the order is STILL LIVE: aborts — no ledger transition, no repost (double-place guard)', async () => {
    const client = stateClient(
      { status: 'live', original_size: '74', size_matched: '0', price: '0.18' },
      { cancelOrder: vi.fn(async () => ({ canceled: [], not_canceled: { '0xOLD': 'rate limited' } })) },
    );
    const { ledger, calls } = mockLedger([row()]);
    const exec = new MakerExecutor(deps('live', client, ledger));

    const { placed } = await exec.reprice('0xOLD', 'cid-old', req);

    expect(placed.status).toBe('rejected');
    expect(placed.reason).toContain('still live');
    expect(calls.some((c) => c.fn === 'recordCanceled' || c.fn === 'recordFill' || c.fn === 'recordFailed')).toBe(false);
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('LOW-6: a newReq.size that disagrees with the ledger original size is rejected (ERR_REPRICE_SIZE)', async () => {
    const client = stateClient({ status: 'canceled', original_size: '74', size_matched: '0', price: '0.18' });
    const { ledger } = mockLedger([row({ size: 74 })]);
    const exec = new MakerExecutor(deps('live', client, ledger));
    await expect(exec.reprice('0xOLD', 'cid-old', { ...req, size: 50 })).rejects.toMatchObject({ code: 'ERR_REPRICE_SIZE' });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('a mismatched oldClientOrderId is rejected (ERR_REPRICE_STATE)', async () => {
    const client = stateClient({ status: 'canceled', original_size: '74', size_matched: '0', price: '0.18' });
    const { ledger } = mockLedger([row({ clientOrderId: 'cid-actual' })]);
    const exec = new MakerExecutor(deps('live', client, ledger));
    await expect(exec.reprice('0xOLD', 'cid-old', req)).rejects.toMatchObject({ code: 'ERR_REPRICE_STATE' });
  });

  it('dry-run reprice: ledger-only (free old + re-place), venue mutating calls NEVER made', async () => {
    const client = mockClient();
    const { ledger, calls } = mockLedger([row({ mode: 'dry-run', clientOrderId: 'cid-dry', status: 'placed', orderId: 'dry-run:cid-dry' })]);
    const exec = new MakerExecutor(deps('dry-run', client, ledger));

    const { placed } = await exec.reprice('dry-run:cid-dry', 'cid-dry', { ...req, targetPrice: 0.17 });

    expect(placed.status).toBe('dry_run');
    expect(calls.some((c) => c.fn === 'recordCanceled')).toBe(true);
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect(client.postOrder).not.toHaveBeenCalled();
  });

  it('off reprice: rejected, zero ledger + venue calls', async () => {
    const client = mockClient();
    const { ledger, calls } = mockLedger([row()]);
    const exec = new MakerExecutor(deps('off', client, ledger));
    const { placed } = await exec.reprice('0xOLD', 'cid-old', req);
    expect(placed.status).toBe('rejected');
    expect(calls).toEqual([]);
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });
});

describe('MakerExecutor.reconcileOpenOrders — the startup sweep (HIGH-2)', () => {
  const dangling = (): OrderLedgerRow => row({ clientOrderId: 'cid-dangling', status: 'intent', orderId: null });
  const venueOrder = (id: string, over: Record<string, string> = {}) => ({
    id, status: 'live', side: 'BUY', asset_id: 'tok-yes', original_size: '74', size_matched: '0', price: '0.18', order_type: 'GTC', ...over,
  });

  it('non-live: returns [] and never touches the venue or the ledger', async () => {
    const client = mockClient();
    const { ledger, calls } = mockLedger([dangling()]);
    const clientFactory = vi.fn(async () => client);
    const exec = new MakerExecutor({ ...deps('dry-run', client, ledger), client: clientFactory });
    expect(await exec.reconcileOpenOrders()).toEqual([]);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('adopt: exactly one venue open order matches (side/price/size) → recordPlaced with the venue orderId', async () => {
    const client = mockClient({ getOpenOrders: vi.fn(async () => [venueOrder('0xV1')]) });
    const { ledger, rows } = mockLedger([dangling()]);
    const exec = new MakerExecutor(deps('live', client, ledger));

    const out = await exec.reconcileOpenOrders();

    expect(out).toEqual([expect.objectContaining({ kind: 'adopted', clientOrderId: 'cid-dangling', orderId: '0xV1' })]);
    expect(client.getOpenOrders).toHaveBeenCalledWith({ asset_id: 'tok-yes' });
    expect(rows.get('cid-dangling')).toMatchObject({ status: 'placed', orderId: '0xV1' });
  });

  it('ambiguous (two candidates): held + WARN alert; the row stays non-terminal, the key is NOT freed', async () => {
    const client = mockClient({ getOpenOrders: vi.fn(async () => [venueOrder('0xV1'), venueOrder('0xV2')]) });
    const { ledger, calls, rows } = mockLedger([dangling()]);
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));

    const out = await exec.reconcileOpenOrders();

    expect(out[0]).toMatchObject({ kind: 'held', clientOrderId: 'cid-dangling' });
    expect(alerts[0]).toMatchObject({ kind: 'RECONCILE_AMBIGUOUS', severity: 'WARN' });
    expect(rows.get('cid-dangling')!.status).toBe('intent');
    expect(calls.some((c) => c.fn === 'recordFailed' || c.fn === 'recordPlaced')).toBe(false);
  });

  it('freed: no open order AND no matching trade → confirmed never posted → recordFailed frees the key', async () => {
    const client = mockClient({ getOpenOrders: vi.fn(async () => []), getTrades: vi.fn(async () => []) });
    const { ledger, rows } = mockLedger([dangling()]);
    const exec = new MakerExecutor(deps('live', client, ledger));

    const out = await exec.reconcileOpenOrders();

    expect(out[0]).toMatchObject({ kind: 'freed', clientOrderId: 'cid-dangling' });
    expect(rows.get('cid-dangling')!.status).toBe('failed');
  });

  it('no open order BUT a matching same-side trade at our price: held (could be our fill) — never freed', async () => {
    const client = mockClient({
      getOpenOrders: vi.fn(async () => []),
      getTrades: vi.fn(async () => [{ price: '0.18', side: 'BUY', size: '74', asset_id: 'tok-yes', status: 'CONFIRMED' }]),
    });
    const { ledger, calls, rows } = mockLedger([dangling()]);
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));

    const out = await exec.reconcileOpenOrders();

    expect(out[0]).toMatchObject({ kind: 'held' });
    expect(alerts[0]).toMatchObject({ kind: 'RECONCILE_AMBIGUOUS', severity: 'WARN' });
    expect(rows.get('cid-dangling')!.status).toBe('intent');
    expect(calls.some((c) => c.fn === 'recordFailed')).toBe(false);
  });

  it('an evidence read failing (malformed open-orders response) holds the row — never frees on missing evidence', async () => {
    const client = mockClient({ getOpenOrders: vi.fn(async () => 'not a list') });
    const { ledger, calls, rows } = mockLedger([dangling()]);
    const exec = new MakerExecutor(deps('live', client, ledger));

    const out = await exec.reconcileOpenOrders();

    expect(out[0]).toMatchObject({ kind: 'held' });
    expect(rows.get('cid-dangling')!.status).toBe('intent');
    expect(calls.some((c) => c.fn === 'recordFailed')).toBe(false);
  });

  it('LOW-B: ReconcileOutcome.reason is redacted at the STRUCT (not just the alert) — T2 may log/persist it', async () => {
    const client = mockClient({
      getOpenOrders: vi.fn(async () => Promise.reject(new Error('401 POLY_PASSPHRASE: hunter2secret42'))),
    });
    const { ledger } = mockLedger([dangling()]);
    const alerts: TradeAlert[] = [];
    const exec = new MakerExecutor(deps('live', client, ledger, { notify: async (a: TradeAlert) => (alerts.push(a), true) }));

    const out = await exec.reconcileOpenOrders();

    expect(out[0]!.kind).toBe('held');
    expect(out[0]!.reason).not.toContain('hunter2secret42');
    expect(out[0]!.reason).toContain('REDACTED');
    expect(alerts[0]!.body).not.toContain('hunter2secret42');
  });
});
