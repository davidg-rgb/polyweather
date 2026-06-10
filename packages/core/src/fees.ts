/**
 * core/fees — fee curve & minimum edge (ARCHITECTURE.md §6.4, ADR-07).
 *
 * Fee rate is read per market from feeSchedule.rate (currently 0.05 everywhere)
 * and arrives via params/EdgeConfig — never hardcoded here.
 */
import type { EdgeConfig } from './types.ts';

/**
 * Polymarket weather fee replica: rate × p × (1−p), in USDC per share
 * (docs-verbatim formula). Worked example: takerFeePerShare(0.34, 0.05) = 0.01122.
 */
export function takerFeePerShare(p: number, rate: number): number {
  return rate * p * (1 - p);
}

/** shares × takerFeePerShare — convenience for fills/grading. */
export function takerFeeTotal(p: number, shares: number, rate: number): number {
  return shares * takerFeePerShare(p, rate);
}

/**
 * Price-dependent trade threshold in probability points:
 *   uncertaintyMargin + max(spreadBufferMin, observedSpread/2) + takerFeePerShare(p, feeRate)
 * Compared against edge = q − execAsk.
 */
export function minEdgeRequired(p: number, observedSpread: number, cfg: EdgeConfig): number {
  return (
    cfg.uncertaintyMargin +
    Math.max(cfg.spreadBufferMin, observedSpread / 2) +
    takerFeePerShare(p, cfg.feeRate)
  );
}
