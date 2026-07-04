/**
 * order-intent pure helpers (T1 MAKER-EXIT rail): trade-mode resolution (never defaults live), the
 * idempotency key, maker-price enforcement at the TICK BOUNDARY (BUY strictly below ask / SELL strictly
 * above bid), venue-shape parsers (partial-fill aware), and secret-safe payload redaction.
 */
import { describe, expect, it } from 'vitest';
import {
  makerLimitPrice,
  orderIntentKey,
  parseCancelResult,
  parseOpenOrders,
  parseOrderBookTop,
  parseOrderFillPoll,
  redactOrderPayload,
  resolveTradeMode,
  takerLimitPrice,
} from '../src/index.ts';

const env = (v: string | undefined) => (name: string) => (name === 'TRADE_MODE' ? v : undefined);

describe('resolveTradeMode — never defaults to live', () => {
  it('unset / empty / whitespace / garbage all resolve to dry-run', () => {
    expect(resolveTradeMode(env(undefined))).toBe('dry-run');
    expect(resolveTradeMode(env(''))).toBe('dry-run');
    expect(resolveTradeMode(env('   '))).toBe('dry-run');
    expect(resolveTradeMode(env('paper'))).toBe('dry-run');
    expect(resolveTradeMode(env('LIVEISH'))).toBe('dry-run');
  });
  it('only the exact strings live/off (case/space-insensitive) select those modes', () => {
    expect(resolveTradeMode(env('live'))).toBe('live');
    expect(resolveTradeMode(env('  LIVE '))).toBe('live');
    expect(resolveTradeMode(env('off'))).toBe('off');
    expect(resolveTradeMode(env('OFF'))).toBe('off');
    expect(resolveTradeMode(env('dry-run'))).toBe('dry-run');
  });
});

describe('orderIntentKey', () => {
  it('is market|side|purpose|date and stable', () => {
    const k = orderIntentKey({ marketId: '0xcond', side: 'BUY', purpose: 'entry', tradeDate: '2026-07-05' });
    expect(k).toBe('0xcond|BUY|entry|2026-07-05');
    expect(orderIntentKey({ marketId: '0xcond', side: 'BUY', purpose: 'entry', tradeDate: '2026-07-05' })).toBe(k);
  });
  it('distinguishes side, purpose, and date', () => {
    const base = { marketId: 'm', side: 'BUY', purpose: 'entry', tradeDate: 'd' } as const;
    expect(orderIntentKey({ ...base, side: 'SELL' })).not.toBe(orderIntentKey(base));
    expect(orderIntentKey({ ...base, purpose: 'take_profit' })).not.toBe(orderIntentKey(base));
    expect(orderIntentKey({ ...base, tradeDate: 'd2' })).not.toBe(orderIntentKey(base));
  });
});

describe('makerLimitPrice — maker-ness enforced BY PRICE (tick boundary)', () => {
  const tick = 0.01;

  it('BUY snaps down to the grid, strictly below best ask', () => {
    const r = makerLimitPrice({ side: 'BUY', targetPrice: 0.275, bestBid: 0.2, bestAsk: 0.3, tick });
    expect(r).toEqual({ ok: true, price: 0.27 });
  });
  it('BUY at exactly the ask steps one tick inside (never rests AT the ask)', () => {
    const r = makerLimitPrice({ side: 'BUY', targetPrice: 0.3, bestBid: 0.2, bestAsk: 0.3, tick });
    expect(r).toEqual({ ok: true, price: 0.29 });
  });
  it('BUY above the ask is capped to one tick below the ask (never crosses)', () => {
    const r = makerLimitPrice({ side: 'BUY', targetPrice: 0.5, bestBid: 0.2, bestAsk: 0.3, tick });
    expect(r).toEqual({ ok: true, price: 0.29 });
  });
  it('BUY with no ask on the book is non-crossing at the snapped target', () => {
    const r = makerLimitPrice({ side: 'BUY', targetPrice: 0.275, bestBid: 0.2, bestAsk: null, tick });
    expect(r).toEqual({ ok: true, price: 0.27 });
  });
  it('BUY cannot rest below a 1-tick ask → not makeable', () => {
    expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.05, bestBid: null, bestAsk: 0.01, tick })).toEqual({ ok: false, reason: 'crosses_ask' });
  });

  it('SELL snaps up to the grid, strictly above best bid', () => {
    const r = makerLimitPrice({ side: 'SELL', targetPrice: 0.401, bestBid: 0.38, bestAsk: 0.45, tick });
    expect(r).toEqual({ ok: true, price: 0.41 });
  });
  it('SELL at exactly the bid steps one tick inside (never rests AT the bid)', () => {
    const r = makerLimitPrice({ side: 'SELL', targetPrice: 0.38, bestBid: 0.38, bestAsk: 0.45, tick });
    expect(r).toEqual({ ok: true, price: 0.39 });
  });
  it('SELL below the bid is lifted to one tick above the bid (never crosses)', () => {
    const r = makerLimitPrice({ side: 'SELL', targetPrice: 0.1, bestBid: 0.38, bestAsk: 0.45, tick });
    expect(r).toEqual({ ok: true, price: 0.39 });
  });
  it('SELL with no bid on the book is non-crossing at the snapped target', () => {
    const r = makerLimitPrice({ side: 'SELL', targetPrice: 0.401, bestBid: null, bestAsk: 0.45, tick });
    expect(r).toEqual({ ok: true, price: 0.41 });
  });
  it('SELL cannot rest above a 0.99 bid → not makeable', () => {
    expect(makerLimitPrice({ side: 'SELL', targetPrice: 0.9, bestBid: 0.99, bestAsk: null, tick })).toEqual({ ok: false, reason: 'crosses_bid' });
  });
  it('zero/negative tick is rejected', () => {
    expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.3, bestBid: null, bestAsk: null, tick: 0 })).toEqual({ ok: false, reason: 'no_tick' });
  });
  it('respects a coarser 0.05 tick grid', () => {
    expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.28, bestBid: 0.1, bestAsk: 0.35, tick: 0.05 })).toEqual({ ok: true, price: 0.25 });
    expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.35, bestBid: 0.1, bestAsk: 0.35, tick: 0.05 })).toEqual({ ok: true, price: 0.3 });
  });
});

describe('takerLimitPrice — snaps toward the side that fills', () => {
  it('BUY rounds up, SELL rounds down', () => {
    expect(takerLimitPrice('BUY', 0.312, 0.01)).toBe(0.32);
    expect(takerLimitPrice('SELL', 0.318, 0.01)).toBe(0.31);
  });
});

describe('parseOrderBookTop — best-first, empty side null', () => {
  it('extracts best bid/ask (normalizeBook reverses raw ascending bids / descending asks)', () => {
    const raw = { bids: [{ price: '0.36', size: '10' }, { price: '0.38', size: '5' }], asks: [{ price: '0.42', size: '7' }, { price: '0.4', size: '9' }], tick_size: '0.01', min_order_size: '5' };
    expect(parseOrderBookTop(raw)).toEqual({ bestBid: 0.38, bestAsk: 0.4, tickSize: 0.01, minOrderSize: 5 });
  });
  it('an empty ask side yields bestAsk null', () => {
    const raw = { bids: [{ price: '0.3', size: '10' }], asks: [], tick_size: '0.01', min_order_size: '0' };
    expect(parseOrderBookTop(raw)).toMatchObject({ bestBid: 0.3, bestAsk: null });
  });
});

describe('parseOpenOrders / parseOrderFillPoll — partial-fill accounting', () => {
  it('maps venue open-order fields (array or {orders} or {data})', () => {
    const o = { id: '0x1', status: 'live', side: 'BUY', asset_id: 'tokA', original_size: '74', size_matched: '20', price: '0.27', order_type: 'GTC' };
    expect(parseOpenOrders([o])[0]).toEqual({ orderId: '0x1', status: 'live', side: 'BUY', tokenId: 'tokA', originalSize: 74, sizeMatched: 20, price: 0.27, orderType: 'GTC' });
    expect(parseOpenOrders({ orders: [o] })).toHaveLength(1);
    expect(parseOpenOrders({ data: [o] })).toHaveLength(1);
    expect(parseOpenOrders(null)).toEqual([]);
  });
  it('classifies filled / partial / resting from cumulative size_matched', () => {
    expect(parseOrderFillPoll({ status: 'matched', original_size: '74', size_matched: '74', price: '0.27' }, '0x1')).toMatchObject({ filled: true, partial: false, resting: false, sizeMatched: 74 });
    expect(parseOrderFillPoll({ status: 'live', original_size: '74', size_matched: '20' }, '0x1')).toMatchObject({ filled: false, partial: true, resting: false, sizeMatched: 20 });
    expect(parseOrderFillPoll({ status: 'live', original_size: '74', size_matched: '0' }, '0x1')).toMatchObject({ filled: false, partial: false, resting: true });
  });
  it('falls back to requestedSize when the venue omits original_size', () => {
    expect(parseOrderFillPoll({ status: 'matched', size_matched: '50' }, '0x1', 50)).toMatchObject({ filled: true, originalSize: 50 });
  });
  it('reads a nested {order:{…}} envelope', () => {
    expect(parseOrderFillPoll({ order: { status: 'matched', original_size: '10', size_matched: '10', price: '0.5' } }, '0x1')).toMatchObject({ filled: true, avgPrice: 0.5 });
  });
});

describe('parseCancelResult', () => {
  it('allCanceled only when every requested id canceled and nothing not_canceled', () => {
    expect(parseCancelResult({ canceled: ['0x1'], not_canceled: {} }, ['0x1'])).toMatchObject({ allCanceled: true });
    expect(parseCancelResult({ canceled: [], not_canceled: { '0x1': 'order is filled' } }, ['0x1'])).toMatchObject({ allCanceled: false, notCanceled: { '0x1': 'order is filled' } });
  });
});

describe('redactOrderPayload — never surfaces signing material', () => {
  it('redacts signature/secret/apiKey fields and secret-shaped strings, keeps benign fields', () => {
    const out = redactOrderPayload({
      tokenID: 'tokA',
      price: 0.27,
      size: 74,
      side: 'BUY',
      salt: '0xdeadbeef',
      signature: '0xabc123signaturematerial',
      apiKey: 'sk-ant-should-be-hidden-abcdefghijklmnop',
      nested: { passphrase: 'hunter2', ok: 'plain', leaked: 'AKIAIOSFODNN7EXAMPLE1' },
    }) as Record<string, unknown>;
    expect(out['tokenID']).toBe('tokA');
    expect(out['price']).toBe(0.27);
    expect(out['salt']).toBe('0xdeadbeef');
    expect(out['signature']).toBe('…REDACTED');
    expect(out['apiKey']).toBe('…REDACTED');
    const nested = out['nested'] as Record<string, unknown>;
    expect(nested['passphrase']).toBe('…REDACTED');
    expect(nested['ok']).toBe('plain');
    expect(nested['leaked']).toBe('…REDACTED');
  });
});
