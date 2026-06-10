/**
 * core/edge — edge computation & liquidity filters (ARCHITECTURE.md §6.7).
 */
import { minEdgeRequired, takerFeePerShare } from './fees.ts';
import type { BucketDef, EdgeConfig, EdgeRow, NormalizedBook } from './types.ts';

/**
 * Walk ask levels (best-first) accumulating size; average fill price for the
 * intended stake — EV uses THIS, never top-of-book. fillableShares < sizeShares
 * signals insufficient depth; avgPrice is NaN when nothing is fillable.
 */
export function executableAsk(
  book: NormalizedBook,
  sizeShares: number,
): { avgPrice: number; fillableShares: number } {
  let remaining = sizeShares;
  let cost = 0;
  let filled = 0;
  for (const level of book.asks) {
    if (remaining <= 0) break;
    const take = Math.min(level.size, remaining);
    cost += take * level.price;
    filled += take;
    remaining -= take;
  }
  return { avgPrice: filled > 0 ? cost / filled : NaN, fillableShares: filled };
}

/**
 * Per bucket: q from dist; execAsk via executableAsk at cfg.probeStakeUsd;
 * edge = q − execAsk; fee via takerFeePerShare(execAsk, market feeRate);
 * spread carried onto the row; pass = edge ≥ minEdgeRequired; reasons[]
 * collects every failed criterion — the auditable "why not" persisted hourly
 * to edge_evaluations (F-038). The per-market feeRate (market_buckets.fee_rate)
 * overrides cfg.feeRate for both the fee and the minimum-edge threshold.
 */
export function computeBucketEdges(
  dist: number[],
  buckets: BucketDef[],
  books: (NormalizedBook | null)[],
  marketRows: { feeRate: number; spread: number | null }[],
  cfg: EdgeConfig,
): EdgeRow[] {
  return buckets.map((_, i) => {
    const q = dist[i] ?? 0;
    const book = books[i] ?? null;
    const market = marketRows[i]!;
    const reasons: string[] = [];

    if (book === null) {
      return {
        bucketIdx: i, q, bestAsk: null, execAsk: null, fillableShares: 0,
        feePerShare: null, spread: market.spread, edge: null, minEdge: null,
        pass: false, reasons: ['no_book'],
      };
    }

    const bestAsk = book.asks[0]?.price ?? null;
    if (bestAsk === null) {
      return {
        bucketIdx: i, q, bestAsk: null, execAsk: null, fillableShares: 0,
        feePerShare: null, spread: market.spread, edge: null, minEdge: null,
        pass: false, reasons: ['no_ask_depth'],
      };
    }

    const targetShares = cfg.probeStakeUsd / bestAsk;
    const { avgPrice, fillableShares } = executableAsk(book, targetShares);
    if (fillableShares < targetShares) reasons.push('insufficient_depth');

    const feePerShare = takerFeePerShare(avgPrice, market.feeRate);
    const edge = q - avgPrice;
    const minEdge = minEdgeRequired(avgPrice, market.spread ?? 0, { ...cfg, feeRate: market.feeRate });
    if (edge < minEdge) reasons.push('edge_below_min');

    return {
      bucketIdx: i, q, bestAsk, execAsk: avgPrice, fillableShares,
      feePerShare, spread: market.spread, edge, minEdge,
      pass: reasons.length === 0, reasons,
    };
  });
}

/**
 * Liquidity vetoes appended to row.reasons (§6.7): volume24h below
 * minEventVolumeUsd ($2k default — F-022), spread above maxSpread (5¢),
 * time-to-resolution under minHoursBeforeClose (2h), unverified station,
 * active halt. Pure — returns a new row with pass recomputed.
 */
export function applyLiquidityFilters(
  row: EdgeRow,
  ev: { volume24h: number; secondsToLocalMidnight: number; stationVerified: boolean; halted: boolean },
  cfg: EdgeConfig,
): EdgeRow {
  const reasons = [...row.reasons];
  if (ev.volume24h < cfg.minEventVolumeUsd) reasons.push('volume_below_min');
  if (row.spread !== null && row.spread > cfg.maxSpread) reasons.push('spread_above_max');
  if (ev.secondsToLocalMidnight < cfg.minHoursBeforeClose * 3600) reasons.push('too_close_to_resolution');
  if (!ev.stationVerified) reasons.push('station_unverified');
  if (ev.halted) reasons.push('halted');
  return { ...row, reasons, pass: reasons.length === 0 };
}
