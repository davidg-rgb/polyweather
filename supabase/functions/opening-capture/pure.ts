/**
 * opening-capture/pure — pure, testable row-builders (no network, no Deno, no _shared imports beyond core).
 *
 * Split from handler.ts so the row assembly + flat-open flagging unit-test in Node/vitest while the impure
 * HTTP/seed/insert path stays in handler.ts. Imports only @weather-edge/core (Node-safe, tested).
 */
import {
  isFlatOpen,
  type OpeningBucket,
  type OpeningCapture,
  type OpeningCfg,
} from '../../../packages/core/src/sim/opening-convergence.ts';
import type { ParsedEvent } from '../../../packages/core/src/index.ts';

/** The walked-depth slice for one bucket (handler.ts walks the true CLOB /book; null when not walked). */
export interface BucketDepth {
  /** executable avg ask for the entry size (walked). */
  execAsk: number | null;
  /** buyable $ within +10% of best ask (the true depth, not the vol proxy). */
  depthUsd: number;
  bestBid: number | null;
  /** $ recoverable selling into the bid (the realizable exit side). */
  sellbackUsd: number;
}

/** One assembled capture row (camelCase — consumed by record_opening_captures). */
export interface OpeningCaptureRow {
  capturedAt: string;
  eventId: string | null;
  city: string;
  targetDate: string;
  tzName: string;
  createdAtGamma: string | null;
  listingDetectedAt: string;
  resolvesAt: string | null;
  hoursSinceListing: number | null;
  peakMid: number | null;
  isFlatOpen: boolean;
  houseSeeded: boolean;
  buckets: OpeningBucket[];
  evVol24h: number | null;
  negRisk: boolean;
}

/** Implied-prob proxy = mid of the two-sided quote; null when no real two-sided quote (mirrors the probe). */
export function bucketMid(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid == null || bestAsk == null) return null;
  if (bestBid === 0 && bestAsk === 1) return null; // degenerate (no real book)
  return (bestBid + bestAsk) / 2;
}

/** hours since the event's TRUE Gamma listing time (createdAtGamma); null when the anchor is absent (→ not flat-open). */
export function hoursSinceListing(createdAtGamma: string | null, now: Date): number | null {
  if (!createdAtGamma) return null;
  const t = new Date(createdAtGamma).getTime();
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}

/** Days until a target date (YYYY-MM-DD) from `now` (negative = past). */
export function leadDaysOf(targetDate: string, now: Date): number {
  return (new Date(`${targetDate}T23:59:59Z`).getTime() - now.getTime()) / 86_400_000;
}

/** Inputs for the capture-universe predicate (pure — no I/O). */
export interface UniverseOpts {
  cities: ReadonlySet<string>;
  minVol24hUsd: number;
  now: Date;
  /** the near-dated LIQUID-trajectory lead bound (handler MAX_LEAD_DAYS). */
  maxLeadDays: number;
  /** the FRESH-OPEN bypass window in hours (handler FRESH_LISTING_MAX_H). */
  freshListingMaxH: number;
}

/**
 * Why a parsed event is in the opening-capture universe, or null if excluded. TWO admit paths:
 *
 *  - `'fresh'` — the FLAT OPEN (CAP-1/CAP-2). The §9R daily-Tmax ladders list in a daily batch ~2.8 lead-days
 *    ahead carrying sub-floor 24h volume (≈$1–4k), so a `lead ≤ maxLeadDays ∧ vol ≥ floor` filter ALONE would
 *    only admit them ~12–35h after listing — long after the ≤~1h flat-open window the Phase-0.5 spike exists to
 *    measure. So ANY just-listed scoped event (`createdAt ≤ freshListingMaxH`) is admitted REGARDLESS of lead/vol
 *    (bounded to near-dated by a loose `maxLeadDays + 1.5` sanity cap so a freshly-listed far-future market is
 *    still excluded). This is the only way the open is sampled at all — without it the spike NO-GOs structurally.
 *  - `'liquid'` — the established near-dated LIQUID trajectory (`lead ≤ maxLeadDays ∧ vol ≥ floor`): the
 *    convergence path the market walks AFTER the open, the input to the §9R-E gate's still-flat-vs-converged read.
 *
 * NOTE the vol floor is intentionally NOT applied on the fresh path: at the open no market is liquid yet, and the
 * spike does not re-filter on vol — it measures depth/price enterability. (The $7k floor remains a Phase-2 ENTRY
 * gate in `selectEntries`; reconciling it with entering the open is a separate capital decision — CAP-2.)
 * Pure + total: a missing/invalid createdAt ⇒ `hoursSinceListing` null ⇒ not 'fresh' (fail-closed to the liquid test).
 */
export function openingUniverseReason(ev: ParsedEvent, opts: UniverseOpts): 'liquid' | 'fresh' | null {
  if (ev.kind !== 'highest' || !ev.acceptingOrders || !opts.cities.has(ev.citySlug)) return null;
  const lead = leadDaysOf(ev.targetDate, opts.now);
  if (lead < -0.5) return null; // resolved/past — drop
  const hrs = hoursSinceListing(ev.createdAt, opts.now);
  if (hrs != null && hrs >= 0 && hrs <= opts.freshListingMaxH && lead <= opts.maxLeadDays + 1.5) return 'fresh';
  if (lead <= opts.maxLeadDays && (ev.eventVolume24h ?? 0) >= opts.minVol24hUsd) return 'liquid';
  return null;
}

/**
 * Assemble one opening_captures row from a parsed Gamma event + the walked depth + the (on-demand-seeded)
 * house dist. houseProb is aligned to each LIVE bucket BY LABEL IDENTITY (W6 — never positional). is_flat_open
 * + peak_mid come from the pure core `isFlatOpen` (one source of truth for the flat-open rule). Pure + total.
 */
export function buildOpeningCaptureRow(args: {
  ev: ParsedEvent;
  eventId: string | null;
  polyEventId: string;
  tzName: string;
  createdAtGamma: string | null;
  resolvesAt: string | null;
  capturedAt: string;
  depthByIdx: Map<number, BucketDepth>;
  probsByLabel: Map<string, number>;
  houseSeeded: boolean;
  now: Date;
  cfg: OpeningCfg;
}): OpeningCaptureRow {
  const buckets: OpeningBucket[] = args.ev.buckets.map((b, i) => {
    const d = args.depthByIdx.get(i);
    return {
      idx: i,
      label: b.label,
      loF: b.def.low,
      hiF: b.def.high,
      mid: bucketMid(b.bestBid, b.bestAsk),
      bestAsk: b.bestAsk,
      execAsk: d?.execAsk ?? null,
      depthUsd: d?.depthUsd ?? 0,
      bestBid: b.bestBid,
      sellbackUsd: d?.sellbackUsd ?? 0,
      houseProb: args.probsByLabel.get(b.label) ?? null,
      tokenYes: b.tokenYes,
      tokenNo: b.tokenNo,
      conditionId: b.conditionId,
    };
  });

  const hrs = hoursSinceListing(args.createdAtGamma, args.now);
  const cap: OpeningCapture = {
    eventId: args.eventId,
    city: args.ev.citySlug,
    targetDate: args.ev.targetDate,
    tz: args.tzName,
    createdAtGamma: args.createdAtGamma,
    hoursSinceListing: hrs as number, // isFlatOpen is null-safe (flags 'no_listing_time' on a NaN/undefined anchor)
    resolvesAt: args.resolvesAt,
    negRisk: args.ev.negRiskMarketId != null,
    evVol24h: args.ev.eventVolume24h,
    buckets,
    houseSeeded: args.houseSeeded,
  };
  const fo = isFlatOpen(cap, args.cfg);

  return {
    capturedAt: args.capturedAt,
    eventId: args.eventId,
    city: args.ev.citySlug,
    targetDate: args.ev.targetDate,
    tzName: args.tzName,
    createdAtGamma: args.createdAtGamma,
    listingDetectedAt: args.capturedAt,
    resolvesAt: args.resolvesAt,
    hoursSinceListing: hrs,
    peakMid: Number.isFinite(fo.peakMid) ? fo.peakMid : null,
    isFlatOpen: fo.flat,
    houseSeeded: args.houseSeeded,
    buckets,
    evVol24h: args.ev.eventVolume24h,
    negRisk: args.ev.negRiskMarketId != null,
  };
}
