/**
 * core/sim/google-bucket-replay — the PURE taker replay engine for the GOOGLE-PICKS-BUCKET forward paper panel
 * (the operator's "Test 2"; the taker twin of sim/opening-bracket-replay.ts).
 *
 * THE STRATEGY (exact). Across the °C capture-universe cities (US °F markets excluded — see excludeFahrenheit),
 * per FRESH daily-Tmax market: buy the bucket the latest GOOGLE forecast points at when its taker ask is in the
 * cheap band (askMin ≤ execAsk ≤ askMax, 0.10–0.12); take profit when
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
import { cToF, wuRound } from '../units.ts';
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
  /** ENTER only when the execAsk is AT OR ABOVE this (0.10) — the cheap-entry FLOOR that excludes near-zero
   *  longshots (a bucket priced < 10¢ is a hopeless loser converging to 0, not a value entry). */
  askMin: number;
  /** ENTER only when the execAsk is at or below this (0.15) — the cheap-entry CEILING. Entry band = [askMin, askMax] = [10¢, 15¢]. */
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
  /** PURCHASE WINDOW (operator rule): only ENTER at a tick that is at least this many hours BEFORE resolution
   *  (resolvesAt). The window is [opening, resolvesAt − minHoursToResolution]; a cheap ask inside the final N
   *  hours is NOT enterable — near resolution every LOSING bucket decays cheap, so a cheap ask there is a loser,
   *  not an edge. 0 DISABLES the gate; it is also inactive when the event's resolvesAt is unknown (null). The
   *  frozen "Test 2" default is 16h. */
  minHoursToResolution: number;
  /** °C-ONLY buy-side filter (operator-set 2026-07-07): when true the strategy SKIPS US °F markets entirely. In
   *  the forward sweep the °F cohort went 0/6 while °C went 8/18 — dropping °F was the single biggest P&L lever
   *  (baseline −$62 → °C-only +$63). ROOT-CAUSED (GOOGLE-FAHRENHEIT-INVESTIGATION.md, 2026-07-07): NOT a fixable
   *  code bug — genuine Google forecast inaccuracy. Google systematically UNDER-forecasts US airport highs (a cold
   *  bias, |offset| ~1.4 buckets, 14% bucket accuracy); the too-cold pick never re-rates to the TP and decays to
   *  $0 (ZERO °F take-profits). The °C→°F floor-vs-round artifact is real but marginal — swapping floor→round
   *  leaves °F accuracy unchanged at 14%, so it does NOT rescue °F. Exclusion stands on forecast-quality grounds.
   *  (Same investigation, separate finding: floor→round DOES help the °C cohort 6%→23% bucket accuracy — a
   *  possible one-line googleBucketIdx win, pending OOS validation.) This is a VIEW-level filter (buildGoogleView
   *  reads it via each event's native unit); replayGoogleBracket IGNORES it — the engine is unit-agnostic and
   *  replays whatever bucket idx it is handed. */
  excludeFahrenheit: boolean;
  /** MAX ENTRY AGE (operator-set 2026-07-08): only ENTER when the first in-band cheap tick is at most this many
   *  hours since the market LISTED (hoursSinceListing). A bucket still cheap late in a market's life has usually
   *  been priced AWAY from Google's pick (adverse selection) — the collected data shows the 24–48h-old-entry
   *  cohort is 33% win / net-negative vs 60% / net-positive for ≤24h. 0 (or ≤0) DISABLES the gate; it is also
   *  inactive for a tick with an unknown (non-finite) age. Complements minHoursToResolution (which gates off the
   *  RESOLUTION end and goes inactive when resolvesAt is null — this gate still bites there). NB: the ≤24h edge is
   *  TINY-n (5 realized entries, no CI) — this runs it FORWARD as the gate of record, it is not yet proven. */
  maxEntryAgeH: number;
  /** DEAD-PICK guard (0115 safeguard ported from the live buy-table lane, operator 2026-07-21): our Google
   *  bucket must have real BID support at the entry tick (best bid ≥ this), else the market has written it off
   *  and buying it cheap is buying a loser (the KL 33°C @ 1¢ case). Reads the entry tick's own book — no fetch.
   *  0 (or ≤0) DISABLES. (The askMin floor already excludes sub-cent dust; this catches the thin/no-bid case
   *  inside the entry band.) */
  deadPickMinBid: number;
  /** FAVORITE VETO (the operator's explicit rule): skip the entry when ANY OTHER bucket's best bid ≥ this at
   *  the entry tick — the market is near-certain of a different outcome, so Google's cheap pick is a written-off
   *  longshot (the adverse-selection cohort the maxEntryAgeH gate approximates; this is the direct measure).
   *  bestBid is the liveness signal (real buyers; dust asks can't move it). > 1 (e.g. 2) DISABLES. */
  favoriteVetoProb: number;
}

/**
 * the frozen defaults — the exact "Test 2" thresholds. cities is filled per-run by the handler.
 *
 * ENTRY BAND [askMin, askMax] = [0.10, 0.12] (operator-set 2026-07-07, tightened from 0.15): buy only when the
 * Google bucket's executable ask is between 10¢ and 12¢. The offline buy/sell sweep found the 12–15¢ slice is
 * disproportionately losers — tightening the ceiling to 12¢ improved realized P&L (all-cities −$88 → +$73 at the
 * same TP), and the cheaper entries carry a bigger convergence multiple. The whole strategy is
 * buy-cheap→sell-higher (TP exits 0.30–0.50); < 10¢ buckets are hopeless longshots converging to 0.
 *
 * excludeFahrenheit TRUE (operator-set 2026-07-07): °C-only mode — skip US °F markets (the 0/6 cohort; see the
 * field doc). The offline optimum was °C-only + band ≤12¢ (+$136 realized / 47% win vs the −$62 baseline).
 *
 * minHoursToResolution 20 (operator-set 2026-07-07, was 16): the purchase window CLOSES 20h before resolution —
 * no buys in the final 20h, where the losers all decay cheap.
 *
 * maxEntryAgeH 24 (operator-set 2026-07-08): the buy window OPENS at listing and CLOSES 24h after — no buys once
 * the market is > 24h old. On the collected data the 24–48h-old-entry cohort was 33% win / net-negative vs 60% /
 * net-positive for ≤24h (adverse selection: a still-cheap late bucket has been priced away from Google's pick).
 * TINY-n (5 realized ≤24h entries, no CI) — run FORWARD as the gate of record, NOT yet a proven edge.
 *
 * askMax 0.15 (operator-set 2026-07-21, RAISED from 0.12): re-open the cheap-entry ceiling — the 12–15¢ slice
 * was tightened out on 2026-07-07 for being disproportionately losers, but those losers were largely buckets
 * the market had WRITTEN OFF, which the new dead-pick + favorite-veto guards now filter directly. Widening the
 * band back accommodates the entries the guards remove (a paired change: guards drop the written-off cheap
 * buckets, the band re-admits the cheap-but-LIVE ones). Measured forward — the §9R-E gate adjudicates.
 *
 * deadPickMinBid 0.02 / favoriteVetoProb 0.85 (operator-set 2026-07-21): the 0115 live-lane safeguards, ported.
 *
 * slAbs 0: the no-SL sentinel (≤ 0 disables the stop-loss; the position holds to resolution as its floor). The
 * panel sweeps five TP-only exit variants {0.30..0.50}; 0.30 is the canonical/headline variant — the sweep
 * confirmed 0.28–0.30 is the peak (lower TP sells winners too cheap; a taker SL self-triggers on the spread).
 */
export const GOOGLE_DEFAULTS: GoogleBracketCfg = {
  cities: [],
  perPositionUsd: 20,
  askMin: 0.1,
  askMax: 0.15,
  tpAbs: 0.3,
  slAbs: 0,
  paperSlippage: 0.01,
  takerFeeRate: 0.05,
  minHoursToResolution: 20,
  excludeFahrenheit: true,
  maxEntryAgeH: 24,
  deadPickMinBid: 0.02,
  favoriteVetoProb: 0.85,
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
 * ROUND-HALF-UP to the whole degree (wuRound — the SAME rounding the venue uses to grade the actual daily high;
 * cf. amsterdam.ts "the market grades on wuRound(...)"), then find the ladder bucket that whole degree lands in
 * (winningBucket). Returns the bucket's `idx` (NOT the array position), or null when the forecast can't be
 * bucketed (empty/garbage ladder, an unparseable label, or a ladder gap). Pure + total (never throws).
 *
 * ROUNDING — wuRound, not Math.floor (2026-07-08, GOOGLE-FAHRENHEIT-INVESTIGATION.md). Was Math.floor; swapped to
 * wuRound for GRADING-CONSISTENCY. The venue rounds the actual high half-up, so flooring the forecast picked one
 * bucket too COLD whenever the native value sat at ≥ x.5 (frequent for °C, since cToF and Google's one-decimal °C
 * scatter the fractional part). The swap lifts the °C cohort's bucket accuracy 6% → 23% (realized +$13 → +$108
 * in-sample) and is a WASH for °F (14% either way — °F loses to Google's genuine cold bias, not the rounding, so
 * this does NOT re-open °F). Isolated to the Google-bucket panel (DORMANT analytics; googleBucketIdx has no other
 * caller). In-sample n is small — treat the °C P&L as directional, the grading-consistency as the real reason.
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
  const deg = wuRound(native);
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
 *  1. ENTER at the FIRST tick whose Google-predicted bucket carries a live execAsk in the band [askMin, askMax] AND that sits
 *     inside the PURCHASE WINDOW [opening, resolvesAt − cfg.minHoursToResolution] AND is at most cfg.maxEntryAgeH
 *     hours old (hoursSinceListing) — a cheap ask inside the final N hours before resolution is skipped (losers
 *     decay cheap there), and a cheap ask once the market is already > maxEntryAgeH old is skipped (adverse
 *     selection). The resolution gate is inactive when `resolvesAt` is null or minHoursToResolution ≤ 0; the age
 *     gate is inactive when maxEntryAgeH ≤ 0 or the tick age is non-finite. Reasons distinguish the cause:
 *     'cheap_after_cutoff' (only cheap inside the final N hours), 'cheap_but_too_old' (only cheap past the age
 *     cap), 'never_enterable' (never cheap at all) — so each gate's effect is visible.
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
  resolvesAt: string | null = null,
): BracketTrade {
  if (!input || !Array.isArray(input.ticks) || input.ticks.length === 0) return NOT_EXECUTED('no_ticks');
  if (predictedBucketIdx == null || !Number.isFinite(predictedBucketIdx) || predictedBucketIdx < 0) {
    return NOT_EXECUTED('no_google');
  }
  const ticks = input.ticks;
  const bIdx = predictedBucketIdx;

  // ── purchase-window cutoff: entries allowed only in [opening, resolvesAt − minHoursToResolution]. Near
  //    resolution every LOSING bucket decays cheap, so a cheap ask in the final hours is a loser, not an edge
  //    (operator rule). Gate inactive when resolvesAt is unknown or minHoursToResolution ≤ 0. ────────────────
  const resolveMs = resolvesAt != null ? new Date(resolvesAt).getTime() : NaN;
  const gateActive = fin(cfg.minHoursToResolution) && cfg.minHoursToResolution > 0 && Number.isFinite(resolveMs);
  const cutoffMs = gateActive ? resolveMs - cfg.minHoursToResolution * 3_600_000 : Number.POSITIVE_INFINITY;
  // MAX-ENTRY-AGE gate (operator-set): reject a first-cheap tick older than maxEntryAgeH hours since listing.
  const ageGateActive = fin(cfg.maxEntryAgeH) && cfg.maxEntryAgeH > 0;
  // 0115 SAFEGUARDS (operator 2026-07-21): dead-pick needs a real bid on our bucket; favorite-veto skips when
  // another bucket is a near-lock. Both read the entry tick's own book (already in the replay data — no fetch).
  const deadPickActive = fin(cfg.deadPickMinBid) && cfg.deadPickMinBid > 0;
  const favoriteVetoActive = fin(cfg.favoriteVetoProb) && cfg.favoriteVetoProb > 0 && cfg.favoriteVetoProb <= 1;

  // ── (1) entry: first tick whose predicted bucket has a live ask in the band [askMin, askMax], is in the
  //        purchase window (≥ minHoursToResolution before resolution), is young enough (≤ maxEntryAgeH), and
  //        passes the dead-pick + favorite-veto safeguards ─────────────────────────────────────────────────────
  let entryIdx = -1;
  let entryBucket: OpeningBucket | undefined;
  let entryAsk = NaN;
  let cheapAfterCutoff = false; // a band-priced ask existed, but only past the window → excluded by the min-hours rule
  let cheapButTooOld = false; // a band-priced ask existed in-window, but only after the market was > maxEntryAgeH old
  let deadPickBlocked = false; // a cheap in-window young tick existed, but our bucket had no real bid support
  let favoriteBlocked = false; // …but another bucket was a ≥ favoriteVetoProb near-lock (market wrote our pick off)
  for (let i = 0; i < ticks.length; i++) {
    const b = bucketOf(ticks[i]!, bIdx);
    const ask = b?.execAsk ?? null;
    if (b && fin(ask) && ask > 0 && ask >= cfg.askMin && ask <= cfg.askMax) {
      if (gateActive) {
        const tMs = new Date(ticks[i]!.capturedAt).getTime();
        if (!Number.isFinite(tMs) || tMs > cutoffMs) {
          if (Number.isFinite(tMs)) cheapAfterCutoff = true; // genuinely inside the final N hours
          continue;
        }
      }
      if (ageGateActive) {
        const age = ticks[i]!.hoursSinceListing;
        if (!fin(age) || age > cfg.maxEntryAgeH) {
          if (fin(age)) cheapButTooOld = true; // cheap, but the market was already > maxEntryAgeH old
          continue;
        }
      }
      // DEAD-PICK: our Google bucket must have real bid support (else the book has written it off).
      if (deadPickActive) {
        const pickBid = fin(b.bestBid) ? b.bestBid : null;
        if (pickBid == null || pickBid < cfg.deadPickMinBid) {
          deadPickBlocked = true;
          continue;
        }
      }
      // FAVORITE VETO: skip if any OTHER bucket at this tick is a ≥ favoriteVetoProb near-lock.
      if (favoriteVetoActive) {
        let maxOtherBid = Number.NEGATIVE_INFINITY;
        for (const ob of Array.isArray(ticks[i]!.buckets) ? ticks[i]!.buckets : []) {
          if (!ob || ob.idx === bIdx) continue;
          if (fin(ob.bestBid) && ob.bestBid > maxOtherBid) maxOtherBid = ob.bestBid;
        }
        if (Number.isFinite(maxOtherBid) && maxOtherBid >= cfg.favoriteVetoProb) {
          favoriteBlocked = true;
          continue;
        }
      }
      entryIdx = i;
      entryBucket = b;
      entryAsk = ask;
      break;
    }
  }
  if (entryIdx < 0 || !entryBucket) {
    // Precedence: the SAFEGUARD skips first (a genuinely cheap/in-window/young tick that we protectively
    // declined — the operator wants these visible), then the window/age reasons, then never-cheap.
    return NOT_EXECUTED(
      favoriteBlocked
        ? 'favorite_veto'
        : deadPickBlocked
          ? 'dead_pick'
          : cheapAfterCutoff
            ? 'cheap_after_cutoff'
            : cheapButTooOld
              ? 'cheap_but_too_old'
              : 'never_enterable',
    );
  }

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
