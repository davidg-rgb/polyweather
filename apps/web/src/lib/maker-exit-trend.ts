/**
 * maker-exit-trend — the PURE series-shaping for the /maker-exit "assumptions over time" small multiples.
 *
 * Turns the dash_maker_exit_history (0079) snapshot stream into per-metric numeric series for the sparklines
 * above tile #4. The load-bearing invariant is the HONEST-NULL contract (REWARD-INSTR-ROLLOUT.md): a snapshot
 * whose assumption is NaN lands in the feed as null and MUST stay null in the series — the sparkline breaks its
 * line at a null and never fabricates a zero (a real 0, e.g. qualifyingTickFrac=0, is kept distinct). No I/O,
 * no throwing: junk → an empty / all-null series.
 */
import type { MakerExitHistoryPoint } from './loaders.ts';

/** the numeric assumption columns a sparkline can chart (the categorical dominantDisqualifier is excluded). */
export type TrendMetricKey =
  | 'makerFillRate'
  | 'realizedRebateUsd'
  | 'qualifyingTickFrac'
  | 'meanDistFromMidPp'
  | 'fracWithinAdvertisedBand'
  | 'fracFailsMinSize';

export interface TrendRefLine {
  y: number;
  label: string;
  /** 'warn' = the danger threshold (below/above which the edge is at risk); 'ref' = the backtest expectation. */
  tone: 'warn' | 'ref';
}

export interface TrendSpec {
  key: TrendMetricKey;
  label: string;
  /** how the current-value readout + the y-axis ticks are formatted. */
  kind: 'pct' | 'usd' | 'pp';
  /** a pinned y-domain (fractions pin to [0,1]); when absent the domain derives from the data ∪ ref lines ∪ 0. */
  fixedDomain?: [number, number];
  refLines?: TrendRefLine[];
  hint?: string;
}

/**
 * The small-multiples spec: the three measured assumptions (makerFillRate / realizedRebateUsd / qualifyingTickFrac)
 * + the v2 "WHY" fields. The fill-rate line carries the 0.30 warning + 0.49 backtest reference lines
 * (MAKER-EXIT-SIM.md §"hyper-sensitive to the realized maker-fill rate": backtest 0.49, live early read 0.30 →
 * if 0.30 persists at scale the edge inverts).
 */
export const MAKER_EXIT_TREND_SPECS: readonly TrendSpec[] = [
  {
    key: 'makerFillRate',
    label: '#1 · Maker-fill rate',
    kind: 'pct',
    fixedDomain: [0, 1],
    refLines: [
      { y: 0.3, label: '0.30 warn', tone: 'warn' },
      { y: 0.49, label: '0.49 backtest', tone: 'ref' },
    ],
    hint: '§12 adverse selection — the edge inverts if this holds at 0.30',
  },
  { key: 'realizedRebateUsd', label: '#2 · Realized rebate', kind: 'usd', hint: '$ credited on realized maker legs' },
  {
    key: 'qualifyingTickFrac',
    label: '#4 · Reward-qualifying ticks',
    kind: 'pct',
    fixedDomain: [0, 1],
    hint: 'share of resting ticks in the 4.5¢ band',
  },
  { key: 'meanDistFromMidPp', label: 'WHY · dist from mid', kind: 'pp', hint: 'resting sell vs prior-tick mid' },
  {
    key: 'fracWithinAdvertisedBand',
    label: 'WHY · in-band',
    kind: 'pct',
    fixedDomain: [0, 1],
    hint: '≤ 4.5¢ band (the price-band half only)',
  },
  { key: 'fracFailsMinSize', label: 'WHY · fail min-size', kind: 'pct', fixedDomain: [0, 1], hint: 'below the 50-share floor' },
] as const;

/** Coerce a jsonb-delivered scalar to a finite number, or null (a NaN / null / non-numeric ⇒ a line break). */
export function coerceFinite(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Degradation floor for the trend inputs (2026-07-05 review #21) — the SAME floor the Edge handler applies
 * before writing the §9R-E gate of record: a snapshot produced by a partial tick (cityErrors > 2 — e.g. the
 * 07-05 DB-crash day's 1-of-73-cities tick) or over less than the gate's own 40-market minimum sample is a
 * PARTIAL VIEW — headlining/sparklining it (e.g. a makerFillRate of 0.0 or 1.0 over ≤2 realized exits) would
 * mislead the operator watching the 0.30 edge-inversion threshold on assumption #1.
 *
 * cityErrors semantics: null = UNKNOWN (snapshots predating the 0084 RPC field) — NOT treated as degraded
 * (only the sample-size floor applies there); a known count > TREND_MAX_CITY_ERRORS excludes the point.
 */
export const TREND_MIN_MARKETS = 40;
export const TREND_MAX_CITY_ERRORS = 2;

/** True when a snapshot fails the degradation floor and must not feed the trend headline/sparkline. */
export function isDegradedTrendPoint(p: MakerExitHistoryPoint): boolean {
  const cityErrors = coerceFinite(p?.cityErrors);
  if (cityErrors != null && cityErrors > TREND_MAX_CITY_ERRORS) return true;
  const nMarkets = coerceFinite(p?.nMarkets);
  return !(nMarkets != null && nMarkets >= TREND_MIN_MARKETS);
}

/**
 * Split the snapshot stream into trend-worthy points and a degraded-excluded count. Order is preserved
 * (oldest→newest); junk in → { points: [], excluded: 0 } out (no throwing — the component contract).
 */
export function filterTrendPoints(points: MakerExitHistoryPoint[]): {
  points: MakerExitHistoryPoint[];
  excluded: number;
} {
  const all = Array.isArray(points) ? points : [];
  const kept = all.filter((p) => !isDegradedTrendPoint(p));
  return { points: kept, excluded: all.length - kept.length };
}

/** Extract one metric column as a null-preserving series (aligned 1:1 with the snapshot order). */
export function toSeries(points: MakerExitHistoryPoint[], key: TrendMetricKey): (number | null)[] {
  return (Array.isArray(points) ? points : []).map((p) => coerceFinite(p?.[key]));
}

/** The y-domain for a series: the spec's fixed domain, else [min, max] over the finite values ∪ ref lines ∪ 0. */
export function seriesDomain(values: (number | null)[], spec: TrendSpec): [number, number] {
  if (spec.fixedDomain) return spec.fixedDomain;
  const nums = values.filter((v): v is number => v !== null);
  const refs = (spec.refLines ?? []).map((r) => r.y);
  const all = [...nums, ...refs, 0];
  const min = Math.min(...all);
  const max = Math.max(...all);
  return min === max ? [min, min + 1] : [min, max];
}

/** The most recent finite value (the current-value readout); null when the series is empty / all-null. */
export function lastFinite(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null) return v;
  }
  return null;
}

/** True when at least one snapshot has a finite value for this metric (else the card shows a no-data state). */
export function hasAnyFinite(values: (number | null)[]): boolean {
  return values.some((v) => v !== null);
}
