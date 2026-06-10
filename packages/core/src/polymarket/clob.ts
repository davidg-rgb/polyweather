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
