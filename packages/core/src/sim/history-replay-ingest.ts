/**
 * core/sim/history-replay-ingest — the PURE bridge from the LOCAL price-history archive
 * (scripts/research/out/market-history/{city}/*.json, written by pull-market-history) into the EXISTING
 * bracket-replay engine (sim/opening-bracket-replay.ts). It exists so the 6 275-event / ~238 M-point archive
 * can drive the SAME `replayEvent`/`replayPanel` the live `opening_captures` capture drives — turning the
 * starved live panel (n≈2 enterable markets, OPENING-BRACKET-REPLAY.md) into the 708-event resolved panel the
 * §9R-E gate + a real out-of-sample split actually need, to TUNE the convergence bot's entry/exit thresholds.
 *
 * THE ONE LOAD-BEARING APPROXIMATION. The CLOB prices-history archive is MID-PRICE-ONLY (one implied-prob
 * point per bucket per minute) — it has no two-sided book, no depth, and no `house_gaussian` seed. This module
 * SYNTHESIZES a two-sided book from the mid via `CALIBRATED_BOOK` — a piecewise-by-mid spread + depth model fit
 * from the LIVE `opening_captures` (which carry BOTH the mid AND the real execAsk/execBid/depth), so the synth
 * is grounded, not guessed. Because it is still an approximation, the tuner SWEEPS a `spreadMult` over it and
 * reports the BREAKEVEN spread; the historical replay therefore measures the PRICE-PATH edge (does the
 * convergence re-rating exceed spread + fees), and DEFERS executable-depth-at-size to the live forward §9R-E
 * capture (the existing real-book gate). The `houseProb` seed is supplied EXTERNALLY by the harness from the
 * archived `bucket_probabilities` (the bot's REAL forecast, by event), so this module never reconstructs a
 * forecast — it only assembles the tick series the engine reads.
 *
 * Pure + total (junk → null / [] / NaN, never throws). Imports only sibling pure types — NEVER io/trading/fs.
 * The fs read (parse the archive JSON) lives in the harness; this module takes an already-parsed `ArchiveEvent`.
 */
import type { OpeningBucket } from './opening-convergence.ts';
import type { EventReplayInput, ReplayTick } from './opening-bracket-replay.ts';
import type { Resolution } from './opening-bracket-ingest.ts';
import { localHourInstant } from '../time.ts';

const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The archive shapes (pull-market-history's per-event JSON)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One bucket's MID-only price series from the local archive: [epochSec, impliedProbMid] points. */
export interface ArchiveBucket {
  idx: number;
  label: string | null;
  resolvedOutcome: 'win' | 'lose' | null;
  points: Array<[number, number]>;
}

/** One event's archive file (pull-market-history out/market-history/{city}/{date}__{eventId}.json). */
export interface ArchiveEvent {
  city: string;
  eventId: string;
  /** the archive's filename date = the RESOLUTION UTC date — NOT the weather day. Do not use for the
   *  time-stop; the harness passes the DB station-local `target_date` (the weather day) via BuildOpts.tz/date. */
  targetDate: string;
  createdAt: string | null;
  endDate: string;
  buckets: ArchiveBucket[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The calibrated synthetic-book model (CALIBRATED_BOOK)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One knot of the piecewise-by-mid book model: at implied-prob `mid`, the executable ASK sits `askOver` above
 * the mid and the executable BID `bidOver` below, and the §9R depth-walk carries ~`depthUsd`. Values between
 * knots are linearly interpolated; outside the range the nearest knot is held flat.
 */
export interface BookKnot {
  mid: number;
  askOver: number;
  bidOver: number;
  depthUsd: number;
}
export type BookModel = BookKnot[];

/**
 * CALIBRATED_BOOK — fit from the live `opening_captures` real books (median execAsk−mid, mid−execBid, depthUsd
 * by mid price-band; 8 000 recent capture rows × ~11 buckets, 2026-06-30). The cheap entry zone (mid 0.07–0.17)
 * is genuinely THIN and WIDE: ~3–4pp round-trip and only $4–$90 of walked depth — so a $50 depth floor already
 * excludes most sub-0.15 buckets, which is realistic, not a modeling artifact. Regenerate with
 * `scripts/research/calibrate-history-spread.ts` (re-run after a structural book change). The sub-0.07 regime
 * is held at the 0.07 knot (those buckets fail the depth floor regardless); the 1¢ tick floors execAsk anyway.
 */
export const CALIBRATED_BOOK: BookModel = [
  { mid: 0.07, askOver: 0.04, bidOver: 0.022, depthUsd: 4 },
  { mid: 0.12, askOver: 0.018, bidOver: 0.019, depthUsd: 24 },
  { mid: 0.17, askOver: 0.015, bidOver: 0.014, depthUsd: 93 },
  { mid: 0.23, askOver: 0.0125, bidOver: 0.011, depthUsd: 225 },
  { mid: 0.27, askOver: 0.01, bidOver: 0.01, depthUsd: 306 },
  { mid: 0.33, askOver: 0.01, bidOver: 0.01, depthUsd: 412 },
  { mid: 0.37, askOver: 0.01, bidOver: 0.01, depthUsd: 615 },
  { mid: 0.43, askOver: 0.005, bidOver: 0.005, depthUsd: 777 },
  { mid: 0.48, askOver: 0.005, bidOver: 0.005, depthUsd: 931 },
];

/** Linear-interpolate a knot field at `mid`, holding the nearest knot flat outside the modeled range. */
function interp(model: BookModel, mid: number, pick: (k: BookKnot) => number): number {
  const ks = model;
  if (ks.length === 0) return 0;
  if (mid <= ks[0]!.mid) return pick(ks[0]!);
  if (mid >= ks[ks.length - 1]!.mid) return pick(ks[ks.length - 1]!);
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1]!;
    const b = ks[i]!;
    if (mid <= b.mid) {
      const w = (mid - a.mid) / (b.mid - a.mid);
      return pick(a) + w * (pick(b) - pick(a));
    }
  }
  return pick(ks[ks.length - 1]!);
}

/** A synthesized two-sided book at one mid (null = degenerate mid that can't carry a fillable quote). */
export interface SynthQuote {
  mid: number;
  bestAsk: number;
  bestBid: number;
  execAsk: number;
  execBid: number;
  depthUsd: number;
  sellbackDepthUsd: number;
}

/**
 * Synthesize a two-sided book from a single mid via `model`, scaling the half-spreads by `spreadMult` (the
 * tuner's sensitivity / breakeven knob — 0 = a frictionless book, 1 = the calibrated spread, >1 = pessimistic).
 * The 1¢ tick floors execAsk at mid+0.01·spreadMult-ish via the model's askOver; execBid is floored at 0 and
 * capped at the mid. Depth is NOT scaled by spreadMult (it is a separate liquidity axis the harness sweeps via
 * depthFloorUsd). Returns null for a non-finite / ≤0 / ≥1 mid (no real quote).
 */
export function synthBook(mid: number, model: BookModel, spreadMult: number): SynthQuote | null {
  if (!fin(mid) || mid <= 0 || mid >= 1) return null;
  const m = Math.max(0, spreadMult);
  const askOver = interp(model, mid, (k) => k.askOver) * m;
  const bidOver = interp(model, mid, (k) => k.bidOver) * m;
  const depthUsd = Math.max(0, interp(model, mid, (k) => k.depthUsd));
  const execAsk = Math.min(0.999, mid + askOver);
  const execBid = Math.max(0, Math.min(mid, mid - bidOver));
  // bestAsk/bestBid mirror the walked exec prices (the live calibration showed BBO ≈ the walked quote in the
  // cheap entry zone); the maker model then rests at min(reservation, bestAsk) and fills when a later ask trades
  // through — the second-order BBO-vs-walked gap is immaterial to the net-edge question the tuner asks.
  return { mid, bestAsk: execAsk, bestBid: execBid, execAsk, execBid, depthUsd, sellbackDepthUsd: depthUsd };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// buildHistoryEvent — assemble one archive event into the engine's EventReplayInput
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface BuildOpts {
  /** the bot's REAL forecast seed by bucket idx (from archived `bucket_probabilities`); null-absent → unseeded. */
  houseProbByIdx: Map<number, number>;
  /** the authoritative resolution (DB market_events winner + grading_mismatch); winnerIdx null → fall back to
   *  the archive's own resolvedOutcome:'win' bucket. */
  resolution: Resolution;
  /** the station-local WEATHER DAY (DB market_events.target_date) — the time-stop calendar day (NOT the archive
   *  filename date, which is the resolution UTC date). */
  targetDate: string;
  /** the city IANA tz NAME (DB cities.tz) — the DST-correct local-noon time-stop. */
  tz: string;
  /** the spread/depth model (default CALIBRATED_BOOK). */
  model?: BookModel;
  /** the half-spread sensitivity multiplier (default 1 = calibrated). */
  spreadMult?: number;
  /** downsample the per-minute series to one tick per this many minutes (default 10). */
  sampleEveryMin?: number;
  /** the listing anchor ms (DB created_at_gamma); null → the earliest archive point (hoursSinceListing from it). */
  createdAtMs?: number | null;
  /**
   * Drop ticks AFTER station-local `trimAtLocalHour` o'clock on the weather day — a VERDICT-PRESERVING speedup:
   * every position flattens at the local-noon time-stop (≤ timeStopLocalHour, the max swept here is 16), so the
   * long post-weather-day tail of the archived series (often 12–24h running to the next-morning resolution) never
   * touches an entry/exit DECISION or the realized P&L — it only inflates the report-only ceiling pass and the
   * allocation. Keep a margin above the max time-stop (default 20:00 local). Unset = keep the full series. A tz
   * that fails the IANA guard → no trim (fail open; correctness over speed).
   */
  trimAtLocalHour?: number | null;
}

/** last point with t ≤ ts (the mid in force at ts); null if ts precedes the bucket's first point. */
function midAt(points: Array<[number, number]>, ts: number): number | null {
  let best: number | null = null;
  for (const [t, p] of points) {
    if (t <= ts) best = p;
    else break;
  }
  return best;
}

/**
 * Convert ONE parsed archive event into an `EventReplayInput` the bracket engine reads. Pure + total.
 *
 *  - Resamples every bucket's mid series onto a shared grid (one tick / `sampleEveryMin` min) from the first
 *    point to the last, carrying the last-known mid forward (a real book holds its last quote between trades).
 *  - At each tick, synthesizes the two-sided book per bucket (`synthBook`) and attaches the external `houseProb`.
 *  - `hoursSinceListing` is computed from `createdAtMs` (or the first point) so selectEntries' finite-age gate +
 *    the (replay-disabled) flat-open age gate see a real number.
 *  - Returns null if the event has no usable buckets/points (the harness drops it).
 */
export function buildHistoryEvent(ev: ArchiveEvent, opts: BuildOpts): EventReplayInput | null {
  if (!ev || !Array.isArray(ev.buckets)) return null;
  const model = opts.model ?? CALIBRATED_BOOK;
  const spreadMult = opts.spreadMult ?? 1;
  const stepMs = Math.max(1, Math.floor(opts.sampleEveryMin ?? 10)) * 60_000;

  const withPts = ev.buckets.filter((b) => Array.isArray(b.points) && b.points.length > 0);
  if (withPts.length === 0) return null;

  // shared time grid: [minFirst, maxLast] across buckets, stepped at the sample cadence (epoch ms).
  let t0 = Number.POSITIVE_INFINITY;
  let tEnd = Number.NEGATIVE_INFINITY;
  for (const b of withPts) {
    t0 = Math.min(t0, b.points[0]![0]);
    tEnd = Math.max(tEnd, b.points[b.points.length - 1]![0]);
  }
  if (!Number.isFinite(t0) || !Number.isFinite(tEnd) || tEnd < t0) return null;
  const startMs = t0 * 1000;
  let endMs = tEnd * 1000;
  const createdMs = fin(opts.createdAtMs) ? opts.createdAtMs : startMs;

  // verdict-preserving trim: cap the grid at station-local `trimAtLocalHour` of the weather day (all time-stops
  // fire below it). Fail open on a bad tz (keep the full series rather than risk dropping a needed time-stop tick).
  if (fin(opts.trimAtLocalHour)) {
    try {
      const cutMs = localHourInstant(opts.tz, opts.targetDate, Math.round(opts.trimAtLocalHour)).getTime();
      if (Number.isFinite(cutMs) && cutMs > startMs) endMs = Math.min(endMs, cutMs);
    } catch {
      /* bad tz — no trim */
    }
  }

  const ticks: ReplayTick[] = [];
  for (let ms = startMs; ms <= endMs; ms += stepMs) {
    const ts = Math.floor(ms / 1000);
    const buckets: OpeningBucket[] = [];
    for (const b of ev.buckets) {
      const mid = Array.isArray(b.points) && b.points.length > 0 ? midAt(b.points, ts) : null;
      const q = mid == null ? null : synthBook(mid, model, spreadMult);
      buckets.push({
        idx: b.idx,
        label: String(b.label ?? ''),
        loF: null,
        hiF: null,
        mid: q ? q.mid : null,
        bestAsk: q ? q.bestAsk : null,
        execAsk: q ? q.execAsk : null,
        depthUsd: q ? q.depthUsd : 0,
        bestBid: q ? q.bestBid : null,
        sellbackUsd: q ? q.depthUsd : 0,
        execBid: q ? q.execBid : null,
        sellbackDepthUsd: q ? q.sellbackDepthUsd : 0,
        houseProb: opts.houseProbByIdx.has(b.idx) ? (opts.houseProbByIdx.get(b.idx) as number) : null,
        tokenYes: '',
        tokenNo: '',
        conditionId: '',
      });
    }
    // skip leading ticks before ANY bucket has a quote (nothing enterable / markable yet).
    if (!buckets.some((b) => fin(b.execAsk) || fin(b.execBid))) continue;
    ticks.push({
      capturedAt: new Date(ms).toISOString(),
      buckets,
      tz: opts.tz,
      targetDate: opts.targetDate,
      hoursSinceListing: (ms - createdMs) / 3_600_000,
    });
  }
  if (ticks.length === 0) return null;

  // resolution: prefer the DB winner; else the archive's own resolvedOutcome:'win' bucket.
  let winnerIdx = opts.resolution?.winnerIdx ?? null;
  if (winnerIdx == null) {
    const won = ev.buckets.find((b) => b.resolvedOutcome === 'win');
    winnerIdx = won ? won.idx : null;
  }
  const resolution: Resolution = {
    winnerIdx,
    gradingMismatch: opts.resolution?.gradingMismatch === true,
  };

  return { eventId: ev.eventId, city: ev.city, targetDate: opts.targetDate, tz: opts.tz, ticks, resolution };
}

/**
 * The center bucket the bot WOULD pick at entry (argmax houseProb among the mode±centerHalfWidth set), and
 * whether the eventual winner falls inside that bought set — the SELECTION diagnostic (does the forecast bracket
 * the truth?), separate from the P&L. Pure: reads only the seed + resolution, no book/timing. Returns null when
 * there is no seed (no mode) — an unenterable event for selection purposes.
 */
export function selectionDiagnostic(
  houseProbByIdx: Map<number, number>,
  winnerIdx: number | null,
  centerHalfWidth: number,
): { modeIdx: number; boughtIdxs: number[]; winnerInBought: boolean } | null {
  let modeIdx = -1;
  let modeProb = Number.NEGATIVE_INFINITY;
  for (const [idx, p] of houseProbByIdx) {
    if (fin(p) && p > modeProb) {
      modeProb = p;
      modeIdx = idx;
    }
  }
  if (modeIdx < 0) return null;
  const hw = Math.max(0, Math.floor(centerHalfWidth));
  const boughtIdxs: number[] = [];
  for (const [idx] of houseProbByIdx) if (Math.abs(idx - modeIdx) <= hw) boughtIdxs.push(idx);
  boughtIdxs.sort((a, b) => a - b);
  return { modeIdx, boughtIdxs, winnerInBought: winnerIdx != null && Math.abs(winnerIdx - modeIdx) <= hw };
}
