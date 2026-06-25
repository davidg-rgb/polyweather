/**
 * arb-depth-capture — pure, testable helpers (no network, no Deno, no _shared imports).
 *
 * Split out from handler.ts so the WALL-TIME-BOUNDING selection logic — the load-bearing fix for the
 * prior arb timeout — can be unit-tested in Node/vitest (handler.test.ts imports from here). The impure
 * HTTP + Slack + insert path stays in handler.ts. Imports only @weather-edge/core (Node-safe, tested).
 */
import {
  type NormalizedBook,
  type ParsedEvent,
  type RawGammaEvent,
} from '../../../packages/core/src/index.ts';
import { FEE_RATE_WEATHER, completeSetEdge } from '../../../packages/core/src/sim/complete-set-arb.ts';

/** Lead (days until targetDate close) at which to capture. The thin-open-book window lives ≤ 2d. */
export const MAX_LEAD_DAYS = 2;
/**
 * Only deep-capture (full-CLOB) ladders whose Gamma top-of-book Σ best-ask is at or below this. A ladder
 * can only be an underround dislocation if its Σask is thin; a richly-quoted ladder cannot clear
 * regardless of depth. The lead≤2d set alone is ~every open ladder, so deep-fetching all of them
 * (~100 ladders × ~11 buckets) blows the Edge wall-time. Pre-ranking on the FREE Gamma top-of-book
 * targets the Move-1 question AND bounds the per-tick CLOB fetch count. 1.02 keeps real underrounds (<1)
 * plus near-misses (the live probe saw chengdu 0.981, miami 1.011).
 */
export const CAPTURE_SUM_ASK_MAX = 1.02;
/** Hard cap on deep (full-CLOB) captures per tick — a safety bound on wall-time. */
export const MAX_DEEP_CAPTURES = 25;

export interface PerLegDepth {
  bucketIdx: number;
  topPrice: number | null;
  topSize: number | null;
  totalSize: number;
}

export type RawAndParsed = { raw: RawGammaEvent; parsed: ParsedEvent };
export type DeepCandidate = { ev: RawAndParsed; topSumAsk: number };

/** Days until targetDate (the market close / resolution date). Negative = past. */
export function computeLeadDays(targetDate: string, now: Date): number {
  const target = new Date(`${targetDate}T23:59:59Z`);
  return (target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Select the deep-capture set with ZERO CLOB calls: keep ladders with ≥3 buckets and lead ≤ MAX_LEAD_DAYS,
 * then pre-rank on the FREE Gamma top-of-book Σ best-ask and keep only the thinnest candidates
 * (Σask ≤ CAPTURE_SUM_ASK_MAX, ascending, capped at MAX_DEEP_CAPTURES).
 *
 * NOTE on age: for weather ladders Gamma's gameStartTime is local-midnight of the TARGET day (not the
 * market-open instant — see gamma.ts targetDateFromEvent), so an "age since open" cannot be derived from
 * it. The prior age<2h gate was therefore inert; it is intentionally dropped — the Σask pre-rank is the
 * real, sufficient bound.
 */
export function selectDeepCandidates(events: RawAndParsed[], now: Date): DeepCandidate[] {
  return events
    .filter(({ parsed }) => parsed.buckets.length >= 3 && computeLeadDays(parsed.targetDate, now) <= MAX_LEAD_DAYS)
    .map((ev) => ({
      ev,
      topSumAsk: completeSetEdge(
        ev.parsed.buckets.map((b) => b.bestAsk),
        ev.parsed.buckets.map((b) => b.bestBid),
        FEE_RATE_WEATHER,
      ).sumAsk,
    }))
    .filter((x): x is DeepCandidate => x.topSumAsk !== null && x.topSumAsk <= CAPTURE_SUM_ASK_MAX)
    .sort((a, b) => a.topSumAsk - b.topSumAsk)
    .slice(0, MAX_DEEP_CAPTURES);
}

/** Build the per-leg depth summary from normalized books. */
export function buildPerLegDepth(books: NormalizedBook[]): PerLegDepth[] {
  return books.map((bk, idx) => {
    const topAsk = bk.asks[0];
    const totalSize = bk.asks.reduce((s, lv) => s + (Number.isFinite(lv.size) ? lv.size : 0), 0);
    return {
      bucketIdx: idx,
      topPrice: topAsk ? topAsk.price : null,
      topSize: topAsk ? topAsk.size : null,
      totalSize,
    };
  });
}
