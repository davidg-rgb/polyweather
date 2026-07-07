/**
 * core/sim/google-bucket-replay — the PURE taker replay engine for the GOOGLE-PICKS-BUCKET forward paper panel
 * (the operator's "Test 2"; the taker twin of sim/opening-bracket-replay.ts).
 *
 * THE STRATEGY (exact). Across ALL capture-universe cities, per FRESH daily-Tmax market: buy the bucket the
 * latest GOOGLE forecast points at when its taker ask crosses cheap (execAsk ≤ askMax, 0.15); take profit when
 * that bucket's execBid re-rates to/above tpAbs; OPTIONALLY stop-loss when its execBid falls to/below slAbs (only
 * when slAbs > 0 — a slAbs ≤ 0 sentinel DISABLES the stop-loss so the position simply HOLDS to resolution); else
 * HOLD to resolution ($1 if the bought bucket wins, $0 else). Taker entry + taker exit. NO time-stop.
 *
 * WHAT IT IS vs opening-bracket-replay. Same ingest (buildEvents), the same fresh-universe grouping, the same
 * pessimistic taker fill (paperFill) + fee curve (takerFeePerShare), the same NO-LOOK-AHEAD exit walk and the
 * same `BracketTrade` output shape — but TWO differences:
 *   (a) ENTRY BUCKET is the GOOGLE-predicted winning bucket (googleBucketIdx below), NOT the argmax-houseProb
 *       forecast center. The house seed / selectEntries / flat-open machinery is bypassed entirely.
 *   (b) EXIT is ABSOLUTE (execBid ≥ tpAbs / ≤ slAbs), not entry-relative, and there is NO station-local-noon
 *       time-stop — an unfired position simply settles at resolution.
 *
 * NO LOOK-AHEAD (load-bearing). The exit decision at tick t reads ONLY that tick's execBid; the series is walked
 * in time order and the exit loop BREAKS at the first firing — a later up-tick can never rescue a stopped trade.
 * bestReachableBid + the post-exit curve are SEPARATE report-only passes (never a decision input). The exit walk
 * starts at the tick AFTER the fill: the entry tick's bid is the spread we crossed to buy, not a sell signal
 * (unlike opening-bracket-replay's maker-resting fill, this is a same-tick taker entry, so starting exits on the
 * fill tick would let a wide entry spread instantly self-stop — an artefact, not a trade).
 *
 * Pure + total (junk → executed:false / NaN / null, never throws). Imports only ./opening-convergence.ts,
 * ../fees.ts, ../buckets.ts, ../units.ts, ../types.ts — NEVER io/trading. Paper/analysis only; no capital.
 */
import {
  paperFill,
  OPENING_DEFAULTS,
  type OpeningCfg,
  type OpeningBucket,
  type EntryCandidate,
} from './opening-convergence.ts';
import { takerFeePerShare } from '../fees.ts';
import { parseBucketLabel, winningBucket } from '../buckets.ts';
import { cToF } from '../units.ts';
import type { Unit } from '../types.ts';
import type { EventReplayInput, ReplayTick, BracketTrade } from './opening-bracket-replay.ts';

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The config the Google-bucket taker replay reads (all thresholds are absolute execBid levels). */
export interface GoogleBracketCfg {
  /** the capture universe this panel scopes over (display + the Edge handler's per-city fetch list) — NOT an
   *  entry gate: the strategy runs on EVERY fresh market in the fetched captures, the house/city allowlist is
   *  irrelevant here. Surfaced so the page can show "N cities" and the handler knows which cities to pull. */
  cities: string[];
  /** per-position $ stake (a pure taker test — depth-UNgated, matching the exact strategy spec). */
  perPositionUsd: number;
  /** ENTER when the Google-predicted bucket's execAsk is strictly below this (0.15 — the cheap-entry floor). */
  askMax: number;
  /** TAKE PROFIT when that bucket's execBid is at or above this ABSOLUTE level (0.30 canonical; the panel also
   *  sweeps {0.30..0.50}). */
  tpAbs: number;
  /** STOP LOSS when that bucket's execBid is at or below this ABSOLUTE level. A sentinel value ≤ 0 DISABLES the
   *  stop-loss entirely (the position holds to resolution as its floor) — the frozen "Test 2" default is no SL. */
  slAbs: number;
  /** additive pessimistic taker slippage on the entry fill (mirrors OpeningCfg.paperSlippage). */
  paperSlippage: number;
  /** the weather taker fee rate the paper model charges on entry + both exit legs. */
  takerFeeRate: number;
}

/**
 * the frozen defaults — the exact "Test 2" thresholds. cities is filled per-run by the handler.
 *
 * askMax 0.15: OPERATOR-FLAGGED interpretation. The operator wrote "Entry point at >15c"; the whole strategy is
 * buy-cheap→sell-higher (TP exits 0.30–0.50), so this reads as the 15¢ CHEAP-ENTRY threshold — buy only when the
 * ask is BELOW 15¢ (execAsk < 0.15), not above. Flagged here so a later operator correction is a one-line change.
 *
 * slAbs 0: the no-SL sentinel (≤ 0 disables the stop-loss; the position holds to resolution as its floor). The
 * panel sweeps five TP-only exit variants {0.30..0.50}; 0.30 is the canonical/headline variant.
 */
export const GOOGLE_DEFAULTS: GoogleBracketCfg = {
  cities: [],
  perPositionUsd: 20,
  askMax: 0.15,
  tpAbs: 0.3,
  slAbs: 0,
  paperSlippage: 0.01,
  takerFeeRate: 0.05,
};

/** GOOGLE_DEFAULTS with the run's capture-universe cities pinned in (falls back to the empty default scope). */
export function googleCfg(cities: string[]): GoogleBracketCfg {
  return { ...GOOGLE_DEFAULTS, cities: Array.isArray(cities) && cities.length > 0 ? cities : GOOGLE_DEFAULTS.cities };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// googleBucketIdx — map a Google °C daily-max forecast to the ladder bucket idx it wins
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** the same bucket across a tick, by idx identity (undefined if the book dropped it that tick). */
function bucketOf(tick: ReplayTick, idx: number): OpeningBucket | undefined {
  return (Array.isArray(tick.buckets) ? tick.buckets : []).find((b) => b && b.idx === idx);
}

/**
 * Google's forecast is always °C (parseGoogleDailyMax). Convert to the city's NATIVE unit (°F cities: cToF),
 * FLOOR to the whole degree, then find the ladder bucket that whole-degree lands in (winningBucket, the same
 * whole-degree containment the market/WU grade uses). Returns the bucket's `idx` (NOT the array position), or
 * null when the forecast can't be bucketed (empty/garbage ladder, an unparseable label, or a ladder gap). Pure
 * + total (never throws). NB: the FLOOR (not wuRound) is the deliberate "Test 2" spec — a single-line change
 * here would swap it for round-half-up if the operator later prefers WU-rounding semantics.
 */
export function googleBucketIdx(buckets: OpeningBucket[], tmaxC: number, unit: Unit): number | null {
  if (!Array.isArray(buckets) || buckets.length === 0 || !fin(tmaxC)) return null;
  const ordered = [...buckets].filter((b) => b && Number.isFinite(b.idx)).sort((a, b) => a.idx - b.idx);
  if (ordered.length === 0) return null;
  let defs;
  try {
    defs = ordered.map((b) => parseBucketLabel(String(b.label ?? '')));
  } catch {
    return null; // an unparseable ladder label ⇒ cannot bucket (fail closed — never guess a temperature)
  }
  const native = unit === 'F' ? cToF(tmaxC) : tmaxC;
  const deg = Math.floor(native);
  try {
    const pos = winningBucket(defs, deg);
    return ordered[pos]!.idx;
  } catch {
    return null; // ladder gap — the value fell outside every bucket (impossible on a valid tailed ladder)
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// replayGoogleBracket — the per-market taker lifecycle (entry → taker fill → absolute bracket → settle)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const NOT_EXECUTED = (reason: string): BracketTrade => ({
  entryAgeH: null,
  entryPrice: NaN,
  isMaker: false,
  entryLabel: '',
  exitReason: reason,
  exitPrice: NaN,
  netPnlUsd: 0,
  stakeUsd: 0,
  netReturn: NaN,
  executed: false,
  bestReachableBid: NaN,
  postExitBestBid: NaN,
  postExitWorstBid: NaN,
});

/**
 * Replay ONE market's Google-bucket taker trade. Pure + total.
 *
 *  1. ENTER at the FIRST tick whose Google-predicted bucket carries a live execAsk in (0, askMax).
 *  2. FILL as a taker at that ask (worse-of stored/live == the same tick's ask, + pessimistic slippage) — reuses
 *     paperFill's taker branch verbatim (one source of truth for the fill/fee model).
 *  3. EXIT (absolute, no look-ahead): from the NEXT tick, sell the moment execBid ≥ tpAbs (take-profit) or —
 *     ONLY when slAbs > 0 — execBid ≤ slAbs (stop-loss); a slAbs ≤ 0 sentinel disables the stop-loss so an
 *     unfired position just holds to resolution. Taker fee on the exit leg. No time-stop.
 *  4. SETTLE a position still open at series end at the resolution winner ($1/$0, no fee), else mark to the last
 *     realizable execBid (mtm_unresolved / mtm_grading_mismatch).
 *
 * predictedBucketIdx is the googleBucketIdx result; a null/negative/non-finite idx (no Google data / unbucketable
 * forecast) short-circuits to executed:false with reason 'no_google'.
 */
export function replayGoogleBracket(
  input: EventReplayInput,
  predictedBucketIdx: number | null,
  cfg: GoogleBracketCfg,
): BracketTrade {
  if (!input || !Array.isArray(input.ticks) || input.ticks.length === 0) return NOT_EXECUTED('no_ticks');
  if (predictedBucketIdx == null || !Number.isFinite(predictedBucketIdx) || predictedBucketIdx < 0) {
    return NOT_EXECUTED('no_google');
  }
  const ticks = input.ticks;
  const bIdx = predictedBucketIdx;

  // ── (1) entry: first tick whose predicted bucket has a live, cheap (≤ askMax) executable ask ───────────
  let entryIdx = -1;
  let entryBucket: OpeningBucket | undefined;
  let entryAsk = NaN;
  for (let i = 0; i < ticks.length; i++) {
    const b = bucketOf(ticks[i]!, bIdx);
    const ask = b?.execAsk ?? null;
    if (b && fin(ask) && ask > 0 && ask <= cfg.askMax) {
      entryIdx = i;
      entryBucket = b;
      entryAsk = ask;
      break;
    }
  }
  if (entryIdx < 0 || !entryBucket) return NOT_EXECUTED('never_enterable');

  // ── (2) taker fill at the cheap ask (reuse paperFill's taker branch) ───────────────────────────────────
  const candidate: EntryCandidate = {
    eventId: input.eventId,
    city: input.city,
    targetDate: input.targetDate,
    tz: input.tz,
    bucketIdx: bIdx,
    label: entryBucket.label,
    tokenYes: entryBucket.tokenYes,
    tokenNo: entryBucket.tokenNo,
    conditionId: entryBucket.conditionId,
    negRisk: true,
    resolvesAt: null,
    execAsk: entryAsk,
    modelProb: 0, // unused on the taker path (paperFill(...false) ignores it)
    edge: 0,
    makerLimit: entryAsk, // unused on the taker path
    targetShares: entryAsk > 0 ? cfg.perPositionUsd / entryAsk : 0,
    targetUsd: cfg.perPositionUsd,
  };
  // paperFill's taker branch reads only paperSlippage + takerFeeRate off the cfg — thread ours through a
  // full OpeningCfg so the fill/fee semantics are byte-identical to the opening-convergence taker model.
  const fillCfg: OpeningCfg = { ...OPENING_DEFAULTS, paperSlippage: cfg.paperSlippage, takerFeeRate: cfg.takerFeeRate };
  const fill = paperFill(candidate, entryAsk, entryAsk, fillCfg, false);
  if (!fill) return NOT_EXECUTED('never_filled');

  const shares = fill.shares;
  const stakeUsd = fill.price * fill.shares;
  const entryFee = fill.feeUsd;
  const entryAgeH = fin(ticks[entryIdx]!.hoursSinceListing) ? ticks[entryIdx]!.hoursSinceListing : null;

  // ── report-only ceiling: the max execBid reached from the fill onward (NEVER a decision input) ──────────
  let best = Number.NEGATIVE_INFINITY;
  for (let j = entryIdx; j < ticks.length; j++) {
    const m = bucketOf(ticks[j]!, bIdx)?.execBid ?? null;
    if (fin(m) && m > best) best = m;
  }
  const bestReachableBid = Number.isFinite(best) ? best : NaN;

  // ── (3) absolute bracket exit walk — starts at the NEXT tick, breaks at first firing (NO LOOK-AHEAD) ────
  //    the stop-loss leg is ONLY armed when slAbs > 0; a slAbs ≤ 0 sentinel means "no SL, hold to resolution".
  const slActive = fin(cfg.slAbs) && cfg.slAbs > 0;
  let exited = false;
  let exitIdx = -1;
  let exitPrice = NaN;
  let exitReason = '';
  let netPnlUsd = 0;
  let lastBid: number | null = null;
  for (let j = entryIdx + 1; j < ticks.length; j++) {
    const mark = bucketOf(ticks[j]!, bIdx)?.execBid ?? null;
    if (!fin(mark)) continue;
    lastBid = mark;
    const tpHit = mark >= cfg.tpAbs;
    const slHit = slActive && mark <= cfg.slAbs;
    if (tpHit || slHit) {
      const fee = takerFeePerShare(mark, cfg.takerFeeRate) * shares; // taker sell into the bid
      exitPrice = mark;
      netPnlUsd = shares * mark - fee - stakeUsd - entryFee;
      exitReason = tpHit
        ? `take_profit:execBid ${mark.toFixed(4)} ≥ ${cfg.tpAbs}`
        : `stop_loss:execBid ${mark.toFixed(4)} ≤ ${cfg.slAbs}`;
      exited = true;
      exitIdx = j;
      break;
    }
  }

  // ── (4) settle a position still open at series end (HOLD to resolution), else mark to the last bid ──────
  if (!exited) {
    if (!input.resolution.gradingMismatch && input.resolution.winnerIdx != null) {
      const won = input.resolution.winnerIdx === bIdx;
      exitPrice = won ? 1 : 0;
      netPnlUsd = shares * (won ? 1 : 0) - stakeUsd - entryFee; // redeem at resolution — no taker fee
      exitReason = `resolution_settle:${won ? 'win' : 'lose'}`;
    } else {
      const mtm = fin(lastBid) ? lastBid : 0; // conservative mark (a MARK, not a trade — no fee)
      exitPrice = mtm;
      netPnlUsd = shares * mtm - stakeUsd - entryFee;
      exitReason = input.resolution.gradingMismatch ? 'mtm_grading_mismatch' : 'mtm_unresolved';
    }
  }

  // ── post-realization curve (bracket exits only): how the bucket moved AFTER we closed, folding in the
  //    resolution payout as the terminal "if held" point. REPORT-ONLY (never a decision). ─────────────────
  let postExitBestBid = NaN;
  let postExitWorstBid = NaN;
  if (exited && exitIdx >= 0) {
    let hi = Number.NEGATIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    for (let j = exitIdx + 1; j < ticks.length; j++) {
      const m = bucketOf(ticks[j]!, bIdx)?.execBid ?? null;
      if (fin(m)) {
        if (m > hi) hi = m;
        if (m < lo) lo = m;
      }
    }
    if (!input.resolution.gradingMismatch && input.resolution.winnerIdx != null) {
      const payout = input.resolution.winnerIdx === bIdx ? 1 : 0;
      if (payout > hi) hi = payout;
      if (payout < lo) lo = payout;
    }
    postExitBestBid = Number.isFinite(hi) ? hi : NaN;
    postExitWorstBid = Number.isFinite(lo) ? lo : NaN;
  }

  return {
    entryAgeH,
    entryPrice: fill.price,
    isMaker: false, // pure taker entry, always
    entryLabel: entryBucket.label,
    exitReason,
    exitPrice,
    netPnlUsd,
    stakeUsd,
    netReturn: stakeUsd > 0 ? netPnlUsd / stakeUsd : NaN,
    executed: true,
    bestReachableBid,
    postExitBestBid,
    postExitWorstBid,
  };
}
