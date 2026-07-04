/**
 * order-intent — pure helpers for the MAKER-EXIT live rail (T1). No clob client, no key, no I/O:
 * trade-mode resolution, the idempotency key, maker-price enforcement (maker-ness guaranteed BY PRICE,
 * not by trusting a flag), venue-shape parsers, and payload redaction. Unit-tested in isolation.
 *
 * The maker-price rule (deliverable #1): a resting BUY must sit STRICTLY BELOW the best ask and a
 * resting SELL STRICTLY ABOVE the best bid, snapped to the tick grid — so the order can never cross
 * and pay taker fees, independent of any SDK `post_only` flag. (`post_only` is verified native and IS
 * passed as defense-in-depth — research/REPORT-clob-bracket-execution.md §9.2 — but price is the guarantee.)
 */
import { normalizeBook, type RawClobBook } from '@weather-edge/core';
import type {
  CancelResult,
  OpenOrder,
  OrderBookTop,
  OrderFillPoll,
  OrderPurpose,
  OrderSide,
  TradeMode,
} from './types.ts';

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * Resolve the execution posture from `TRADE_MODE`. Trim + lowercase; only the exact strings `live`
 * and `off` select those modes — EVERYTHING else (unset, empty, typo, garbage) resolves to `dry-run`.
 * A live post is therefore impossible without the operator explicitly setting `TRADE_MODE=live`.
 */
export function resolveTradeMode(getEnvVar: (name: string) => string | undefined): TradeMode {
  const raw = (getEnvVar('TRADE_MODE') ?? '').trim().toLowerCase();
  if (raw === 'live') return 'live';
  if (raw === 'off') return 'off';
  return 'dry-run';
}

/**
 * The client-side idempotency key: `market | side | purpose | date`. Two attempts at the SAME intent
 * (a retry, a crash-restart, a duplicate tick) collapse to one key; the ledger's partial-unique index
 * on this key blocks a second live order. Deliberately coarse — one entry / one take-profit / one
 * stop / one time-stop per market per local trade-day.
 */
export function orderIntentKey(r: {
  marketId: string;
  side: OrderSide;
  purpose: OrderPurpose;
  tradeDate: string;
}): string {
  return `${r.marketId}|${r.side}|${r.purpose}|${r.tradeDate}`;
}

const gridDown = (x: number, tick: number): number => round6(Math.floor(round6(x / tick) + 1e-9) * tick);
const gridUp = (x: number, tick: number): number => round6(Math.ceil(round6(x / tick) - 1e-9) * tick);

export type MakerPriceResult = { ok: true; price: number } | { ok: false; reason: string };

/**
 * Compute the resting maker limit that is guaranteed not to cross:
 *   - BUY  → snap `targetPrice` DOWN to the grid, then cap at `bestAsk − tick` (one tick under the ask).
 *   - SELL → snap `targetPrice` UP to the grid, then floor at `bestBid + tick` (one tick over the bid).
 * The opposite side is only enforced when it EXISTS (a flat/empty book side can't be crossed). Prices
 * are clamped to the tradeable grid `[tick, 1 − tick]`; if no non-crossing price fits, `{ ok:false }`.
 */
export function makerLimitPrice(args: {
  side: OrderSide;
  targetPrice: number;
  bestBid: number | null;
  bestAsk: number | null;
  tick: number;
}): MakerPriceResult {
  const { side, targetPrice, bestBid, bestAsk, tick } = args;
  if (!(tick > 0)) return { ok: false, reason: 'no_tick' };
  const lo = round6(tick);
  const hi = round6(1 - tick);

  if (side === 'BUY') {
    let price = gridDown(targetPrice, tick);
    if (bestAsk != null) price = Math.min(price, round6(bestAsk - tick));
    price = round6(Math.min(Math.max(price, lo), hi));
    if (price < lo || (bestAsk != null && !(price < bestAsk))) {
      return { ok: false, reason: 'crosses_ask' };
    }
    return { ok: true, price };
  }

  // SELL
  let price = gridUp(targetPrice, tick);
  if (bestBid != null) price = Math.max(price, round6(bestBid + tick));
  price = round6(Math.min(Math.max(price, lo), hi));
  if (price > hi || (bestBid != null && !(price > bestBid))) {
    return { ok: false, reason: 'crosses_bid' };
  }
  return { ok: true, price };
}

/** Snap a TAKER worst-price limit to the grid in the direction that still fills: BUY up, SELL down. */
export function takerLimitPrice(side: OrderSide, worstPrice: number, tick: number): number {
  if (!(tick > 0)) return round6(worstPrice);
  return side === 'BUY' ? gridUp(worstPrice, tick) : gridDown(worstPrice, tick);
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parse a raw `getOrderBook` response into top-of-book. `normalizeBook` reorders best-first, so
 * `asks[0]`/`bids[0]` are the best quotes; an empty side yields `null` (nothing to cross).
 */
export function parseOrderBookTop(raw: unknown): OrderBookTop {
  const book = normalizeBook(raw as RawClobBook);
  const bestBid = book.bids.length ? book.bids[0]!.price : null;
  const bestAsk = book.asks.length ? book.asks[0]!.price : null;
  return { bestBid, bestAsk, tickSize: book.tickSize, minOrderSize: book.minOrderSize };
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

const mapOpenOrder = (v: unknown): OpenOrder => {
  const o = asRecord(v);
  return {
    orderId: String(o['id'] ?? o['orderID'] ?? o['order_id'] ?? ''),
    status: String(o['status'] ?? ''),
    side: String(o['side'] ?? ''),
    tokenId: String(o['asset_id'] ?? o['tokenID'] ?? o['token_id'] ?? ''),
    originalSize: num(o['original_size'] ?? o['originalSize'] ?? o['size']),
    sizeMatched: num(o['size_matched'] ?? o['sizeMatched']),
    price: num(o['price']),
    orderType: String(o['order_type'] ?? o['orderType'] ?? ''),
  };
};

/** Parse a raw `getOpenOrders` response (array, or `{orders:[…]}`, or `{data:[…]}`) into OpenOrder[]. */
export function parseOpenOrders(raw: unknown): OpenOrder[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(asRecord(raw)['orders'])
      ? (asRecord(raw)['orders'] as unknown[])
      : Array.isArray(asRecord(raw)['data'])
        ? (asRecord(raw)['data'] as unknown[])
        : [];
  return arr.map(mapOpenOrder);
}

/**
 * Parse a raw `getOrder` response into a partial-fill-aware poll. Terminal-fill is `size_matched >=
 * original_size` (with `original_size` falling back to a caller-known requested size when the venue
 * omits it); anything in `(0, original)` is a partial; `0` with an open status is resting.
 */
export function parseOrderFillPoll(raw: unknown, orderId: string, requestedSize = 0): OrderFillPoll {
  const o = asRecord(raw);
  const nested = asRecord(o['order']); // some SDK shapes nest under `order`
  const pick = (k: string): unknown => o[k] ?? nested[k];
  const status = String(pick('status') ?? '');
  const originalSize = num(pick('original_size') ?? pick('originalSize')) || requestedSize;
  const sizeMatched = num(pick('size_matched') ?? pick('sizeMatched'));
  const rawPrice = pick('price');
  const avgPrice = rawPrice == null ? null : num(rawPrice);
  // Fully filled when cumulative match reaches the original size; if the venue omits the size but
  // reports a terminal 'matched' status, treat that as filled. Partial is any match strictly between.
  const filled =
    originalSize > 0 ? sizeMatched >= originalSize : status.toLowerCase() === 'matched';
  const partial = sizeMatched > 0 && originalSize > 0 && sizeMatched < originalSize;
  return {
    orderId,
    status,
    originalSize,
    sizeMatched,
    avgPrice,
    filled,
    partial,
    resting: !filled && !partial,
  };
}

/** Parse a raw cancel response (`{canceled:[…], not_canceled:{…}}`) against the ids we requested. */
export function parseCancelResult(raw: unknown, requested: string[]): CancelResult {
  const o = asRecord(raw);
  const canceledRaw = o['canceled'] ?? o['cancelled'];
  const canceled = Array.isArray(canceledRaw) ? canceledRaw.map(String) : [];
  const ncRaw = o['not_canceled'] ?? o['notCanceled'] ?? o['not_cancelled'];
  const notCanceled: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(ncRaw))) notCanceled[k] = String(v);
  const canceledSet = new Set(canceled);
  const allCanceled = requested.length > 0 && requested.every((id) => canceledSet.has(id)) && Object.keys(notCanceled).length === 0;
  return { requested, canceled, notCanceled, allCanceled };
}

const SECRET_KEY_RE = /signature|secret|passphrase|private[-_]?key|api[-_]?key|mnemonic|seed/i;
const SECRET_SHAPE_RE = /\b(sk-[a-z-]*[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Redact an order payload for logging (dry-run + audit). The wallet key is NEVER in a signed order —
 * this is defense-in-depth per the secret-handling rule: any field whose NAME looks like signing
 * material (`signature`/`secret`/`passphrase`/`privateKey`/`apiKey`/…) or whose value matches a known
 * secret SHAPE is replaced with `…REDACTED`. Benign fields (tokenId, price, size, salt, side) survive.
 */
export function redactOrderPayload(payload: unknown): unknown {
  const redact = (v: unknown, keyName?: string): unknown => {
    if (keyName && SECRET_KEY_RE.test(keyName)) return '…REDACTED';
    if (typeof v === 'string') return SECRET_SHAPE_RE.test(v) ? '…REDACTED' : v;
    if (Array.isArray(v)) return v.map((x) => redact(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redact(val, k);
      return out;
    }
    return v;
  };
  return redact(payload);
}
