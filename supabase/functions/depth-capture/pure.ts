/**
 * depth-capture/pure — the PURE, testable executable-depth walk (no network, no Deno, no _shared imports).
 *
 * Split from handler.ts (v2 redesign, DEPTH-CAPTURE-V2-HANDOFF.md) so the two-sided gate + the round-trip
 * exec-price math — the ONE thing this job adds over poll-markets — unit-test in Node/vitest against thin,
 * partial-fill, empty, and one-sided books, decoupled from the CLOB fetch / DB write. Imports only
 * @weather-edge/core (Node-safe, tested).
 */
import { executableAsk, executableBid, type NormalizedBook } from '../../../packages/core/src/index.ts';

/**
 * The computed executable-depth slice for one bucket — flat columns matching `market_depth` (0089) so the
 * record_market_depth jsonb_to_recordset contract is name-for-name obvious (finding I-2). All snake_case.
 */
export interface DepthComputation {
  best_bid: number | null;
  best_ask: number | null;
  mid: number | null;
  spread: number | null;
  /** executable avg ask for the entry size (walked) — the panel's `< askMax` entry gate. */
  exec_ask: number | null;
  /** executable avg BID for the held size (walked) — the panel's absolute TP/SL exit mark. */
  exec_bid: number | null;
  /** buyable $ within +10% of best ask (the true depth, not the vol proxy). */
  depth_usd: number;
  /** sellable $ within −10% of best bid (the symmetric exit-side depth). */
  sellback_depth_usd: number;
  /** $ recoverable selling top-of-book into the bid (best bid × its size). */
  sellback_usd: number;
}

/** A real two-sided quote (§4.5 / opening-capture/handler.ts:242-244): both sides present, not the (0,1) sentinel. */
export function isTwoSided(bestBid: number | null, bestAsk: number | null): boolean {
  if (bestBid == null || bestAsk == null) return false;
  return !(bestBid === 0 && bestAsk === 1);
}

/**
 * Two-sided gate + BOTH sides of the round-trip for `perPositionUsd` of shares: BUY {execAsk, depthUsd(+10%
 * band)} and SELL {execBid, sellbackDepthUsd(−10% band)} + top-of-book. Returns null on a book with no real
 * two-sided quote (§4.5) — an asks-only / one-sided / empty book gets NO market_depth row, so the panel never
 * enters a bucket with no bid (no exit) that the old opening-capture path filtered out (finding E). Mirrors
 * opening-capture's walkBucketDepth exactly, plus the top-of-book the row carries. Pure + total (never throws).
 */
export function computeDepth(book: NormalizedBook, perPositionUsd: number): DepthComputation | null {
  const bestAsk = book.asks[0]?.price ?? null;
  const bestBid = book.bids[0]?.price ?? null;
  // §4.5 two-sided gate — an asks-only book (bestBid null) yields execAsk but no execBid → held-to-resolution
  // with no exit; the old path filtered these out before walking, so mirror it here (no row).
  if (!isTwoSided(bestBid, bestAsk)) return null;

  const mid = (bestBid! + bestAsk!) / 2;
  const spread = bestAsk! - bestBid!;

  // BUY side: executable avg ask for $perPositionUsd of shares + buyable $ within +10% of best ask.
  const band = bestAsk! > 0 ? bestAsk! * 1.1 : Number.POSITIVE_INFINITY;
  const depthUsd = book.asks.filter((l) => l.price <= band).reduce((s, l) => s + l.price * l.size, 0);
  const targetShares = bestAsk! > 0 ? perPositionUsd / bestAsk! : 0;
  const exec = targetShares > 0 ? executableAsk(book, targetShares).avgPrice : NaN;

  // SELL side (the round-trip's other half — a long exits into the BID): realizable avg sell of the SAME share
  // count + sellable $ within −10% of best bid (the symmetric mirror of the +10% ask band).
  const execBidRes = targetShares > 0 ? executableBid(book, targetShares) : { avgPrice: NaN, fillableShares: 0 };
  const bidBand = bestBid! > 0 ? bestBid! * 0.9 : 0;
  const sellbackDepthUsd = book.bids.filter((l) => l.price >= bidBand).reduce((s, l) => s + l.price * l.size, 0);
  const sellbackUsd = bestBid! * (book.bids[0]?.size ?? 0);

  return {
    best_bid: bestBid,
    best_ask: bestAsk,
    mid,
    spread,
    exec_ask: Number.isFinite(exec) ? exec : null,
    exec_bid: Number.isFinite(execBidRes.avgPrice) ? execBidRes.avgPrice : null,
    depth_usd: depthUsd,
    sellback_depth_usd: sellbackDepthUsd,
    sellback_usd: sellbackUsd,
  };
}

/** One assembled `market_depth` write row: the bucket key + the computed depth (consumed by record_market_depth). */
export interface DepthRow extends DepthComputation {
  bucket_id: string;
}

/**
 * The moved-or-heartbeat write gate (§4.2 — mirror poll-markets/handler.ts:234-241). Write a row only when the
 * bucket's exec_ask or exec_bid moved ≥ `deltaThreshold` from its last `market_depth` row, OR the last row is
 * older than `heartbeatMs` (periodic trajectory anchor), OR there is no prior row (first observation). This
 * collapses the v1 unconditional ~230k rows/day (finding C) to a small fraction while keeping the exit
 * trajectory the TP/SL replay needs. Pure + total.
 */
export function shouldWrite(
  row: DepthComputation,
  last: { exec_ask: number | null; exec_bid: number | null; captured_at: string | null },
  nowMs: number,
  deltaThreshold: number,
  heartbeatMs: number,
): boolean {
  if (last.captured_at == null) return true; // first observation of this bucket
  const lastMs = new Date(last.captured_at).getTime();
  const ageMs = Number.isFinite(lastMs) ? nowMs - lastMs : Number.POSITIVE_INFINITY;
  if (ageMs >= heartbeatMs) return true; // heartbeat due (also when the stored timestamp is unparseable)
  const movedAsk =
    row.exec_ask != null && (last.exec_ask == null || Math.abs(row.exec_ask - Number(last.exec_ask)) >= deltaThreshold);
  const movedBid =
    row.exec_bid != null && (last.exec_bid == null || Math.abs(row.exec_bid - Number(last.exec_bid)) >= deltaThreshold);
  return movedAsk || movedBid;
}
