/**
 * order-intent pure helpers (T1 MAKER-EXIT rail): trade-mode resolution (never defaults live), the
 * idempotency key, maker-price enforcement at the TICK BOUNDARY (BUY strictly below ask / SELL strictly
 * above bid — incl. the 0.001 tick weather tails trade at), FAIL-LOUD venue-shape parsers (MEDIUM-3:
 * malformed never coerces to resting/[]), the reconcile heuristic match, and secret-safe redaction of
 * payloads AND free-text error strings (MEDIUM-4).
 */
import { describe, expect, it } from 'vitest';
import { ClobShapeError } from '@weather-edge/core';
import {
  CLOB_TRADES_PAGE_LIMIT,
  makerLimitPrice,
  matchDanglingIntent,
  orderIntentKey,
  parseCancelResult,
  parseOpenOrders,
  parseOrderBookTop,
  parseOrderFillPoll,
  parseTrades,
  redactOrderPayload,
  redactText,
  resolveTradeMode,
  sumOurSellSize,
  takerLimitPrice,
  tradeCouldBeOurFill,
  tradesResponseTruncated,
  type OpenOrder,
  type VenueTrade,
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
    expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.275, bestBid: 0.2, bestAsk: 0.3, tick })).toEqual({ ok: true, price: 0.27 });
  });
  it('BUY at exactly the ask steps one tick inside (never rests AT the ask)', () => {
    expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.3, bestBid: 0.2, bestAsk: 0.3, tick })).toEqual({ ok: true, price: 0.29 });
  });
  it('BUY above the ask is capped to one tick below the ask (never crosses)', () => {
    expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.5, bestBid: 0.2, bestAsk: 0.3, tick })).toEqual({ ok: true, price: 0.29 });
  });
  it('BUY with no ask on the book is non-crossing at the snapped target', () => {
    expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.275, bestBid: 0.2, bestAsk: null, tick })).toEqual({ ok: true, price: 0.27 });
  });
  it('BUY cannot rest below a 1-tick ask → not makeable', () => {
    expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.05, bestBid: null, bestAsk: 0.01, tick })).toEqual({ ok: false, reason: 'crosses_ask' });
  });

  it('SELL snaps up to the grid, strictly above best bid', () => {
    expect(makerLimitPrice({ side: 'SELL', targetPrice: 0.401, bestBid: 0.38, bestAsk: 0.45, tick })).toEqual({ ok: true, price: 0.41 });
  });
  it('SELL at exactly the bid steps one tick inside (never rests AT the bid)', () => {
    expect(makerLimitPrice({ side: 'SELL', targetPrice: 0.38, bestBid: 0.38, bestAsk: 0.45, tick })).toEqual({ ok: true, price: 0.39 });
  });
  it('SELL below the bid is lifted to one tick above the bid (never crosses)', () => {
    expect(makerLimitPrice({ side: 'SELL', targetPrice: 0.1, bestBid: 0.38, bestAsk: 0.45, tick })).toEqual({ ok: true, price: 0.39 });
  });
  it('SELL with no bid on the book is non-crossing at the snapped target', () => {
    expect(makerLimitPrice({ side: 'SELL', targetPrice: 0.401, bestBid: null, bestAsk: 0.45, tick })).toEqual({ ok: true, price: 0.41 });
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

  describe('LOW-8: the 0.001 tick grid (weather tails trade there)', () => {
    const t3 = 0.001;
    it('BUY floats snap cleanly to the fine grid (0.2755 → 0.275, no fp drift)', () => {
      expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.2755, bestBid: 0.1, bestAsk: 0.5, tick: t3 })).toEqual({ ok: true, price: 0.275 });
    });
    it('SELL floats snap UP on the fine grid (0.2751 → 0.276)', () => {
      expect(makerLimitPrice({ side: 'SELL', targetPrice: 0.2751, bestBid: 0.1, bestAsk: 0.5, tick: t3 })).toEqual({ ok: true, price: 0.276 });
    });
    it('BUY against an ask one tick above the floor can rest AT the floor (0.001 < 0.002)', () => {
      expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.05, bestBid: null, bestAsk: 0.002, tick: t3 })).toEqual({ ok: true, price: 0.001 });
    });
    it('BUY against an ask AT the floor cannot rest → not makeable', () => {
      expect(makerLimitPrice({ side: 'BUY', targetPrice: 0.05, bestBid: null, bestAsk: 0.001, tick: t3 })).toEqual({ ok: false, reason: 'crosses_ask' });
    });
    it('SELL against a bid one tick below the cap can rest AT the cap (0.999 > 0.998)', () => {
      expect(makerLimitPrice({ side: 'SELL', targetPrice: 0.5, bestBid: 0.998, bestAsk: null, tick: t3 })).toEqual({ ok: true, price: 0.999 });
    });
    it('SELL against a bid AT the cap cannot rest → not makeable', () => {
      expect(makerLimitPrice({ side: 'SELL', targetPrice: 0.5, bestBid: 0.999, bestAsk: null, tick: t3 })).toEqual({ ok: false, reason: 'crosses_bid' });
    });
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
  it('an empty ask side yields bestAsk null; a missing side fails loud (core normalizeBook)', () => {
    const raw = { bids: [{ price: '0.3', size: '10' }], asks: [], tick_size: '0.01', min_order_size: '0' };
    expect(parseOrderBookTop(raw)).toMatchObject({ bestBid: 0.3, bestAsk: null });
    expect(() => parseOrderBookTop({})).toThrow(ClobShapeError);
  });
});

describe('parseOpenOrders / parseOrderFillPoll — partial-fill accounting, FAIL-LOUD (MEDIUM-3)', () => {
  it('maps venue open-order fields (array or {orders} or {data})', () => {
    const o = { id: '0x1', status: 'live', side: 'BUY', asset_id: 'tokA', original_size: '74', size_matched: '20', price: '0.27', order_type: 'GTC' };
    expect(parseOpenOrders([o])[0]).toEqual({ orderId: '0x1', status: 'live', side: 'BUY', tokenId: 'tokA', originalSize: 74, sizeMatched: 20, price: 0.27, orderType: 'GTC' });
    expect(parseOpenOrders({ orders: [o] })).toHaveLength(1);
    expect(parseOpenOrders({ data: [o] })).toHaveLength(1);
    expect(parseOpenOrders([])).toEqual([]);
  });
  it('unrecognized open-orders shapes RAISE — never coerce to [] (null, string, unknown object, id-less element, junk numerics)', () => {
    expect(() => parseOpenOrders(null)).toThrow(ClobShapeError);
    expect(() => parseOpenOrders('not a list')).toThrow(ClobShapeError);
    expect(() => parseOpenOrders({ foo: [] })).toThrow(ClobShapeError);
    expect(() => parseOpenOrders([{ status: 'live' }])).toThrow(ClobShapeError); // no order id
    expect(() => parseOpenOrders([{ id: '0x1', price: 'NaNsense' }])).toThrow(ClobShapeError);
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
  it('malformed getOrder responses RAISE — never coerce to resting (status missing/garbage, non-numeric sizes)', () => {
    expect(() => parseOrderFillPoll(null, '0x1')).toThrow(ClobShapeError);
    expect(() => parseOrderFillPoll({}, '0x1')).toThrow(ClobShapeError);
    expect(() => parseOrderFillPoll({ foo: 'bar' }, '0x1')).toThrow(ClobShapeError);
    expect(() => parseOrderFillPoll({ status: 42 }, '0x1')).toThrow(ClobShapeError);
    expect(() => parseOrderFillPoll({ status: 'live', size_matched: 'lots' }, '0x1')).toThrow(ClobShapeError);
  });
});

describe('parseTrades — FAIL-LOUD, TAKER-CENTRIC (the reconcile evidence + sell-truth read)', () => {
  const leg = { order_id: '0xM1', side: 'SELL', price: '0.18', matched_amount: '30', maker_address: '0xUS', asset_id: 'tokA' };
  const t = { price: '0.18', side: 'BUY', size: '74', asset_id: 'tokA', status: 'CONFIRMED', trader_side: 'TAKER', taker_order_id: '0xT1', maker_orders: [leg] };

  it('parses array / {trades} / {data} shapes, carrying trader_side + per-leg maker fills', () => {
    expect(parseTrades([t])[0]).toEqual({
      side: 'BUY',
      price: 0.18,
      size: 74,
      tokenId: 'tokA',
      status: 'CONFIRMED',
      traderSide: 'TAKER',
      takerOrderId: '0xT1',
      makerOrders: [{ orderId: '0xM1', side: 'SELL', price: 0.18, size: 30, makerAddress: '0xUS', tokenId: 'tokA' }],
    });
    expect(parseTrades({ trades: [t] })).toHaveLength(1);
    expect(parseTrades({ data: [] })).toEqual([]);
    expect(parseTrades([{ ...t, trader_side: 'maker' }])[0]!.traderSide).toBe('MAKER'); // case-normalized
    expect(parseTrades([{ ...t, maker_orders: undefined }])[0]!.makerOrders).toEqual([]);
  });
  it('unrecognized shapes / elements missing price+side RAISE — never coerce to "no trades"', () => {
    expect(() => parseTrades(null)).toThrow(ClobShapeError);
    expect(() => parseTrades('nope')).toThrow(ClobShapeError);
    expect(() => parseTrades({ foo: [] })).toThrow(ClobShapeError);
    expect(() => parseTrades([{ size: '5' }])).toThrow(ClobShapeError);
  });
  it('a missing/unrecognized trader_side RAISES — coercing the perspective would invert our side attribution (a filled maker BUY arrives as side=SELL)', () => {
    expect(() => parseTrades([{ price: '0.18', side: 'BUY', size: '74', asset_id: 'tokA', status: 'CONFIRMED' }])).toThrow(ClobShapeError);
    expect(() => parseTrades([{ ...t, trader_side: 'BOTH' }])).toThrow(ClobShapeError);
  });
  it('a maker leg missing side/price/matched_amount RAISES — it could hide OUR fill', () => {
    expect(() => parseTrades([{ ...t, maker_orders: [{ order_id: '0xM1', price: '0.18', matched_amount: '30' }] }])).toThrow(ClobShapeError);
    expect(() => parseTrades([{ ...t, maker_orders: [{ ...leg, matched_amount: undefined, size: undefined }] }])).toThrow(ClobShapeError);
    expect(() => parseTrades([{ ...t, maker_orders: [{ ...leg, price: 'lots' }] }])).toThrow(ClobShapeError);
  });
});

describe('sumOurSellSize — perspective-aware sell truth (the venue trade record is TAKER-centric)', () => {
  const vt = (over: Partial<VenueTrade> = {}): VenueTrade => ({
    side: 'BUY',
    price: 0.3,
    size: 20,
    tokenId: 'tokA',
    status: 'CONFIRMED',
    traderSide: 'TAKER',
    takerOrderId: '0xT',
    makerOrders: [],
    ...over,
  });
  const legOf = (over: Partial<VenueTrade['makerOrders'][number]> = {}) => ({
    orderId: '0xM1',
    side: 'SELL',
    price: 0.3,
    size: 12,
    makerAddress: '0xUS',
    tokenId: 'tokA',
    ...over,
  });
  const opts = { tokenId: 'tokA', ourAddress: '0xUS' };

  it('FALSIFIER (the CRITICAL side-inversion): our filled maker BUY entry — top-level side=SELL (the taker sold into our bid) — counts ZERO toward sold', () => {
    const entryFill = vt({ side: 'SELL', size: 20, traderSide: 'MAKER', makerOrders: [legOf({ side: 'BUY', size: 20 })] });
    expect(sumOurSellSize([entryFill], opts)).toEqual({ sold: 0, unattributed: false });
  });

  it('FALSIFIER: our maker TP SELL lifted by a taker BUY — top-level side=BUY — DOES count, at the LEG size (matched_amount), not the taker total', () => {
    const tpFill = vt({ side: 'BUY', size: 50, traderSide: 'MAKER', makerOrders: [legOf({ side: 'SELL', size: 12 })] });
    expect(sumOurSellSize([tpFill], opts)).toEqual({ sold: 12, unattributed: false });
  });

  it('taker-perspective trades keep the top-level semantics: our FAK SELL counts its size, our taker BUY does not', () => {
    expect(sumOurSellSize([vt({ side: 'SELL', size: 26 })], opts)).toEqual({ sold: 26, unattributed: false });
    expect(sumOurSellSize([vt({ side: 'BUY', size: 26 })], opts)).toEqual({ sold: 0, unattributed: false });
  });

  it("a SIBLING maker's SELL leg (different maker_address) in the same taker order is NOT counted as ours", () => {
    const mixed = vt({
      side: 'BUY',
      traderSide: 'MAKER',
      makerOrders: [legOf({ side: 'SELL', size: 12 }), legOf({ orderId: '0xTHEIRS', makerAddress: '0xTHEM', side: 'SELL', size: 40 })],
    });
    expect(sumOurSellSize([mixed], opts)).toEqual({ sold: 12, unattributed: false });
  });

  it('secondary attribution by known order id when no address is available', () => {
    const tpFill = vt({ side: 'BUY', traderSide: 'MAKER', makerOrders: [legOf({ makerAddress: '' })] });
    expect(sumOurSellSize([tpFill], { tokenId: 'tokA', ourAddress: null, knownOrderIds: new Set(['0xM1']) })).toEqual({ sold: 12, unattributed: false });
  });

  it('an UNATTRIBUTABLE SELL leg (no address match possible, unknown id) flags unattributed — the caller must degrade, never guess', () => {
    const tpFill = vt({ side: 'BUY', traderSide: 'MAKER', makerOrders: [legOf({ makerAddress: '' })] });
    expect(sumOurSellSize([tpFill], { tokenId: 'tokA', ourAddress: null })).toEqual({ sold: 0, unattributed: true });
    const legless = vt({ side: 'BUY', traderSide: 'MAKER', makerOrders: [] });
    expect(sumOurSellSize([legless], opts)).toEqual({ sold: 0, unattributed: true });
  });

  it('address matching is case-insensitive; FAILED trades and other-token legs are excluded', () => {
    const tpFill = vt({ side: 'BUY', traderSide: 'MAKER', makerOrders: [legOf({ makerAddress: '0xus' })] });
    expect(sumOurSellSize([tpFill], { tokenId: 'tokA', ourAddress: '0XUS' })).toEqual({ sold: 12, unattributed: false });
    expect(sumOurSellSize([vt({ side: 'SELL', size: 26, status: 'FAILED' })], opts)).toEqual({ sold: 0, unattributed: false });
    const otherTok = vt({ side: 'BUY', traderSide: 'MAKER', makerOrders: [legOf({ tokenId: 'tokB' })] });
    expect(sumOurSellSize([otherTok], opts)).toEqual({ sold: 0, unattributed: false });
  });
});

describe('tradeCouldBeOurFill — perspective-aware reconcile evidence predicate', () => {
  const row = { side: 'BUY', price: 0.18 };
  const base: VenueTrade = { side: 'SELL', price: 0.18, size: 74, tokenId: 'tokA', status: 'CONFIRMED', traderSide: 'MAKER', takerOrderId: '0xT', makerOrders: [] };

  it('FALSIFIER: a filled dangling maker BUY arrives with top-level side=SELL — matched via its maker BUY leg, regardless of the top-level side', () => {
    const t = { ...base, makerOrders: [{ orderId: '0xM', side: 'BUY', price: 0.18, size: 74, makerAddress: '0xUS', tokenId: 'tokA' }] };
    expect(tradeCouldBeOurFill(t, row, 0.01)).toBe(true);
  });
  it('taker-perspective trades match on the top-level side/price (within one tick)', () => {
    expect(tradeCouldBeOurFill({ ...base, side: 'BUY', traderSide: 'TAKER' }, row, 0.01)).toBe(true);
    expect(tradeCouldBeOurFill({ ...base, side: 'BUY', price: 0.185, traderSide: 'TAKER' }, row, 0.01)).toBe(true);
    expect(tradeCouldBeOurFill({ ...base, side: 'SELL', traderSide: 'TAKER' }, row, 0.01)).toBe(false);
    expect(tradeCouldBeOurFill({ ...base, side: 'BUY', price: 0.25, traderSide: 'TAKER' }, row, 0.01)).toBe(false);
  });
  it('maker-perspective trades with no side/price-matching leg are not a hit', () => {
    const t = { ...base, makerOrders: [{ orderId: '0xM', side: 'SELL', price: 0.18, size: 74, makerAddress: '0xUS', tokenId: 'tokA' }] };
    expect(tradeCouldBeOurFill(t, row, 0.01)).toBe(false);
    expect(tradeCouldBeOurFill(base, row, 0.01)).toBe(false); // legless — nothing to match
  });
});

describe('tradesResponseTruncated — §11.1 the sell-truth over-sell backstop', () => {
  const t = { price: '0.18', side: 'SELL', size: '5', asset_id: 'tokA', status: 'CONFIRMED' };

  it('a bare array or {…} envelope UNDER the page limit with no cursor is COMPLETE → false', () => {
    expect(tradesResponseTruncated([t, t, t])).toBe(false);
    expect(tradesResponseTruncated([])).toBe(false);
    expect(tradesResponseTruncated({ data: [t] })).toBe(false);
    expect(tradesResponseTruncated({ trades: [] })).toBe(false);
  });

  it('the terminal cursor sentinel ("LTE=") or an empty cursor means COMPLETE → false', () => {
    expect(tradesResponseTruncated({ next_cursor: 'LTE=', data: [t] })).toBe(false);
    expect(tradesResponseTruncated({ next_cursor: '', data: [t] })).toBe(false);
    expect(tradesResponseTruncated({ next_cursor: '   ', data: [t] })).toBe(false);
    expect(tradesResponseTruncated({ nextCursor: 'LTE=', data: [t] })).toBe(false);
  });

  it('a present, non-terminal cursor means MORE PAGES → truncated (true), even with a short page', () => {
    expect(tradesResponseTruncated({ next_cursor: 'MTAw', data: [t] })).toBe(true);
    expect(tradesResponseTruncated({ nextCursor: 'MTAw', trades: [t] })).toBe(true);
    // even a bare array can't carry a cursor, but an envelope with an empty data page + a live cursor does:
    expect(tradesResponseTruncated({ next_cursor: 'abc', data: [] })).toBe(true);
  });

  it('a page AT/ABOVE the page limit is conservatively truncated → true (array or envelope)', () => {
    const full = Array.from({ length: CLOB_TRADES_PAGE_LIMIT }, () => t);
    expect(CLOB_TRADES_PAGE_LIMIT).toBe(100);
    expect(tradesResponseTruncated(full)).toBe(true);
    expect(tradesResponseTruncated([...full, t])).toBe(true); // above the limit
    expect(tradesResponseTruncated({ data: full })).toBe(true);
    expect(tradesResponseTruncated(full.slice(0, CLOB_TRADES_PAGE_LIMIT - 1))).toBe(false); // one under → complete
  });

  it('never throws on an unrecognized shape (a pure boolean detector; parseTrades raises separately)', () => {
    expect(tradesResponseTruncated(null)).toBe(false);
    expect(tradesResponseTruncated('nope')).toBe(false);
    expect(tradesResponseTruncated({ foo: [] })).toBe(false);
  });
});

describe('matchDanglingIntent — heuristic (no client-order-id exists on the CLOB)', () => {
  const mk = (over: Partial<OpenOrder> = {}): OpenOrder => ({
    orderId: '0xV1', status: 'live', side: 'BUY', tokenId: 'tokA', originalSize: 74, sizeMatched: 0, price: 0.18, orderType: 'GTC', ...over,
  });
  const rowLike = { side: 'BUY' as const, price: 0.18, size: 74 };

  it('exactly one side/price/size match → adopt', () => {
    expect(matchDanglingIntent(rowLike, [mk(), mk({ orderId: '0xOTHER', side: 'SELL' })], 0.01)).toEqual({ kind: 'adopt', orderId: '0xV1' });
  });
  it('price within one tick still matches; beyond one tick does not', () => {
    expect(matchDanglingIntent(rowLike, [mk({ price: 0.19 })], 0.01)).toEqual({ kind: 'adopt', orderId: '0xV1' });
    expect(matchDanglingIntent(rowLike, [mk({ price: 0.21 })], 0.01)).toEqual({ kind: 'none' });
  });
  it('size mismatch → none; two candidates → ambiguous (never auto-adopt)', () => {
    expect(matchDanglingIntent(rowLike, [mk({ originalSize: 50 })], 0.01)).toEqual({ kind: 'none' });
    expect(matchDanglingIntent(rowLike, [mk(), mk({ orderId: '0xV2' })], 0.01)).toEqual({ kind: 'ambiguous', candidateIds: ['0xV1', '0xV2'] });
  });
});

describe('parseCancelResult', () => {
  it('allCanceled only when every requested id canceled and nothing not_canceled', () => {
    expect(parseCancelResult({ canceled: ['0x1'], not_canceled: {} }, ['0x1'])).toMatchObject({ allCanceled: true });
    expect(parseCancelResult({ canceled: [], not_canceled: { '0x1': 'order is filled' } }, ['0x1'])).toMatchObject({ allCanceled: false, notCanceled: { '0x1': 'order is filled' } });
  });
});

describe('redaction — never surfaces signing/auth material (MEDIUM-4)', () => {
  it('redactOrderPayload: signature/secret/apiKey fields and secret-shaped strings redacted, benign fields survive', () => {
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

  it('redactText: L2 auth headers, kv secrets, signature hex blobs, and secret shapes are stripped; prose survives', () => {
    const sigBlob = '0x' + 'ab'.repeat(65);
    const dirty = `403 forbidden POLY_SIGNATURE: ${sigBlob} POLY_PASSPHRASE: sup3rSecretPass99 signature=0xdeadbeefcafe12 order 0xORDER1 price 0.27 sk-ant-api03-abcdefghijklmnopqrstuv`;
    const clean = redactText(dirty);
    expect(clean).not.toContain(sigBlob);
    expect(clean).not.toContain('sup3rSecretPass99');
    expect(clean).not.toContain('0xdeadbeefcafe12');
    expect(clean).not.toContain('sk-ant-api03');
    expect(clean).toContain('REDACTED');
    // benign context survives for debuggability
    expect(clean).toContain('403 forbidden');
    expect(clean).toContain('order 0xORDER1');
    expect(clean).toContain('price 0.27');
  });

  it('LOW-C: space-separated label forms and 64-hex blobs are stripped', () => {
    const key32 = '0x' + 'cd'.repeat(32); // 64 hex chars — a 32-byte private-key/hash shape
    const dirty = `boot failed: api key: abcdef123456 then private key: ${key32} at step 3`;
    const clean = redactText(dirty);
    expect(clean).not.toContain('abcdef123456');
    expect(clean).not.toContain(key32);
    expect(clean).toContain('REDACTED');
    expect(clean).toContain('boot failed');
    expect(clean).toContain('at step 3');
    // below the 64-hex floor an address-length hex survives (it is not key material)
    const addr = '0x' + 'ef'.repeat(20); // 40 hex chars — an address
    expect(redactText(`funder ${addr}`)).toContain(addr);
  });

  it('C74: a synthetic clob-client error dump carrying the L2 creds/signature comes out fully redacted', () => {
    // the exact object @polymarket/clob-client's http-helper console.errors on a venue 400 — request
    // config.headers (the L2 auth trio) INCLUDED — plus a logged creds object with the base64 secret.
    const apiKey = '3f2a1b7c-9d4e-4a6b-8c1d-2e3f4a5b6c7d'; // uuid apiKey
    const passphrase = 'a1b2c3d4-e5f6-4788-9a0b-1c2d3e4f5a6b'; // uuid passphrase
    const secret = 'Zm9vYmFyc2VjcmV0YmFzZTY0dmFsdWVwYWQ='; // base64 secret (ends '=')
    const signature = 'q7r8s9t0u1v2_w3x4-y5z6A7B8C9D0E1F2G3H4I5J6K7L8M9N0='; // base64url L2 signature (ends '=')
    const dump = JSON.stringify({
      status: 400,
      data: { error: 'invalid order version', status: 400 },
      config: { url: 'https://clob.polymarket.com/order', headers: { POLY_API_KEY: apiKey, POLY_PASSPHRASE: passphrase, POLY_SIGNATURE: signature } },
      creds: { key: apiKey, secret, passphrase },
    });
    const clean = redactText(dump);
    for (const s of [apiKey, passphrase, secret, signature]) expect(clean).not.toContain(s);
    expect(clean).toContain('REDACTED');
    // the diagnostic the operator actually needs still survives
    expect(clean).toContain('invalid order version');
    // benign ids/prices/addresses are NOT collateral damage of the new shape matchers
    const addr = '0x' + 'ab'.repeat(20); // 40-hex address
    const tokenId = '7'.repeat(72); // decimal tokenId
    const survived = redactText(`funder ${addr} token ${tokenId} price 0.27`);
    expect(survived).toContain(addr);
    expect(survived).toContain(tokenId);
    expect(survived).toContain('price 0.27');
  });
});
