/**
 * scripts/research/opening-spike — the Phase-0.5 SIGNAL-AVAILABILITY GO/NO-GO SPIKE
 * (ARCHITECTURE-OPENING-CONVERGENCE.md §6.13c / §14 Phase 0.5 / PHASE-0-BUILD-HANDOFF §5, F11-r8).
 *
 * THE DECISIVE CHEAP GATE. The opening-convergence thesis is: a freshly-listed daily-Tmax market opens FLAT
 * (~10–12%/bucket — the book is uninformed) and CONVERGES to a peaked distribution; buy our `house_gaussian`
 * forecast-center buckets cheap at the flat open and sell into the convergence. The whole thesis rests on a
 * load-bearing unknown (R-13 / C1): *is the forecast signal (a usable `house_gaussian`) even AVAILABLE while
 * the book is STILL flat-open, and is there cheap depth in the forecast center at that moment?* If the dist
 * only ever materializes AFTER the book has already converged, there is nothing to buy cheap — the lever is
 * dead. This spike falsifies (or clears) that BEFORE any execution layer is built. It is the entire reason
 * Phase 0 (keyless capture) is built first, and it GATES Phases 2–6.
 *
 * WHAT IT DOES — over ≥1 week of real `opening_captures` (read via the `bot_capture_series(p_days)` RPC,
 * migration 0066), for each `event_id`:
 *   1. select the FIRST capture (earliest captured_at) where a usable `house_gaussian` first exists —
 *      `house_seeded=true` OR a non-null `houseProb` in `buckets` ("the moment a dist first exists").
 *   2. run `isFlatOpen(cap, cfg)` (core/sim/opening-convergence §6.1) on THAT capture — is the book STILL
 *      flat-open (peak ≤ cfg.peakMidMax, within cfg.listingMaxHours of listing) at first-house-dist? The flag
 *      is re-derived here against the spike's live cfg, never trusted from the stored `is_flat_open`.
 *   3. read the forecast-center band (mode ± cfg.centerHalfWidth, mode = argmax of per-bucket houseProb): is
 *      there a cheap center bucket with true-walked depth ≥ cfg.depthFloorUsd? (the bot enters a bucket iff
 *      ITS OWN depth clears the floor — `selectEntries` §6.2 — so availability = ∃ a center bucket clearing it).
 *   4. emit the GO FRACTION = share of seeded events that are BOTH still-flat-open AND carry cheap center depth.
 *
 * VERDICT: GO iff goFraction ≥ cfg.spikeGoFrac (e.g. 0.5) over ≥1-week events; else KILL the lever HERE
 * (cheaply, before the execution stack) and update FINDINGS.md. INSUFFICIENT_DATA when there is < ~1 week of
 * capture span or too few seeded events — this script is RUN later, after the every-2-min capture cron has
 * been live for ≥1 week, and must not crash on an empty table.
 *
 * Read-only, KEYLESS. Reads the DB via the service-role `script-db` client + the `bot_capture_series` RPC.
 * Places NOTHING, writes NOTHING. Never imports `packages/trading`; the live rail stays DORMANT. Run:
 *   pnpm tsx scripts/research/opening-spike.ts [--days N]   (default 8 = ≥1 week + buffer)
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  isFlatOpen,
  parseBotConfig,
  type BotConfig,
  type OpeningBucket,
  type OpeningCapture,
} from '../../packages/core/src/sim/opening-convergence.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import type { Db } from '../lib/backfill.ts';

export const SCRIPT = 'opening-spike';

// Spike sufficiency bars (NOT the §9R-E net-profit gate — that decides CAPITAL, a separate later gate). These
// only protect the FRACTION from being read off a too-thin / too-short panel: a meaningful goFraction needs
// ≥1 week of real capture span and a handful of seeded events to estimate over.
export const MIN_SPIKE_DAYS = 7;
export const MIN_SPIKE_EVENTS = 8;
// The minimum fraction of distinct listed events that must EVER reach a usable house_gaussian AT ALL.
// seededCoverage = nSeededEvents/nEvents where "seeded" means a usable dist materialized at SOME capture (not
// necessarily while flat — that flat-vs-converged distinction lives in goFraction, via the first-seeded
// capture's flat-open test). The GO fraction excludes never-seeded events, so a high goFraction over a thin
// seeded minority would FALSE-GO. The two NO-GO modes are therefore distinct: low COVERAGE = the forecast
// never materialized at all for most markets (the dist pipeline doesn't reach them); a usable-but-LATE
// (after-convergence) dist instead lowers the goFRACTION. A GO requires BOTH a high pass fraction AND broad
// coverage. (A *seed-pipeline* collapse would have already tripped capture_deadman before the spike runs, so
// by spike time low coverage is a real availability finding, not a transient bug — confirm the deadman first.)
export const MIN_SEEDED_COVERAGE = 0.5;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// formatting helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (v: number, d = 0): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const usd = (v: number): string => (Number.isFinite(v) ? `$${v.toFixed(1)}` : '—');
const num0 = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// the raw `bot_capture_series` row shapes (camelCase, as the RPC's jsonb_build_object emits them)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One bucket inside a capture row's `buckets` jsonb (same shape as core's OpeningBucket). */
export interface RawBucket {
  idx: number;
  label: string | null;
  loF: number | null;
  hiF: number | null;
  mid: number | null;
  bestAsk: number | null;
  execAsk: number | null;
  depthUsd: number | null;
  bestBid: number | null;
  sellbackUsd: number | null;
  execBid: number | null;
  sellbackDepthUsd: number | null;
  houseProb: number | null;
  tokenYes: string | null;
  tokenNo: string | null;
  conditionId: string | null;
}

/** One `opening_captures` row as `bot_capture_series` returns it (note `tzName`, not `tz`). */
export interface RawCaptureRow {
  eventId: string | null;
  capturedAt: string;
  city: string | null;
  targetDate: string | null;
  tzName: string | null;
  createdAtGamma: string | null;
  resolvesAt: string | null;
  hoursSinceListing: number | null;
  peakMid: number | null;
  isFlatOpen: boolean | null;
  houseSeeded: boolean | null;
  buckets: RawBucket[] | null;
  evVol24h: number | null;
  negRisk: boolean | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// raw → core mappers (so we can call the pure `isFlatOpen`/mode/center logic on captured data)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function mapBucket(b: RawBucket): OpeningBucket {
  return {
    idx: num0(b.idx),
    label: String(b.label ?? ''),
    loF: numOrNull(b.loF),
    hiF: numOrNull(b.hiF),
    mid: numOrNull(b.mid),
    bestAsk: numOrNull(b.bestAsk),
    execAsk: numOrNull(b.execAsk),
    depthUsd: num0(b.depthUsd),
    bestBid: numOrNull(b.bestBid),
    sellbackUsd: num0(b.sellbackUsd),
    execBid: numOrNull(b.execBid),
    sellbackDepthUsd: num0(b.sellbackDepthUsd),
    houseProb: numOrNull(b.houseProb),
    tokenYes: String(b.tokenYes ?? ''),
    tokenNo: String(b.tokenNo ?? ''),
    conditionId: String(b.conditionId ?? ''),
  };
}

function mapCapture(r: RawCaptureRow): OpeningCapture {
  return {
    eventId: r.eventId,
    city: String(r.city ?? ''),
    targetDate: String(r.targetDate ?? ''),
    tz: String(r.tzName ?? ''), // bot_capture_series emits `tzName`; the core shape calls it `tz`
    createdAtGamma: r.createdAtGamma ?? null,
    // hoursSinceListing must stay NaN (not 0) when absent — isFlatOpen's fin() gate then flags `no_listing_time`.
    hoursSinceListing: r.hoursSinceListing == null ? NaN : num0(r.hoursSinceListing),
    resolvesAt: r.resolvesAt ?? null,
    negRisk: r.negRisk ?? true,
    evVol24h: numOrNull(r.evVol24h),
    buckets: Array.isArray(r.buckets) ? r.buckets.map(mapBucket) : [],
    houseSeeded: r.houseSeeded === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// pure spike logic
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A usable house_gaussian exists for this capture — the seed flag OR an actual per-bucket houseProb. */
export function hasUsableHouse(cap: OpeningCapture): boolean {
  return cap.houseSeeded || cap.buckets.some((b) => fin(b.houseProb));
}

/** modeIdx = argmax of the per-bucket houseProb (the forecast center). -1 when no bucket carries a houseProb. */
export function modeIdxOf(buckets: OpeningBucket[]): number {
  let idx = -1;
  let best = Number.NEGATIVE_INFINITY;
  for (const b of buckets) {
    if (fin(b.houseProb) && b.houseProb > best) {
      best = b.houseProb;
      idx = b.idx;
    }
  }
  return idx;
}

/**
 * The deepest ENTERABLE forecast-center bucket. Mirrors `selectEntries` (§6.2) EXACTLY — within mode ±
 * centerHalfWidth, a finite houseProb, a positive executable ask AT or below the reservation
 * `min(maxEntryPrice, houseProb − entryEdgeMargin)` (the 20% cheap cap + the edge margin), AND depth ≥ floor.
 * Depth alone is NOT enough (TEST2-1): flat-open is measured on the bucket MID (≤0.18), but a thin uninformed
 * book can have mid ≤ 0.18 while the executable ASK walks to 0.25–0.34 — deep but ABOVE the cap, so the bot's
 * selectEntries would reject it. Counting depth-only would let the spike say GO on markets that are not
 * actually enterable; this gates the spike on the same reservation the executor uses.
 */
export function centerDepth(
  buckets: OpeningBucket[],
  modeIdx: number,
  cfg: BotConfig,
): { maxDepthUsd: number; modeLabel: string | null; priceBlocked: boolean } {
  if (modeIdx < 0) return { maxDepthUsd: 0, modeLabel: null, priceBlocked: false };
  let maxDepthUsd = 0;
  let modeLabel: string | null = null;
  // priceBlocked = an in-band bucket had ADEQUATE depth but its executable ask sat above the reservation (the
  // open was too EXPENSIVE, not too thin). Lets the report distinguish `center_ask_above_cap` from a real
  // `below_depth_floor` so the operator reads the right failure mode (F4) — diagnostic only; verdict unaffected.
  let priceBlocked = false;
  for (const b of buckets) {
    if (b.idx === modeIdx) modeLabel = b.label;
    if (Math.abs(b.idx - modeIdx) > cfg.centerHalfWidth) continue;
    if (!fin(b.houseProb)) continue;
    if (!fin(b.execAsk) || b.execAsk <= 0) continue; // a positive executable ask (CORE2-1 parity)
    const reservation = Math.min(cfg.maxEntryPrice, b.houseProb - cfg.entryEdgeMargin);
    if (!(b.execAsk <= reservation)) {
      if (b.depthUsd >= cfg.depthFloorUsd) priceBlocked = true; // deep enough, but priced out of the cap
      continue; // ask_above_reservation — selectEntries would reject it
    }
    if (b.depthUsd > maxDepthUsd) maxDepthUsd = b.depthUsd;
  }
  return { maxDepthUsd, modeLabel, priceBlocked };
}

/**
 * The center band's EXIT liquidity at this capture — the deepest sellable $ (sellbackDepthUsd, the −10% bid band)
 * among the mode ± centerHalfWidth buckets carrying a houseProb. The round-trip's OTHER half, logged so we can see
 * whether the open already has bid-side depth to exit into. NOTE: the real exit is LATER, into the convergence —
 * the paper backtest (Phase 3) replays the full per-tick sellback walk; this is the at-open snapshot, informational
 * only (NOT a pass gate — gating entry on exit-depth-at-open would wrongly reject a thin-but-soon-liquid open).
 */
export function sellbackDepth(buckets: OpeningBucket[], modeIdx: number, cfg: BotConfig): number {
  if (modeIdx < 0) return 0;
  let maxSellbackUsd = 0;
  for (const b of buckets) {
    if (Math.abs(b.idx - modeIdx) > cfg.centerHalfWidth) continue;
    if (!fin(b.houseProb)) continue;
    if (b.sellbackDepthUsd > maxSellbackUsd) maxSellbackUsd = b.sellbackDepthUsd;
  }
  return maxSellbackUsd;
}

/** One event's spike read. `reachedSeed=false` means the dist NEVER materialized (a signal-availability miss). */
export interface EventSpikeResult {
  eventId: string;
  city: string;
  targetDate: string;
  /** did the event ever reach a usable house_gaussian (first-house-dist)? */
  reachedSeed: boolean;
  /** hoursSinceListing at first-house-dist (the seed's age vs the listing anchor). */
  firstSeededAgeH: number | null;
  /** peakMid at first-house-dist (the flat-open measure). */
  peakMidAtSeed: number | null;
  /** isFlatOpen.flat at first-house-dist (null when never seeded). */
  flat: boolean | null;
  /** the mode bucket's label. */
  modeLabel: string | null;
  /** deepest enterable center bucket $ (see centerDepth). */
  centerDepthUsd: number | null;
  /** center-band EXIT liquidity at the open (deepest sellbackDepthUsd) — the round-trip's other half, informational. */
  exitDepthUsd: number | null;
  /** still-flat-open AND a center bucket clears the depth floor. */
  pass: boolean;
  /** isFlatOpen.reasons[] (or ['never_seeded']). */
  reasons: string[];
}

export interface SpikeResult {
  nCaptures: number;
  /** distinct events seen in the window. */
  nEvents: number;
  /** events that reached first-house-dist (the GO-fraction denominator). */
  nSeededEvents: number;
  /** capture rows dropped because they carried no eventId (cannot form a coherent series). */
  nDroppedNoEventId: number;
  /** nSeededEvents / nEvents — how often a usable dist ever materializes at all. */
  seededCoverage: number;
  /** seeded events that PASS (flat-open + cheap center depth). */
  nPass: number;
  /** nPass / nSeededEvents. */
  goFraction: number;
  /** Wilson 95% score-interval bounds on goFraction (transparency at low N — TEST2-2). */
  goCiLow: number;
  goCiHigh: number;
  /** max(capturedAt) − min(capturedAt) in days. */
  spanDays: number;
  /** count of DISTINCT UTC capture-days — the ≥1-week sufficiency gate (TEST2-6). */
  nCaptureDays: number;
  events: EventSpikeResult[];
}

/** Wilson score interval (95%, z=1.96) for a binomial proportion — robust at small n, unlike normal approx. */
export function wilson95(successes: number, n: number): { low: number; high: number } {
  if (!(n > 0)) return { low: NaN, high: NaN };
  const z = 1.96;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * The pure spike: group captures by event, pick each event's first-house-dist capture, and measure
 * still-flat-open + cheap-center-depth. Side-effect-free + total (junk → empty/NaN, never throws).
 */
export function runSpike(rows: RawCaptureRow[], cfg: BotConfig): SpikeResult {
  const captures = Array.isArray(rows) ? rows : [];
  const nCaptures = captures.length;

  // capture span (days) + the count of DISTINCT UTC capture-days, in ONE pass. The sufficiency gate uses the
  // distinct-day count (TEST2-6): spanDays = max−min would let a single stray old row + a one-day burst clear
  // "≥1 week" while holding ~1 day of real data. NOTE: do NOT spread the timestamp array into Math.max(...)/
  // Math.min(...) — V8 throws RangeError (call-stack) above ~10^5 elements, and this spike runs over a FULL
  // multi-week panel (~10^4 rows/day), so the crash would suppress the verdict entirely (F1). The day key is
  // forced to UTC via toISOString (offset-free — F2; a raw string slice follows the session tz at midnight).
  let tMin = Number.POSITIVE_INFINITY;
  let tMax = Number.NEGATIVE_INFINITY;
  let nFiniteTimes = 0;
  const dayKeys = new Set<string>();
  for (const c of captures) {
    const t = Date.parse(c.capturedAt);
    if (!Number.isFinite(t)) continue;
    nFiniteTimes++;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
    dayKeys.add(new Date(t).toISOString().slice(0, 10));
  }
  const spanDays = nFiniteTimes >= 2 ? (tMax - tMin) / 86_400_000 : 0;
  const nCaptureDays = dayKeys.size;

  // group by eventId (rows with no eventId cannot form a coherent series — counted + skipped)
  const byEvent = new Map<string, RawCaptureRow[]>();
  let nDroppedNoEventId = 0;
  for (const c of captures) {
    const id = c.eventId == null ? '' : String(c.eventId).trim();
    if (!id) {
      nDroppedNoEventId++;
      continue;
    }
    const arr = byEvent.get(id) ?? [];
    arr.push(c);
    byEvent.set(id, arr);
  }

  const events: EventSpikeResult[] = [];
  for (const [eventId, capsRaw] of byEvent) {
    const caps = [...capsRaw].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    const meta = caps[0]!; // earliest capture — fallback identity for a never-seeded event

    // the FIRST capture (earliest captured_at) at which a usable house_gaussian exists, PREFERRING one whose
    // houseProb actually aligned to a bucket (modeIdxOf ≥ 0). A capture can be houseSeeded=true yet carry no
    // aligned per-bucket houseProb (a W6 label mismatch) → modeIdx −1 → it would score FAIL even if a slightly
    // later capture aligns and PASSes. Preferring an aligned capture removes that conservative false-NO-GO
    // (TEST2-7); we fall back to a seed-flag-only capture so a never-aligned event is still scored (not dropped).
    let firstSeeded: OpeningCapture | null = null;
    let firstFlagOnly: OpeningCapture | null = null;
    for (const raw of caps) {
      const cap = mapCapture(raw);
      if (!hasUsableHouse(cap)) continue;
      if (modeIdxOf(cap.buckets) >= 0) {
        firstSeeded = cap;
        break;
      }
      if (!firstFlagOnly) firstFlagOnly = cap;
    }
    firstSeeded = firstSeeded ?? firstFlagOnly;

    if (!firstSeeded) {
      // the dist NEVER materialized for this event — itself a signal-availability failure.
      events.push({
        eventId,
        city: String(meta.city ?? ''),
        targetDate: String(meta.targetDate ?? ''),
        reachedSeed: false,
        firstSeededAgeH: null,
        peakMidAtSeed: null,
        flat: null,
        modeLabel: null,
        centerDepthUsd: null,
        exitDepthUsd: null,
        pass: false,
        reasons: ['never_seeded'],
      });
      continue;
    }

    const fo = isFlatOpen(firstSeeded, cfg);
    const modeIdx = modeIdxOf(firstSeeded.buckets);
    const { maxDepthUsd, modeLabel, priceBlocked } = centerDepth(firstSeeded.buckets, modeIdx, cfg);
    const exitUsd = sellbackDepth(firstSeeded.buckets, modeIdx, cfg);
    const hasCheapDepth = maxDepthUsd >= cfg.depthFloorUsd;
    const reasons = [...fo.reasons];
    if (!hasCheapDepth) reasons.push(modeIdx < 0 ? 'no_house_prob' : priceBlocked ? 'center_ask_above_cap' : 'below_depth_floor');

    events.push({
      eventId,
      city: firstSeeded.city,
      targetDate: firstSeeded.targetDate,
      reachedSeed: true,
      firstSeededAgeH: fin(firstSeeded.hoursSinceListing) ? firstSeeded.hoursSinceListing : null,
      peakMidAtSeed: Number.isFinite(fo.peakMid) ? fo.peakMid : null,
      flat: fo.flat,
      modeLabel,
      centerDepthUsd: maxDepthUsd,
      exitDepthUsd: exitUsd,
      pass: fo.flat && hasCheapDepth,
      reasons,
    });
  }

  events.sort((a, b) => a.city.localeCompare(b.city) || a.targetDate.localeCompare(b.targetDate));

  const nEvents = byEvent.size;
  const seeded = events.filter((e) => e.reachedSeed);
  const nSeededEvents = seeded.length;
  const nPass = seeded.filter((e) => e.pass).length;
  const seededCoverage = nEvents > 0 ? nSeededEvents / nEvents : NaN;
  const goFraction = nSeededEvents > 0 ? nPass / nSeededEvents : NaN;
  const { low: goCiLow, high: goCiHigh } = nSeededEvents > 0 ? wilson95(nPass, nSeededEvents) : { low: NaN, high: NaN };

  return {
    nCaptures, nEvents, nSeededEvents, nDroppedNoEventId, seededCoverage, nPass, goFraction,
    goCiLow, goCiHigh, spanDays, nCaptureDays, events,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// the frozen verdict
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type SpikeLabel = 'GO' | 'NO-GO' | 'INSUFFICIENT_DATA';

/** GO iff goFraction ≥ cfg.spikeGoFrac over a ≥1-week / ≥MIN_SPIKE_EVENTS panel; else NO-GO (KILL); else INSUFFICIENT. */
export function spikeVerdict(res: SpikeResult, cfg: BotConfig): { label: SpikeLabel; reason: string } {
  const bar = cfg.spikeGoFrac;

  if (res.nCaptures === 0) {
    return {
      label: 'INSUFFICIENT_DATA',
      reason:
        'INSUFFICIENT_DATA — opening_captures is EMPTY in the look-back window. This spike is run AFTER ≥1 week ' +
        'of Phase-0 capture; confirm the */2-min opening-capture cron + edge fn are live and accruing rows, then re-run.',
    };
  }
  if (res.nCaptureDays < MIN_SPIKE_DAYS) {
    return {
      label: 'INSUFFICIENT_DATA',
      reason:
        `INSUFFICIENT_DATA — captures land on only ${res.nCaptureDays} distinct days (< ${MIN_SPIKE_DAYS}; span ` +
        `${res.spanDays.toFixed(1)}d). The spike needs ≥1 week of real, day-spread captures (a stray old row + a one-day ` +
        'burst would game a raw span), so keep the capture cron running and re-run later.',
    };
  }
  if (res.nSeededEvents < MIN_SPIKE_EVENTS) {
    return {
      label: 'INSUFFICIENT_DATA',
      reason:
        `INSUFFICIENT_DATA — only ${res.nSeededEvents} events reached a usable house_gaussian (< ${MIN_SPIKE_EVENTS}); ` +
        `${res.nEvents} distinct events seen, seeded coverage ${pct(res.seededCoverage)}. Too few to estimate a GO fraction — ` +
        'either the §9R universe is too quiet or the on-demand seed path is failing (check capture_deadman / seeded fraction). ' +
        'Let more captures accrue before judging the signal.',
    };
  }

  // Low COVERAGE = a usable house_gaussian never materialized AT ALL for most listed markets (the dist pipeline
  // doesn't reach them) — distinct from the after-convergence case, which keeps coverage high but lowers the GO
  // fraction (handled below). The GO fraction excludes never-seeded events, so a high fraction over a thin seeded
  // minority would FALSE-GO; broad coverage is therefore required for a GO.
  if (res.seededCoverage < MIN_SEEDED_COVERAGE) {
    return {
      label: 'NO-GO',
      reason:
        `NO-GO — KILL the lever. Only ${res.nSeededEvents}/${res.nEvents} (${pct(res.seededCoverage)}) of distinct listed ` +
        `events EVER produced a usable house_gaussian — below the ${pct(MIN_SEEDED_COVERAGE)} coverage floor (the ` +
        `${pct(res.goFraction)} goFraction is over that unrepresentative seeded minority). For most listed markets the forecast ` +
        'dist never materialized at all, so there is nothing to enter — the opening signal is not broadly available. Before ' +
        'accepting this KILL, confirm capture_deadman did NOT fire on a seeded-fraction collapse (which would mean a ' +
        'seed-pipeline bug, not signal absence). Otherwise KILL opening-convergence cheaply HERE; update FINDINGS.md. The other ' +
        'eleven signals stay dead — this makes twelve.',
    };
  }

  // The GO/NO-GO bar is a point estimate; surface the Wilson 95% interval so the low-N fragility is visible at the
  // decision point (TEST2-2). NOTE: this gate authorizes BUILDING Phases 2–6, not capital — the §9R-E openingVerdict
  // net-profit gate (≥40 markets, clustered CI + zero-skill MC) is the money gate — so a point bar here is acceptable,
  // and a false-GO costs build effort, not capital. The CI is informational, not a second hard gate.
  const ci = `Wilson 95% CI [${pct(res.goCiLow)}, ${pct(res.goCiHigh)}]`;
  if (res.goFraction >= bar) {
    return {
      label: 'GO',
      reason:
        `GO — ${res.nPass}/${res.nSeededEvents} (${pct(res.goFraction)}, ${ci}) of seeded events were STILL flat-open ` +
        `(peak ≤ ${pct(cfg.peakMidMax)}, ≤ ${cfg.listingMaxHours}h since listing) AND carried a cheap, EXECUTABLE center ` +
        `bucket (ask ≤ the entry reservation) with depth ≥ $${cfg.depthFloorUsd} at first house_gaussian — at/above the ` +
        `${pct(bar)} go bar, with ${pct(res.seededCoverage)} seed coverage (≥ ${pct(MIN_SEEDED_COVERAGE)} floor). The opening ` +
        'signal IS available at executable depth while the book is still flat-open (R-13 cleared). Phases 2–6 are authorized — ' +
        `build the paper executor next${res.goCiLow < bar ? ' (note the CI lower bound is below the bar — N is still thin; the §9R-E net-profit gate remains the capital backstop)' : ''}. ` +
        'Capital is still gated separately by the §9R-E openingVerdict net-profit gate.',
    };
  }
  return {
    label: 'NO-GO',
    reason:
      `NO-GO — KILL the lever. Only ${res.nPass}/${res.nSeededEvents} (${pct(res.goFraction)}, ${ci}) of seeded events were ` +
      `still flat-open with cheap, executable center depth at first house_gaussian — below the ${pct(bar)} go bar (seed coverage ` +
      `${pct(res.seededCoverage)}). The forecast signal is NOT reliably available while the book is still flat-open (R-13 ` +
      'confirmed): by the time a usable dist exists, the book has already converged, so there is nothing to buy cheap. KILL ' +
      'opening-convergence cheaply HERE, before building the execution stack; update FINDINGS.md. The other eleven signals ' +
      'stay dead — this makes twelve.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// report
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function report(res: SpikeResult, cfg: BotConfig, log: (m: string) => void): void {
  log('=== opening-spike · Phase-0.5 signal-availability go/no-go (gates Phases 2–6) ===');
  log(
    `captures ${res.nCaptures} · distinct events ${res.nEvents} · ${res.nCaptureDays} capture-days (span ${res.spanDays.toFixed(1)}d)` +
      (res.nDroppedNoEventId ? ` · ${res.nDroppedNoEventId} rows dropped (null eventId)` : ''),
  );
  log(
    `gate cfg: peakMidMax ${pct(cfg.peakMidMax)} · listingMaxHours ${cfg.listingMaxHours} · ` +
      `centerHalfWidth ±${cfg.centerHalfWidth} · depthFloor $${cfg.depthFloorUsd} · spikeGoFrac ${pct(cfg.spikeGoFrac)}`,
  );
  log('');
  log('PER-EVENT — first capture with a usable house_gaussian (ctrDepth = deepest ENTERABLE center bucket $ [buy side];');
  log('  exitDep = deepest center sellback $ [sell side, the round-trip\'s other half — informational, not a pass gate]):');
  log(
    `  ${'city'.padEnd(14)} ${'targetDate'.padEnd(10)}  ${'seedAgeH'.padStart(8)}  ${'peakMid'.padStart(7)}  ` +
      `${'flat'.padStart(4)}  ${'mode'.padEnd(10)}  ${'ctrDepth'.padStart(9)}  ${'exitDep'.padStart(8)}  result`,
  );
  for (const e of res.events) {
    if (!e.reachedSeed) {
      log(
        `  ${e.city.padEnd(14)} ${e.targetDate.padEnd(10)}  ${'—'.padStart(8)}  ${'—'.padStart(7)}  ` +
          `${'—'.padStart(4)}  ${'—'.padEnd(10)}  ${'—'.padStart(9)}  ${'—'.padStart(8)}  NEVER SEEDED`,
      );
      continue;
    }
    const ageH = e.firstSeededAgeH == null ? '—' : e.firstSeededAgeH.toFixed(2);
    const result = e.pass ? 'PASS' : `·  [${e.reasons.join(',')}]`;
    log(
      `  ${e.city.padEnd(14)} ${e.targetDate.padEnd(10)}  ${ageH.padStart(8)}  ${pct(e.peakMidAtSeed ?? NaN).padStart(7)}  ` +
        `${(e.flat ? 'yes' : 'no').padStart(4)}  ${(e.modeLabel ?? '—').padEnd(10).slice(0, 10)}  ` +
        `${usd(e.centerDepthUsd ?? NaN).padStart(9)}  ${usd(e.exitDepthUsd ?? NaN).padStart(8)}  ${result}`,
    );
  }
  log('');
  log('=== READ ===');
  log(
    `  seeded coverage: ${res.nSeededEvents}/${res.nEvents} distinct events ever reached a usable house_gaussian (${pct(res.seededCoverage)})`,
  );
  log('    └─ an event that never produced a usable dist AT ALL is a signal miss (low coverage → NO-GO); a usable-but-LATE');
  log('       dist instead lowers the GO fraction below — the two failure modes are distinct.');
  log(
    `  GO fraction: ${res.nPass}/${res.nSeededEvents} seeded events still-flat-open WITH cheap, executable center depth = ` +
      `${pct(res.goFraction)}  (Wilson 95% CI [${pct(res.goCiLow)}, ${pct(res.goCiHigh)}]; go bar = spikeGoFrac ${pct(cfg.spikeGoFrac)})`,
  );
  log('');
  const v = spikeVerdict(res, cfg);
  log(`VERDICT: ${v.label}`);
  log(`  ${v.reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DB I/O (the only impure surface — read-only)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The operational cfg (code defaults + the 0066 `bot.*` mirror) via the shared parser. */
export async function loadCfg(db: Db): Promise<BotConfig> {
  const rows = await db.query<{ key: string; value: string | null }>('select key, value from config');
  return parseBotConfig(rows);
}

/** The full ordered capture series over the look-back window. bot_capture_series returns a jsonb OBJECT
 *  { rows: [...] } (never a top-level array — the 0044 port-misread trap); read .rows. Empty on no rows. */
export async function loadSeries(db: Db, days: number): Promise<RawCaptureRow[]> {
  const out = await db.query<{ series: { rows: RawCaptureRow[] } | null }>('select public.bot_capture_series($1) as series', [
    Math.max(1, Math.floor(days)),
  ]);
  const series = out[0]?.series?.rows;
  return Array.isArray(series) ? series : [];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// self-test (runs on CLI invocation, like the other research spines — no DB, no network)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function sanity(): void {
  const cfg = parseBotConfig([]); // BOT_DEFAULTS: peakMidMax 0.18, listingMaxHours 1, centerHalfWidth 1, depthFloor 50, spikeGoFrac 0.5
  const bucket = (idx: number, mid: number, houseProb: number | null, depthUsd: number): RawBucket => ({
    idx,
    label: `b${idx}`,
    loF: idx,
    hiF: idx + 1,
    mid,
    bestAsk: mid,
    execAsk: mid,
    depthUsd,
    bestBid: mid,
    sellbackUsd: depthUsd,
    execBid: mid,
    sellbackDepthUsd: depthUsd,
    houseProb,
    tokenYes: `y${idx}`,
    tokenNo: `n${idx}`,
    conditionId: `c${idx}`,
  });
  const cap = (
    over: Partial<RawCaptureRow> & { eventId: string; capturedAt: string },
  ): RawCaptureRow => ({
    city: 'amsterdam',
    targetDate: '2026-07-01',
    tzName: 'Europe/Amsterdam',
    createdAtGamma: null,
    resolvesAt: null,
    hoursSinceListing: 0.5,
    peakMid: null,
    isFlatOpen: null,
    houseSeeded: false,
    buckets: null,
    evVol24h: 9000,
    negRisk: true,
    ...over,
  });

  // Event A: cap1 unseeded (flat, no houseProb) then cap2 seeded, still flat (mids 0.10), mode idx 2, depth 100 ≥ 50 → PASS
  const flatMids = [bucket(0, 0.1, null, 0), bucket(1, 0.11, null, 0), bucket(2, 0.1, null, 0)];
  const seededFlat = [bucket(1, 0.1, 0.2, 60), bucket(2, 0.11, 0.5, 100), bucket(3, 0.1, 0.2, 70)];
  const A1 = cap({ eventId: 'A', capturedAt: '2026-07-01T00:00:00Z', buckets: flatMids, hoursSinceListing: 0.2 });
  const A2 = cap({ eventId: 'A', capturedAt: '2026-07-01T00:30:00Z', buckets: seededFlat, houseSeeded: true, hoursSinceListing: 0.8 });
  // Event B: seeded but already converged (a 0.40 mid > peakMidMax) → not flat → FAIL
  const B = cap({ eventId: 'B', capturedAt: '2026-07-02T00:00:00Z', houseSeeded: true, hoursSinceListing: 0.5, buckets: [bucket(1, 0.4, 0.6, 100), bucket(2, 0.1, 0.2, 100)] });
  // Event C: seeded, flat, but the center band depth is below floor (10 < 50) → FAIL
  const C = cap({ eventId: 'C', capturedAt: '2026-07-03T00:00:00Z', houseSeeded: true, hoursSinceListing: 0.5, buckets: [bucket(1, 0.1, 0.5, 10), bucket(2, 0.1, 0.2, 10)] });
  // Event D: never seeds (no flag, no houseProb) → reachedSeed=false (lowers coverage, not the GO denominator)
  const D = cap({ eventId: 'D', capturedAt: '2026-07-04T00:00:00Z', buckets: flatMids });

  const res = runSpike([A1, A2, B, C, D], cfg);
  if (res.nEvents !== 4) throw new Error(`sanity: nEvents ${res.nEvents} != 4`);
  if (res.nSeededEvents !== 3) throw new Error(`sanity: nSeededEvents ${res.nSeededEvents} != 3`);
  if (res.nPass !== 1) throw new Error(`sanity: nPass ${res.nPass} != 1`);
  if (Math.abs(res.goFraction - 1 / 3) > 1e-9) throw new Error(`sanity: goFraction ${res.goFraction} != 1/3`);
  if (Math.abs(res.seededCoverage - 3 / 4) > 1e-9) throw new Error(`sanity: seededCoverage ${res.seededCoverage} != 3/4`);
  const evA = res.events.find((e) => e.eventId === 'A')!;
  if (!evA.pass || evA.modeLabel !== 'b2' || evA.centerDepthUsd !== 100) {
    throw new Error(`sanity: event A wrong: ${JSON.stringify(evA)}`);
  }
  const evD = res.events.find((e) => e.eventId === 'D')!;
  if (evD.reachedSeed || evD.reasons[0] !== 'never_seeded') throw new Error('sanity: event D should be never-seeded');

  // verdict label transitions (build SpikeResult literals so we don't need a big panel)
  const base: SpikeResult = { ...res, nSeededEvents: 10, spanDays: 8, nCaptureDays: 8 };
  if (spikeVerdict({ ...base, nPass: 6, goFraction: 0.6 }, cfg).label !== 'GO') throw new Error('sanity: 0.6 should GO');
  if (spikeVerdict({ ...base, nPass: 4, goFraction: 0.4 }, cfg).label !== 'NO-GO') throw new Error('sanity: 0.4 should NO-GO');
  // low seed coverage (most listed events never produce a usable dist at all) → NO-GO even if the seeded subset passes
  if (spikeVerdict({ ...base, nEvents: 100, nSeededEvents: 10, seededCoverage: 0.1, nPass: 9, goFraction: 0.9 }, cfg).label !== 'NO-GO') {
    throw new Error('sanity: low coverage should NO-GO');
  }
  if (spikeVerdict({ ...base, nCaptureDays: 3 }, cfg).label !== 'INSUFFICIENT_DATA') throw new Error('sanity: <1wk should be INSUFFICIENT');
  if (spikeVerdict({ ...res, nCaptures: 0 }, cfg).label !== 'INSUFFICIENT_DATA') throw new Error('sanity: empty should be INSUFFICIENT');
  if (spikeVerdict(res, cfg).label !== 'INSUFFICIENT_DATA') throw new Error('sanity: 3 seeded events should be INSUFFICIENT');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({ options: { days: { type: 'string' } } });
  const days = Math.max(1, Math.floor(Number(values.days ?? 8) || 8));
  const db = makeScriptDb();
  try {
    process.stderr.write(
      `opening-spike · ${new Date().toISOString()} · reading bot_capture_series(${days}) — read-only; places NOTHING, writes NOTHING\n`,
    );
    const cfg = await loadCfg(db);
    const series = await loadSeries(db, days);
    process.stderr.write(`  ${series.length} capture rows over the last ${days}d\n`);
    const res = runSpike(series, cfg);
    report(res, cfg, console.log);
  } finally {
    await db.end();
  }
}
