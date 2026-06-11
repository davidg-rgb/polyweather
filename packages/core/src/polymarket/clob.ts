/**
 * core/polymarket/clob — CLOB book normalization (ARCHITECTURE.md §6.9). Pure.
 */
import { ClobShapeError } from '../errors.ts';
import type { NormalizedBook } from '../types.ts';

export interface RawClobBook {
  market?: string;
  asset_id?: string;
  timestamp?: string;
  hash?: string;
  bids?: { price: string; size: string }[];
  asks?: { price: string; size: string }[];
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
  last_trade_price?: string;
}

/**
 * Parse string numbers and REORDER to best-first. Live-verified quirk: raw
 * bids ascend and raw asks descend — the best quote is the LAST element of
 * each raw array. tick_size, min_order_size, and hash carried.
 * ClobShapeError on missing arrays.
 */
export function normalizeBook(raw: RawClobBook): NormalizedBook {
  if (!Array.isArray(raw.bids) || !Array.isArray(raw.asks)) {
    throw new ClobShapeError('book is missing bids/asks arrays', {
      market: raw.market,
      hasBids: Array.isArray(raw.bids),
      hasAsks: Array.isArray(raw.asks),
    });
  }
  const level = (l: { price: string; size: string }) => {
    const price = Number(l.price);
    const size = Number(l.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) {
      throw new ClobShapeError(`non-numeric book level: ${JSON.stringify(l)}`);
    }
    return { price, size };
  };
  return {
    market: raw.market ?? '',
    assetId: raw.asset_id ?? '',
    timestamp: raw.timestamp ? Number(raw.timestamp) : 0,
    hash: raw.hash ?? '',
    bids: raw.bids.map(level).reverse(),
    asks: raw.asks.map(level).reverse(),
    minOrderSize: raw.min_order_size ? Number(raw.min_order_size) : 0,
    tickSize: raw.tick_size ? Number(raw.tick_size) : 0,
    negRisk: raw.neg_risk ?? false,
    lastTradePrice: raw.last_trade_price != null ? Number(raw.last_trade_price) : null,
  };
}

/** One trade/mark price point from GET /prices-history (epoch SECONDS). */
export interface PricePoint {
  t: number;
  p: number;
}

/**
 * Parse `GET /prices-history?market={token}&interval=…` → ascending PricePoint[]
 * (research/clob-prices-history*.json: `{history:[{t: epoch_seconds, p: price}]}`).
 * Consumed by backfill-market-history (§6.22) to reconstruct daily snapshots
 * and pre-cutoff consensus (C2). ClobShapeError on a missing history array or
 * a non-numeric point — an upstream-shape-change alert, never a guess.
 */
export function parsePricesHistory(raw: unknown): PricePoint[] {
  const history = (raw as { history?: unknown } | null)?.history;
  if (!Array.isArray(history)) {
    throw new ClobShapeError('prices-history is missing the history array', {
      shape: raw === null ? 'null' : typeof raw,
    });
  }
  const points = history.map((pt) => {
    const rawT = (pt as { t?: unknown } | null)?.t;
    const rawP = (pt as { p?: unknown } | null)?.p;
    const t = Number(rawT);
    const p = Number(rawP);
    // Number(null) is 0 — null/undefined are shape anomalies, never prices.
    if (rawT == null || rawP == null || !Number.isFinite(t) || !Number.isFinite(p)) {
      throw new ClobShapeError(`non-numeric prices-history point: ${JSON.stringify(pt).slice(0, 80)}`);
    }
    return { t, p };
  });
  return points.sort((a, b) => a.t - b.t);
}
