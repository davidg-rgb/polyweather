/**
 * 0084 #17 — taker FAK exit fees reach the ledger. The stop-loss / time-stop leg is a TAKER FAK sell on
 * markets with a live weather taker-fee schedule; before 0084 every recordFill hard-carried fee $0 (the
 * live_fills.fee_usd column default), so the N1 daily-loss kill's fee terms were dead code. `placeTaker`
 * now books `feeRateBps/10 000 × avgPrice × sizeMatched` with the fill; the MAKER path (post_only never
 * crosses → $0 fee by construction) keeps recording fee 0. Focused executor test — a mock client + a
 * capturing OrderLedger fake (the maker.test.ts idiom), no PGlite.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MakerExecutor,
  type MakerClobClientish,
  type OrderLedger,
  type TakerOrderRequest,
} from '../src/index.ts';

const flatBook = {
  bids: [{ price: '0.08', size: '500' }, { price: '0.1', size: '900' }],
  asks: [{ price: '0.22', size: '800' }, { price: '0.2', size: '700' }],
  tick_size: '0.01',
  min_order_size: '5',
};

function mockClient(getOrder: () => Promise<unknown>): MakerClobClientish {
  return {
    getTickSize: vi.fn(async () => '0.01'),
    getOrderBook: vi.fn(async () => flatBook),
    createOrder: vi.fn(async () => ({ signed: true })),
    postOrder: vi.fn(async () => ({ orderID: '0xORDER', success: true })),
    getOrder: vi.fn(getOrder) as MakerClobClientish['getOrder'],
    getOpenOrders: vi.fn(async () => []),
    getTrades: vi.fn(async () => []),
    cancelOrder: vi.fn(async (p: { orderID: string }) => ({ canceled: [p.orderID], not_canceled: {} })),
    cancelOrders: vi.fn(async () => ({ canceled: [], not_canceled: {} })),
    cancelAll: vi.fn(async () => ({ canceled: [], not_canceled: {} })),
    cancelMarketOrders: vi.fn(async () => ({ canceled: [], not_canceled: {} })),
  };
}

/** Minimal capturing ledger — reserve always succeeds; recordFill args are the assertion target. */
function capturingLedger() {
  const fills: unknown[][] = [];
  const ledger: OrderLedger = {
    findByIntentKey: vi.fn(async () => null),
    reserveIntent: vi.fn(async () => 'reserved' as const),
    listDanglingIntents: vi.fn(async () => []),
    recordPlaced: vi.fn(async () => {}),
    recordFill: vi.fn(async (...args: unknown[]) => {
      fills.push(args);
    }) as OrderLedger['recordFill'],
    recordCanceled: vi.fn(async () => {}),
    recordFailed: vi.fn(async () => {}),
  };
  return { ledger, fills };
}

const takerReq = (over: Partial<TakerOrderRequest> = {}): TakerOrderRequest => ({
  marketId: '0xcond',
  tokenId: 'tok-yes',
  side: 'SELL',
  purpose: 'time_stop',
  tradeDate: '2026-07-05',
  worstPrice: 0.15,
  size: 20,
  negRisk: true,
  minOrderSize: 5,
  ...over,
});

function executor(client: MakerClobClientish, ledger: OrderLedger): MakerExecutor {
  return new MakerExecutor({
    db: { rpc: async () => [], getConfigRows: async () => [] },
    client: async () => client,
    notify: async () => true,
    getEnvVar: (n) => (n === 'TRADE_MODE' ? 'live' : undefined),
    ledger,
    newClientOrderId: () => 'cid-fee',
    log: () => {},
  });
}

describe('placeTaker — #17 fee wiring', () => {
  it('books feeRateBps × avgPrice × sizeMatched with a FILLED FAK exit', async () => {
    // FAK fills immediately: 20 sh @ avg 0.16. Weather taker 5% ⇒ feeRateBps 500 ⇒ 0.05 × 0.16 × 20 = $0.16.
    const client = mockClient(async () => ({ status: 'matched', original_size: '20', size_matched: '20', price: '0.16' }));
    const { ledger, fills } = capturingLedger();
    const res = await executor(client, ledger).placeTaker(takerReq({ feeRateBps: 500 }));
    expect(res.status).toBe('placed');
    expect(fills).toEqual([['cid-fee', 20, 0.16, 'filled', 0.16]]);
  });

  it('books the pro-rated fee on a PARTIAL FAK fill', async () => {
    // 8 of 20 filled @ 0.16 ⇒ fee 0.05 × 0.16 × 8 = $0.064.
    const client = mockClient(async () => ({ status: 'live', original_size: '20', size_matched: '8', price: '0.16' }));
    const { ledger, fills } = capturingLedger();
    await executor(client, ledger).placeTaker(takerReq({ feeRateBps: 500 }));
    expect(fills).toEqual([['cid-fee', 8, 0.16, 'partial', 0.064]]);
  });

  it('omitted feeRateBps records fee 0 (the pre-0084 behavior — no silent fabrication)', async () => {
    const client = mockClient(async () => ({ status: 'matched', original_size: '20', size_matched: '20', price: '0.16' }));
    const { ledger, fills } = capturingLedger();
    await executor(client, ledger).placeTaker(takerReq());
    expect(fills).toEqual([['cid-fee', 20, 0.16, 'filled', 0]]);
  });

  it('the MAKER path always records fee 0 (post_only never crosses → $0 fee by construction)', async () => {
    // a maker BUY that fills on the immediate poll — fee must stay 0 whatever the taker schedule is.
    const client = mockClient(async () => ({ status: 'matched', original_size: '74', size_matched: '74', price: '0.18' }));
    const { ledger, fills } = capturingLedger();
    await executor(client, ledger).place({
      marketId: '0xcond',
      tokenId: 'tok-yes',
      side: 'BUY',
      purpose: 'entry',
      tradeDate: '2026-07-05',
      targetPrice: 0.18,
      size: 74,
      negRisk: true,
      minOrderSize: 5,
    });
    expect(fills).toEqual([['cid-fee', 74, 0.18, 'filled', 0]]);
  });
});
