/**
 * cross-venue-capture — pure, testable helpers (no network, no Deno, no _shared imports).
 *
 * Split from handler.ts so the venue→ladder transforms and the engine-driven capture-row assembly
 * unit-test in Node/vitest (handler.test.ts), while the impure HTTP + insert path stays in handler.ts.
 * Imports only @weather-edge/core (Node-safe, tested): the cross-venue engine + the Kalshi parser.
 */
import { type ParsedEvent } from '../../../packages/core/src/index.ts';
import {
  MIN_KALSHI_OI,
  MIN_POLY_VOL_USD,
  NEUTRAL_BASIS,
  crossVenueDivergence,
  crossVenueEdge,
  impliedLadder,
  type CrossVenueEdge,
  type VenueBucket,
  type VenueLadder,
} from '../../../packages/core/src/sim/cross-venue-arb.ts';
import { KALSHI_HIGH_SERIES, parseKalshiLadder, type KalshiBin } from '../../../packages/core/src/kalshi/markets.ts';

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
  /**
   * TRUE binding executable size of the best position, walked on BOTH order books (handler.ts) — null
   * until walked. Only computed for net-positive rows (the false-PASS risk); efficient days stay null.
   */
  execSize: number | null;
  /** execSize ≥ MIN_EXEC_SIZE — a net-positive row counts as a real WIN only if this is true. */
  isExecutable: boolean;
}

/**
 * Run the cross-venue engine on a matched (Polymarket, Kalshi) ladder pair and assemble the capture row,
 * returning it alongside the engine `edge` (whose buyLegsLoF/sellLegsLoF the handler walks for TRUE
 * executable depth). Returns null if either side has no usable quotes (no comparison possible this tick).
 * Pure — the network depth-walk that finalizes execSize/isExecutable lives in handler.ts.
 */
export function buildCaptureRow(
  city: string,
  targetDate: string,
  poly: VenueLadder,
  kalshi: VenueLadder,
  capturedAt: string,
): { row: CrossVenueCaptureRow; edge: CrossVenueEdge } | null {
  const polyImpl = impliedLadder(poly);
  const kalshiImpl = impliedLadder(kalshi);
  if (!polyImpl.ok || !kalshiImpl.ok) return null;

  const div = crossVenueDivergence(polyImpl, kalshiImpl);
  // v1: basis-NEUTRAL — measure the pure cross-venue price dislocation (a CLI-hot prior manufactures a
  // systematic buy-Kalshi edge even when the venues agree; the realized basis refines later). See NEUTRAL_BASIS.
  const edge = crossVenueEdge(polyImpl, kalshiImpl, NEUTRAL_BASIS);

  const row: CrossVenueCaptureRow = {
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
    // Real depth = BOTH books liquid, per venue-appropriate units (Kalshi OI contracts, Poly 24h USD) —
    // the DENOMINATOR filter (a liquid market exists). Decoupled from edge sign so efficient (≤0-edge)
    // liquid days count. NOTE: this is the 24h-vol/OI PROXY; a net-positive row's real executability is
    // the separate isExecutable below (walked on both order books — the capacity wall that decides WINS).
    hasRealDepth: edge.ok && edge.kalshiBookDepth >= MIN_KALSHI_OI && edge.polyBookDepth >= MIN_POLY_VOL_USD,
    netPositive: edge.ok && edge.bestNetEdge > 0,
    execSize: null, // walked by the handler for net-positive rows only
    isExecutable: false,
  };
  return { row, edge };
}

/**
 * One leg of the best cross-venue position to walk for true depth: a concrete venue order book (Kalshi
 * market ticker or Polymarket YES token) + the side to hit (buy legs hit the ASK, sell legs hit the BID).
 * `id === ''` means the engine leg could not be mapped to a book ⇒ the handler must treat it as size 0
 * (an unfillable leg, the safe direction for a kill gate — never silently dropped, which would overstate).
 */
export interface LegRef {
  venue: 'polymarket' | 'kalshi';
  id: string; // Kalshi ticker or Polymarket YES token id; '' if unmappable
  side: 'ask' | 'bid';
  loF: number;
}
export interface PositionLegs {
  buyLegs: LegRef[];
  sellLegs: LegRef[];
}

/**
 * Map the engine edge's leg thresholds (buyLegsLoF on buyVenue, sellLegsLoF on sellVenue) to concrete
 * order-book refs the handler can walk: Kalshi loF → market ticker, Polymarket loF → YES token id. Buy
 * legs hit the ask, sell legs hit the bid. Every leg is preserved (unmappable → id ''), so the binding
 * min sees a 0 rather than over-counting. Pure + total.
 */
export function executableLegSpecs(ev: ParsedEvent, bins: KalshiBin[], edge: CrossVenueEdge): PositionLegs {
  const kByLoF = new Map<number, string>(); // Kalshi loF → ticker
  for (const b of bins) if (b.loF != null) kByLoF.set(b.loF, b.ticker);
  const pByLoF = new Map<number, string>(); // Polymarket loF → YES token id
  for (const b of ev.buckets) if (b.def.low != null) pByLoF.set(b.def.low, b.tokenYes);
  const ref = (venue: LegRef['venue'], loF: number, side: LegRef['side']): LegRef => ({
    venue,
    id: (venue === 'kalshi' ? kByLoF.get(loF) : pByLoF.get(loF)) ?? '',
    side,
    loF,
  });
  return {
    buyLegs: edge.buyLegsLoF.map((loF) => ref(edge.buyVenue, loF, 'ask')),
    sellLegs: edge.sellLegsLoF.map((loF) => ref(edge.sellVenue, loF, 'bid')),
  };
}

/** Re-export so the handler doesn't import the engine + the Kalshi parser separately. */
export { KALSHI_HIGH_SERIES, parseKalshiLadder };
