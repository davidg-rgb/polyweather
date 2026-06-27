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
 * The deepest enterable forecast-center bucket. Mirrors `selectEntries` (§6.2): a candidate bucket is within
 * mode ± centerHalfWidth AND carries a houseProb; the per-bucket depth floor is what gates entry, so the
 * signal-availability question is whether ANY such center bucket clears the floor → report the MAX depth.
 */
export function centerDepth(
  buckets: OpeningBucket[],
  modeIdx: number,
  centerHalfWidth: number,
): { maxDepthUsd: number; modeLabel: string | null } {
  if (modeIdx < 0) return { maxDepthUsd: 0, modeLabel: null };
  let maxDepthUsd = 0;
  let modeLabel: string | null = null;
  for (const b of buckets) {
    if (b.idx === modeIdx) modeLabel = b.label;
    if (Math.abs(b.idx - modeIdx) <= centerHalfWidth && fin(b.houseProb)) {
      if (b.depthUsd > maxDepthUsd) maxDepthUsd = b.depthUsd;
    }
  }
  return { maxDepthUsd, modeLabel };
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
  /** max(capturedAt) − min(capturedAt) in days. */
  spanDays: number;
  events: EventSpikeResult[];
}

/**
 * The pure spike: group captures by event, pick each event's first-house-dist capture, and measure
 * still-flat-open + cheap-center-depth. Side-effect-free + total (junk → empty/NaN, never throws).
 */
export function runSpike(rows: RawCaptureRow[], cfg: BotConfig): SpikeResult {
  const captures = Array.isArray(rows) ? rows : [];
  const nCaptures = captures.length;

  // capture span (days) over the whole window — the ≥1-week sufficiency input
  const times = captures.map((c) => Date.parse(c.capturedAt)).filter((t) => Number.isFinite(t));
  const spanDays = times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / 86_400_000 : 0;

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

    // the FIRST capture (earliest captured_at) at which a usable house_gaussian exists
    let firstSeeded: OpeningCapture | null = null;
    for (const raw of caps) {
      const cap = mapCapture(raw);
      if (hasUsableHouse(cap)) {
        firstSeeded = cap;
        break;
      }
    }

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
        pass: false,
        reasons: ['never_seeded'],
      });
      continue;
    }

    const fo = isFlatOpen(firstSeeded, cfg);
    const modeIdx = modeIdxOf(firstSeeded.buckets);
    const { maxDepthUsd, modeLabel } = centerDepth(firstSeeded.buckets, modeIdx, cfg.centerHalfWidth);
    const hasCheapDepth = maxDepthUsd >= cfg.depthFloorUsd;
    const reasons = [...fo.reasons];
    if (!hasCheapDepth) reasons.push(modeIdx < 0 ? 'no_house_prob' : 'below_depth_floor');

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

  return { nCaptures, nEvents, nSeededEvents, nDroppedNoEventId, seededCoverage, nPass, goFraction, spanDays, events };
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
  if (res.spanDays < MIN_SPIKE_DAYS) {
    return {
      label: 'INSUFFICIENT_DATA',
      reason:
        `INSUFFICIENT_DATA — only ${res.spanDays.toFixed(1)} days of capture span (< ${MIN_SPIKE_DAYS}). The spike needs ` +
        '≥1 week of real captures; keep the capture cron running and re-run later (raise --days if older rows exist).',
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

  if (res.goFraction >= bar) {
    return {
      label: 'GO',
      reason:
        `GO — ${res.nPass}/${res.nSeededEvents} (${pct(res.goFraction)}) of seeded events were STILL flat-open ` +
        `(peak ≤ ${pct(cfg.peakMidMax)}, ≤ ${cfg.listingMaxHours}h since listing) AND carried a cheap center bucket ` +
        `with depth ≥ $${cfg.depthFloorUsd} at first house_gaussian — at/above the ${pct(bar)} go bar. The opening ` +
        'signal IS available at executable depth while the book is still flat-open (R-13 cleared). Phases 2–6 are ' +
        'authorized — build the paper executor next. Capital is still gated separately by the §9R-E openingVerdict net-profit gate.',
    };
  }
  return {
    label: 'NO-GO',
    reason:
      `NO-GO — KILL the lever. Only ${res.nPass}/${res.nSeededEvents} (${pct(res.goFraction)}) of seeded events were ` +
      `still flat-open with cheap center depth at first house_gaussian — below the ${pct(bar)} go bar. The forecast ` +
      'signal is NOT reliably available while the book is still flat-open (R-13 confirmed): by the time a usable dist ' +
      'exists, the book has already converged, so there is nothing to buy cheap. KILL opening-convergence cheaply HERE, ' +
      'before building the execution stack; update FINDINGS.md. The other eleven signals stay dead — this makes twelve.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// report
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function report(res: SpikeResult, cfg: BotConfig, log: (m: string) => void): void {
  log('=== opening-spike · Phase-0.5 signal-availability go/no-go (gates Phases 2–6) ===');
  log(
    `captures ${res.nCaptures} · distinct events ${res.nEvents} · capture span ${res.spanDays.toFixed(1)}d` +
      (res.nDroppedNoEventId ? ` · ${res.nDroppedNoEventId} rows dropped (null eventId)` : ''),
  );
  log(
    `gate cfg: peakMidMax ${pct(cfg.peakMidMax)} · listingMaxHours ${cfg.listingMaxHours} · ` +
      `centerHalfWidth ±${cfg.centerHalfWidth} · depthFloor $${cfg.depthFloorUsd} · spikeGoFrac ${pct(cfg.spikeGoFrac)}`,
  );
  log('');
  log('PER-EVENT — first capture with a usable house_gaussian (ctrDepth = deepest enterable center bucket $; entry gates per-bucket):');
  log(
    `  ${'city'.padEnd(14)} ${'targetDate'.padEnd(10)}  ${'seedAgeH'.padStart(8)}  ${'peakMid'.padStart(7)}  ` +
      `${'flat'.padStart(4)}  ${'mode'.padEnd(10)}  ${'ctrDepth'.padStart(9)}  result`,
  );
  for (const e of res.events) {
    if (!e.reachedSeed) {
      log(
        `  ${e.city.padEnd(14)} ${e.targetDate.padEnd(10)}  ${'—'.padStart(8)}  ${'—'.padStart(7)}  ` +
          `${'—'.padStart(4)}  ${'—'.padEnd(10)}  ${'—'.padStart(9)}  NEVER SEEDED`,
      );
      continue;
    }
    const ageH = e.firstSeededAgeH == null ? '—' : e.firstSeededAgeH.toFixed(2);
    const result = e.pass ? 'PASS' : `·  [${e.reasons.join(',')}]`;
    log(
      `  ${e.city.padEnd(14)} ${e.targetDate.padEnd(10)}  ${ageH.padStart(8)}  ${pct(e.peakMidAtSeed ?? NaN).padStart(7)}  ` +
        `${(e.flat ? 'yes' : 'no').padStart(4)}  ${(e.modeLabel ?? '—').padEnd(10).slice(0, 10)}  ` +
        `${usd(e.centerDepthUsd ?? NaN).padStart(9)}  ${result}`,
    );
  }
  log('');
  log('=== READ ===');
  log(
    `  seeded coverage: ${res.nSeededEvents}/${res.nEvents} distinct events ever reached a usable house_gaussian (${pct(res.seededCoverage)})`,
  );
  log('    └─ an event that NEVER seeds is itself a signal miss — the dist must exist WHILE the book is still flat-open.');
  log(
    `  GO fraction: ${res.nPass}/${res.nSeededEvents} seeded events still-flat-open WITH cheap center depth = ` +
      `${pct(res.goFraction)}   (go bar = spikeGoFrac ${pct(cfg.spikeGoFrac)})`,
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

/** The full ordered capture series over the look-back window (jsonb array → typed rows). Empty on no rows. */
export async function loadSeries(db: Db, days: number): Promise<RawCaptureRow[]> {
  const rows = await db.query<{ series: RawCaptureRow[] | null }>('select public.bot_capture_series($1) as series', [
    Math.max(1, Math.floor(days)),
  ]);
  const series = rows[0]?.series;
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
  const base: SpikeResult = { ...res, nSeededEvents: 10, spanDays: 8 };
  if (spikeVerdict({ ...base, nPass: 6, goFraction: 0.6 }, cfg).label !== 'GO') throw new Error('sanity: 0.6 should GO');
  if (spikeVerdict({ ...base, nPass: 4, goFraction: 0.4 }, cfg).label !== 'NO-GO') throw new Error('sanity: 0.4 should NO-GO');
  if (spikeVerdict({ ...base, spanDays: 3 }, cfg).label !== 'INSUFFICIENT_DATA') throw new Error('sanity: <1wk should be INSUFFICIENT');
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
