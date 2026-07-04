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
import { ClobShapeError, normalizeBook, type RawClobBook } from '@weather-edge/core';
import type {
  CancelResult,
  OpenOrder,
  OrderBookTop,
  OrderFillPoll,
  OrderLedgerRow,
  OrderPurpose,
  OrderSide,
  TradeMode,
  VenueTrade,
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
 * (a retry, a crash-restart, a duplicate tick) collapse to one key; the ledger's mode-scoped
 * partial-unique index on this key blocks a second live order. Deliberately coarse — one entry / one
 * take-profit / one stop / one time-stop per market per local trade-day.
 *
 * INVARIANT (T3 round-2): the intent key is the DEDUPE identity; the `client_order_id` is the
 * per-attempt identity and must be GLOBALLY UNIQUE, NEVER reused across retries or reprices — the
 * record_* RPCs are keyed by it alone (no mode), and a reused id would splice two attempts' lifecycles.
 * The executor mints a fresh `crypto.randomUUID()` per placement attempt; a reprice's replacement
 * order gets a NEW id (the old row keeps the old one).
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

/** Strict number: null/undefined pass through as null; anything present but non-numeric FAILS LOUD. */
const strictNum = (v: unknown, field: string, ctx: string): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    throw new ClobShapeError(`${ctx}: non-numeric ${field}: ${JSON.stringify(v).slice(0, 40)}`);
  }
  return n;
};

const mapOpenOrder = (v: unknown): OpenOrder => {
  const o = asRecord(v);
  const orderId = String(o['id'] ?? o['orderID'] ?? o['order_id'] ?? '');
  // MEDIUM-3: an element with no id is an upstream shape change, never a silently-empty order.
  if (!orderId) {
    throw new ClobShapeError(`open-orders element missing an order id: ${JSON.stringify(v).slice(0, 80)}`);
  }
  return {
    orderId,
    status: String(o['status'] ?? ''),
    side: String(o['side'] ?? ''),
    tokenId: String(o['asset_id'] ?? o['tokenID'] ?? o['token_id'] ?? ''),
    originalSize: strictNum(o['original_size'] ?? o['originalSize'] ?? o['size'], 'original_size', 'open-orders') ?? 0,
    sizeMatched: strictNum(o['size_matched'] ?? o['sizeMatched'], 'size_matched', 'open-orders') ?? 0,
    price: strictNum(o['price'], 'price', 'open-orders') ?? 0,
    orderType: String(o['order_type'] ?? o['orderType'] ?? ''),
  };
};

/**
 * Parse a raw `getOpenOrders` response (array, or `{orders:[…]}`, or `{data:[…]}`) into OpenOrder[].
 * FAIL-LOUD (MEDIUM-3, the core ClobShapeError idiom): an unrecognized-but-nonempty shape — null, a
 * string, an object without a known list key — throws; it must NEVER coerce to `[]` (reconcile would
 * read "no open orders" and free a key that has a live order behind it).
 */
export function parseOpenOrders(raw: unknown): OpenOrder[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(asRecord(raw)['orders'])
      ? (asRecord(raw)['orders'] as unknown[])
      : Array.isArray(asRecord(raw)['data'])
        ? (asRecord(raw)['data'] as unknown[])
        : null;
  if (arr === null) {
    throw new ClobShapeError('unrecognized open-orders response shape', {
      shape: raw === null ? 'null' : typeof raw,
    });
  }
  return arr.map(mapOpenOrder);
}

/**
 * Parse a raw `getOrder` response into a partial-fill-aware poll. Terminal-fill is `size_matched >=
 * original_size` (with `original_size` falling back to a caller-known requested size when the venue
 * omits it); anything in `(0, original)` is a partial; `0` with an open status is resting.
 * FAIL-LOUD (MEDIUM-3): a response with no readable `status` string (top-level or nested under
 * `order`) throws ClobShapeError — malformed must NEVER coerce to `filled:false/resting:true`
 * (a fill-poll that silently reports "resting" on garbage would strand a matched order).
 */
export function parseOrderFillPoll(raw: unknown, orderId: string, requestedSize = 0): OrderFillPoll {
  const o = asRecord(raw);
  const nested = asRecord(o['order']); // some SDK shapes nest under `order`
  const pick = (k: string): unknown => o[k] ?? nested[k];
  const statusRaw = pick('status');
  if (typeof statusRaw !== 'string' || statusRaw.length === 0) {
    throw new ClobShapeError(`getOrder(${orderId}): response has no readable status`, {
      shape: raw === null ? 'null' : typeof raw,
      keys: Object.keys(o).slice(0, 10),
    });
  }
  const status = statusRaw;
  const originalSize = strictNum(pick('original_size') ?? pick('originalSize'), 'original_size', `getOrder(${orderId})`) ?? requestedSize;
  const sizeMatched = strictNum(pick('size_matched') ?? pick('sizeMatched'), 'size_matched', `getOrder(${orderId})`) ?? 0;
  const avgPrice = strictNum(pick('price'), 'price', `getOrder(${orderId})`);
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

/**
 * Parse a raw `getTrades` response (array, or `{trades:[…]}`/`{data:[…]}`/`{history:[…]}`) into
 * VenueTrade[]. Same fail-loud idiom as parseOpenOrders: reconcile uses a trades read as the LAST
 * check before freeing an intent key, so a malformed response must abort (throw), never read as
 * "no trades" (which would free a key whose order may have filled).
 */
export function parseTrades(raw: unknown): VenueTrade[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(asRecord(raw)['trades'])
      ? (asRecord(raw)['trades'] as unknown[])
      : Array.isArray(asRecord(raw)['data'])
        ? (asRecord(raw)['data'] as unknown[])
        : Array.isArray(asRecord(raw)['history'])
          ? (asRecord(raw)['history'] as unknown[])
          : null;
  if (arr === null) {
    throw new ClobShapeError('unrecognized trades response shape', {
      shape: raw === null ? 'null' : typeof raw,
    });
  }
  return arr.map((v) => {
    const t = asRecord(v);
    const price = strictNum(t['price'], 'price', 'trades');
    const side = t['side'];
    if (price === null || typeof side !== 'string') {
      throw new ClobShapeError(`trades element missing price/side: ${JSON.stringify(v).slice(0, 80)}`);
    }
    return {
      side,
      price,
      size: strictNum(t['size'], 'size', 'trades') ?? 0,
      tokenId: String(t['asset_id'] ?? t['tokenID'] ?? t['token_id'] ?? ''),
      status: String(t['status'] ?? ''),
    };
  });
}

/** The startup-reconcile heuristic match decision for one dangling intent row. */
export type DanglingMatch =
  | { kind: 'adopt'; orderId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidateIds: string[] };

/**
 * Match a dangling ledger intent (status='intent', no orderId — a crash hit between post and record)
 * against the venue's open orders for its token. HEURISTIC by necessity — the CLOB has NO server-side
 * client-order-id (research report §5 / ADR-OC-5), so identity can only be inferred from what we know
 * we sent: side exact, price within one tick (we posted exactly the reserved price; the tolerance is
 * float safety), original size exact. Exactly ONE candidate → adopt. Zero → none (caller must still
 * check trades before freeing). More than one → ambiguous — NEVER auto-adopt or free on ambiguity.
 */
export function matchDanglingIntent(
  row: Pick<OrderLedgerRow, 'side' | 'price' | 'size'>,
  openOrders: OpenOrder[],
  tick: number,
): DanglingMatch {
  const tol = (tick > 0 ? tick : 0.01) + 1e-9;
  const candidates = openOrders.filter(
    (o) =>
      o.side.toUpperCase() === row.side &&
      Math.abs(o.price - row.price) <= tol &&
      Math.abs(o.originalSize - row.size) <= 1e-6,
  );
  if (candidates.length === 1) return { kind: 'adopt', orderId: candidates[0]!.orderId };
  if (candidates.length === 0) return { kind: 'none' };
  return { kind: 'ambiguous', candidateIds: candidates.map((c) => c.orderId) };
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

// MEDIUM-4 — free-text redaction for error strings that leave the executor (ledger error column,
// Slack alert bodies, thrown ExecutionError messages). A venue/HTTP error can echo request material:
// the L2 auth headers (POLY_API_KEY / POLY_PASSPHRASE / POLY_SIGNATURE), generic `signature=…` /
// `secret: …` key-values, or a raw EIP-712 signature blob (a long hex string).
const HEADER_SECRET_RE = /(POLY[-_](?:API[-_]?KEY|PASSPHRASE|SIGNATURE|SECRET|ADDRESS))["']?\s*[:=]?\s*["']?[A-Za-z0-9+/_.=-]{6,}/gi;
const KV_SECRET_RE = /\b(signature|secret|passphrase|api[-_]?key|private[-_]?key|authorization|bearer)\b["']?\s*[:=]\s*["']?[^\s"',;}]{6,}/gi;
const LONG_HEX_RE = /0x[0-9a-fA-F]{80,}/g;

/**
 * Redact authent-shaped material from a free-text string BEFORE it is persisted, alerted, or thrown.
 * Field-name→value pairs, L2 auth headers, long signature-shaped hex blobs, and known secret shapes
 * are all replaced; ordinary error prose (status codes, order ids, prices) survives.
 */
export function redactText(text: string): string {
  return text
    .replace(HEADER_SECRET_RE, '$1=…REDACTED')
    .replace(KV_SECRET_RE, '$1=…REDACTED')
    .replace(LONG_HEX_RE, '0x…REDACTED')
    .replace(new RegExp(SECRET_SHAPE_RE, 'g'), '…REDACTED');
}
