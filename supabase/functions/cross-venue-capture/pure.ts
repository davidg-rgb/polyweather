/**
 * cross-venue-capture — pure, testable helpers (no network, no Deno, no _shared imports).
 *
 * Split from handler.ts so the venue→ladder transforms and the engine-driven capture-row assembly
 * unit-test in Node/vitest (handler.test.ts), while the impure HTTP + insert path stays in handler.ts.
 * Imports only @weather-edge/core (Node-safe, tested): the cross-venue engine + the Kalshi parser.
 */
import { type ParsedEvent } from '../../../packages/core/src/index.ts';
import {
  MIN_DEPTH_SHARES,
  NEUTRAL_BASIS,
  crossVenueDivergence,
  crossVenueEdge,
  impliedLadder,
  type VenueBucket,
  type VenueLadder,
} from '../../../packages/core/src/sim/cross-venue-arb.ts';
import { KALSHI_HIGH_SERIES, parseKalshiLadder } from '../../../packages/core/src/kalshi/markets.ts';

/** Lead (days until targetDate) at or below which to capture — match the open near-dated markets. */
export const MAX_LEAD_DAYS = 2;

const fin = (v: number): number | null => (Number.isFinite(v) ? v : null);

/**
 * Build the Polymarket VenueLadder from a parsed Gamma event: each bucket's integer °F span is its
 * BucketDef [low, high] (null = open tail), priced at the Gamma top-of-book bestAsk/bestBid. There is
 * no top-of-book SIZE on Gamma, so the depth proxy is the bucket's 24h volume (v1 — see CROSS-VENUE-
 * SPIKE.md; a positive-edge day triggers a true CLOB depth-walk before any capital).
 */
export function polyLadderFromEvent(ev: ParsedEvent): VenueLadder {
  return {
    venue: 'polymarket',
    buckets: ev.buckets.map(
      (b): VenueBucket => ({
        loF: b.def.low,
        hiF: b.def.high,
        yesAsk: b.bestAsk,
        yesBid: b.bestBid,
        topAskSize: b.volume24h ?? 0,
        topBidSize: b.volume24h ?? 0,
      }),
    ),
  };
}

/** Days until a target date (YYYY-MM-DD) from `now`. Negative = past. */
export function leadDays(targetDate: string, now: Date): number {
  const t = new Date(`${targetDate}T23:59:59Z`).getTime();
  return (t - now.getTime()) / 86_400_000;
}

/** Is this a US °F city we have a Kalshi series for AND a near-dated open event? */
export function isOverlapEvent(ev: ParsedEvent, now: Date): boolean {
  return (
    ev.kind === 'highest' &&
    ev.unit === 'F' &&
    KALSHI_HIGH_SERIES[ev.citySlug] != null &&
    leadDays(ev.targetDate, now) >= -0.5 &&
    leadDays(ev.targetDate, now) <= MAX_LEAD_DAYS
  );
}

/** One assembled capture row (camelCase — consumed by record_cross_venue_captures). */
export interface CrossVenueCaptureRow {
  capturedAt: string;
  city: string;
  targetDate: string;
  polyNBuckets: number;
  kalshiNBuckets: number;
  polyMeanF: number | null;
  kalshiMeanF: number | null;
  meanDiffF: number | null;
  maxAbsGap: number | null;
  maxGapAtF: number | null;
  bestNetEdge: number | null;
  edgeAtF: number | null;
  direction: string;
  cashflow: number | null;
  expPayoff: number | null;
  limitDepth: number | null;
  hasRealDepth: boolean;
  netPositive: boolean;
}

/**
 * Run the cross-venue engine on a matched (Polymarket, Kalshi) ladder pair and assemble the capture
 * row. Returns null if either side has no usable quotes (no comparison possible this tick). Pure.
 */
export function buildCaptureRow(
  city: string,
  targetDate: string,
  poly: VenueLadder,
  kalshi: VenueLadder,
  capturedAt: string,
): CrossVenueCaptureRow | null {
  const polyImpl = impliedLadder(poly);
  const kalshiImpl = impliedLadder(kalshi);
  if (!polyImpl.ok || !kalshiImpl.ok) return null;

  const div = crossVenueDivergence(polyImpl, kalshiImpl);
  // v1: basis-NEUTRAL — measure the pure cross-venue price dislocation (a CLI-hot prior manufactures a
  // systematic buy-Kalshi edge even when the venues agree; the realized basis refines later). See NEUTRAL_BASIS.
  const edge = crossVenueEdge(polyImpl, kalshiImpl, NEUTRAL_BASIS);

  return {
    capturedAt,
    city,
    targetDate,
    polyNBuckets: polyImpl.spans.length,
    kalshiNBuckets: kalshiImpl.spans.length,
    polyMeanF: fin(polyImpl.meanF),
    kalshiMeanF: fin(kalshiImpl.meanF),
    meanDiffF: fin(div.meanDiffF),
    maxAbsGap: fin(div.maxAbsGap),
    maxGapAtF: fin(div.maxGapAtF),
    bestNetEdge: fin(edge.bestNetEdge),
    edgeAtF: fin(edge.atF),
    direction: edge.direction,
    cashflow: fin(edge.cashflow),
    expPayoff: fin(edge.expPayoff),
    limitDepth: fin(edge.limitDepth),
    hasRealDepth: edge.ok && Number.isFinite(edge.limitDepth) && edge.limitDepth >= MIN_DEPTH_SHARES,
    netPositive: edge.ok && edge.bestNetEdge > 0,
  };
}

/** Re-export so the handler doesn't import the engine + the Kalshi parser separately. */
export { KALSHI_HIGH_SERIES, parseKalshiLadder };
