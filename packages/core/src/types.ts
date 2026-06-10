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

/** Inputs of minEdgeRequired + the edge/liquidity pipeline (§6.4, §6.7). feeRate comes from market_buckets.fee_rate — never hardcoded. */
export interface EdgeConfig {
  /** Probability-point buffer for model misspecification (config uncertaintyMargin, default 0.05). */
  uncertaintyMargin: number;
  /** Floor on the spread component (config spreadBufferMin, default 0.01). */
  spreadBufferMin: number;
  /** Market taker-fee rate from feeSchedule.rate (currently 0.05 everywhere — read per market). */
  feeRate: number;
  /** USD stake the book walk probes for execution price (config probeStakeUsd, default 20). */
  probeStakeUsd: number;
  /** Liquidity veto: max acceptable spread (config maxSpread, default 0.05). */
  maxSpread: number;
  /** Liquidity veto: min event 24h volume in USD (config minEventVolumeUsd, default 2000 — F-022). */
  minEventVolumeUsd: number;
  /** Liquidity veto: min hours before local-midnight resolution (config minHoursBeforeClose, default 2). */
  minHoursBeforeClose: number;
}

/** One price level of an order book. */
export interface BookLevel {
  price: number;
  size: number;
}

/** Output of normalizeBook (§6.9): numeric levels, BEST FIRST on both sides, hash carried. */
export interface NormalizedBook {
  market: string;
  assetId: string;
  timestamp: number;
  hash: string;
  /** Best (highest) bid first. */
  bids: BookLevel[];
  /** Best (lowest) ask first. */
  asks: BookLevel[];
  minOrderSize: number;
  tickSize: number;
  negRisk: boolean;
  lastTradePrice: number | null;
}

/** Per-bucket edge evaluation (§6.7) — persisted hourly to edge_evaluations (F-038). */
export interface EdgeRow {
  bucketIdx: number;
  q: number;
  bestAsk: number | null;
  execAsk: number | null;
  fillableShares: number;
  feePerShare: number | null;
  spread: number | null;
  edge: number | null;
  minEdge: number | null;
  pass: boolean;
  reasons: string[];
}

/** Risk-cap & circuit-breaker tunables consumed by §6.8 (subset of §6.11 config; bankroll arrives via the caps ctx). */
export interface RiskConfig {
  perTradeCapPct: number;
  perEventCapPct: number;
  clusterCapPct: number;
  dailyCapPct: number;
  minStakeUsd: number;
  breakerConsecLosses: number;
  breakerDailyLossPct: number;
  breakerDrawdownPct: number;
  breakerBrier: number;
  staleForecastHaltH: number;
  stalePriceHaltMin: number;
}

/** A capped, share-floored stake ready for recommendation (§6.8). */
export interface StakePlan {
  bucketIdx: number;
  stakeUsd: number;
  shares: number;
  /** Every clamp applied, in order — audit trail (ADR-09). */
  capAudit: string[];
}
