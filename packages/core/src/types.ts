/** Shared domain types (ARCHITECTURE.md §5, §6.3, §6.4). */

/** Native temperature unit of a city/market — °F (US) or °C (intl). */
export type Unit = 'C' | 'F';

/**
 * A parsed market bucket (§6.3). `low`/`high` are inclusive whole degrees in
 * the ladder's native unit; null marks the open side of a tail bucket:
 *   '94-95°F'      → { low: 94,   high: 95,   unit: 'F' }
 *   '87°F or below'→ { low: null, high: 87,   unit: 'F' }
 *   '19°C or higher'→{ low: 19,   high: null, unit: 'C' }
 *   '15°C'         → { low: 15,   high: 15,   unit: 'C' }
 */
export interface BucketDef {
  low: number | null;
  high: number | null;
  unit: Unit;
}

/** A bias-corrected per-model forecast point feeding ensembleStats (§6.5); value in native degrees. */
export interface ForecastPoint {
  model: string;
  value: number;
}

/** Inputs of minEdgeRequired (§6.4). feeRate comes from market_buckets.fee_rate — never hardcoded. */
export interface EdgeConfig {
  /** Probability-point buffer for model misspecification (config uncertaintyMargin, default 0.05). */
  uncertaintyMargin: number;
  /** Floor on the spread component (config spreadBufferMin, default 0.01). */
  spreadBufferMin: number;
  /** Market taker-fee rate from feeSchedule.rate (currently 0.05 everywhere — read per market). */
  feeRate: number;
}
