/**
 * core/sim/maker-spray — the PURE, deterministic MAKER-SPRAY feasibility analytics
 * (MAKER-SPRAY-SIM.md §9 frozen kill-criterion · the 4th and LAST badatmath replication angle,
 * WALLET-RECON-HANDOFF.md §12). The maker twin of `sim/copy-trade.ts`.
 *
 * THE QUESTION KILL-GATE 2 DID NOT ANSWER. KILL-GATE 2 measured `calibratedP − ask` (a TAKER
 * crossing the spread on OUR EMOS forecast) and found the day-before market efficient. Copy-trade
 * (§11) measured mirroring badatmath's fills as a follower-taker and found that uneconomic too.
 * The one variable still unmeasured: **does resting a MAKER bid BELOW the ask on our forecast clear
 * zero EV?** This module measures `calibratedP − rested_bid` with a fill model that embeds adverse
 * selection from the real `market_snapshots` book evolution — the ask collapses toward our bid on
 * buckets the market marks DOWN (losers fill), rises away on winners (no fill). If even a rested
 * maker bid is +EV after the fill model + fee, the rail re-opens; if not, the market is efficient to
 * a maker too and the clean efficiency measurement IS the deliverable (WO-5 discipline).
 *
 * THE NOVEL PIECE — the maker fill model (`simulateFill`). A resting BUY at `restPx` is filled iff
 * some post-entry snapshot has `best_ask ≤ restPx` (ask-touch, ADR-03). This EMBEDS adverse
 * selection: it fills more readily on buckets whose ask collapses (losers) than on winners (the ask
 * rises away). It is EXPECTED-pessimistic but NOT provably so (a winner briefly cheap at entry fills
 * and counts; `min over the window` fills any bucket whose ask momentarily dipped; it ignores queue
 * priority). Therefore the adverse-selection diagnostic (`filledHitRate ≪ allEligibleHitRate`) is a
 * GATING SANITY: if AS does NOT appear, the pessimism assumption failed and the verdict is flagged
 * suspect (`asSuspect`). The `last_trade` variant + the F-008 cross-val quantify the gap.
 *
 * Reuse, don't reimplement: `BucketSnapshot` / `snapshotAtOrAfter` / `snapshotAtOrBefore` / `EvCi`
 * from `./copy-trade.ts`; `armEdgeStats` / `bootstrapMeanCi` / `meanConfidenceInterval` /
 * `wilsonInterval` / `GradedBet` from `./stats.ts`; `takerFeeTotal` from `../fees.ts`; `brierScore` /
 * `mulberry32` from `../calibration/scores.ts`. The pure module imports ONLY these core siblings —
 * NEVER `packages/trading` (the §15 invariant + R-8).
 *
 * THE FROZEN KILL-CRITERION (ADR-08, MAKER-SPRAY-SIM.md §9 — pre-registered, do NOT move to fit a
 * result). BINDING gate = the FILLED-position fee-net EV/$1 95% bootstrap CI lower bound > 0
 * (POOLED). "≥2 stations clear 0" and "not-EHAM-only" are robustness DESCRIPTORS reported alongside,
 * NOT co-equal AND-gates (≥2 clearing by chance under zero edge is ~30%, the weakest link). A
 * MANDATORY zero-skill Monte-Carlo (shuffle `won` within each station, re-run the verdict ~1000×,
 * report empirical P(PASS)) calibrates the false-positive rate and must be < 5%; per-station min-n
 * for a credible CI is ≥ 20.
 *
 * Idiom: pure + total. An empty / all-ineligible input returns a zeroed report (NaN point
 * estimates), never throws. Deterministic — every bootstrap/MC seeds mulberry32 (seed 42 by
 * default), so every run is byte-identical; input arrays are SQL-ORDERED, never
 * insertion-order-dependent.
 */
import { brierScore, mulberry32 } from '../calibration/scores.ts';
import { takerFeeTotal } from '../fees.ts';
import type { EvCi } from './copy-trade.ts';
import { snapshotAtOrAfter } from './copy-trade.ts';
import {
  type GradedBet,
  armEdgeStats,
  bootstrapMeanCi,
  meanConfidenceInterval,
  wilsonInterval,
} from './stats.ts';

// EvCi is the copy-trade thin {ev,evCiLo,evCiHi,n} CI shape — re-export so callers never reach across
// modules for the headline type (§6.1 "EvCi (re-export from copy-trade)").
export type { EvCi } from './copy-trade.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Where to rest the maker bid relative to the entry book (ADR-04). */
export type RestRule = 'bid' | 'bid_plus_tick' | 'ask_offset';

/** The fill trigger (ADR-03). `ask_touch` is the headline; `last_trade` is the variant. */
export type FillModel = 'ask_touch' | 'last_trade';

/**
 * One row of a bucket's order-book time-series, as the maker fill model needs it. A STRUCTURAL
 * SUPERSET of copy-trade's `BucketSnapshot` (adds the optional `lastTrade`): the imported
 * `BucketSnapshot` does NOT carry `lastTrade` (Pass-1 C1) — that field lives on the script-local
 * `MakerSnapshot` (§6.2), so `simulateFill` is generic over `{ capturedAt; ask; lastTrade? }` and
 * accepts either shape.
 */
export interface FillSnapshot {
  /** Unix seconds (market_snapshots.captured_at). */
  capturedAt: number;
  /** best_bid in (0,1] or null (no resting bid). */
  bid: number | null;
  /** best_ask in (0,1] or null (no resting ask). */
  ask: number | null;
  /** mid = (bid+ask)/2 (or last_trade fallback) or null. */
  mid: number | null;
  /** last_trade in (0,1] or null — present only on the script-local MakerSnapshot (Pass-1 C1). */
  lastTrade?: number | null;
}

/** Knobs for the maker spray. All have honest, conservative defaults. */
export interface MakerSprayOpts {
  /** Where to rest the bid (default 'bid' — badatmath rests at/near the bid, ADR-04). */
  rule?: RestRule;
  /** The fill trigger (default 'ask_touch' — the conservative headline, ADR-03). */
  fillModel?: FillModel;
  /** Price tick the rested bid is rounded DOWN to (default 0.01 — the cent grid). */
  tickSize?: number;
  /** For 'ask_offset': rest at ask − this (default 0.07 — badatmath rests ~7pp below ask, §11). */
  askOffset?: number;
  /** Only buckets whose rested price < this enter the cheap-longshot study (default 0.25 — the §3 cut). */
  cheapMax?: number;
  /**
   * Lower edge of the study band: only buckets whose rested price >= this are eligible (default 0 —
   * the frozen §12 behaviour, an open-below band). Set together with `cheapMax` to study an INTERIOR
   * band rather than the cheap tail — §16.6 pre-registers [0.15,0.45), the band that now carries
   * badatmath's engine and the one cell §12 never tested.
   */
  cheapMin?: number;
  /**
   * Which cheap buckets to rest on (the SELECTION axis — the difference between "mechanically mirror
   * badatmath's broad spray" and "test OUR forecast as a maker"):
   *   'all'      → rest on EVERY cheap bucket (default; ADR-07 — badatmath sprays a RANGE, its edge is
   *                breadth+calibration). This isolates the MECHANICS; our forecast never enters the EV path.
   *   'forecast' → rest ONLY where our calibrated prob exceeds the rested price (`calibratedP > restPx`) —
   *                the maker analog of db1's cheap-longshot rule (`calibratedP > ask`). THIS is the literal
   *                "does OUR forecast, used to pick which cheap buckets, clear zero as a maker?" question.
   * Run BOTH: 'all' is the naive baseline; 'forecast' is the headline test of the forecast's selection value.
   */
  select?: 'all' | 'forecast';
  /** Fee rate fallback when a bid omits its own feeRate (default 0.05 — the weather replica rate). */
  feeRate?: number;
  /** Maker rebate per share (default 0 — ADR-06; `--maker-rebate` is an optimistic sensitivity only). */
  rebate?: number;
  /**
   * Maker rebate as a SHARE OF THE TAKER FEE (default 0). When > 0, switches `makerNetEvPerDollar` to
   * the REALISTIC `weather_fees` model: on a `takerOnly:true` market the maker pays NO fee and earns
   * `rebateRate × takerFee` on each fill (live config: rate 0.05, rebateRate 0.25). The default 0 keeps
   * the frozen §12 conservative model (maker charged the full taker fee) byte-identical. NOT a kill-gate
   * lever — the PASS threshold is unchanged; this only corrects the EV to the market's actual fee schedule.
   */
  rebateRate?: number;
  /** Seed for the EV bootstrap CIs + the zero-skill MC (default 42 — the repo reproducibility contract). */
  bootstrapSeed?: number;
  /** Zero-skill Monte-Carlo iterations (default 1000 — ADR-08/W4). */
  mcIters?: number;
}

/**
 * One candidate resting maker bid: a (resolved event × cheap bucket) enriched with everything
 * `makerEntry` needs — our calibrated prob, the market-implied prob at entry, the realized outcome,
 * the fee rate, the tz metadata, the precise resolution/entry instants (computed upstream via
 * `localDayWindow`, ADR-05), and the bucket's book snapshot series (ASCENDING by capturedAt — the
 * caller sorts once). `makerEntry` is the SOLE owner of entry-snapshot resolution (Pass-1 integrity).
 */
export interface RestingBid {
  conditionId: string;
  bucketIdx: number;
  /** Our EMOS calibrated probability for this bucket (gaussianBucketProbs). */
  calibratedP: number;
  /** The market-implied prob at entry (ask at entryTs) — for Brier-vs-market (F-006). */
  marketProbAtEntry: number | null;
  /** Did this bucket resolve in the money. */
  bucketWon: boolean;
  /** market_buckets.fee_rate for this bucket. */
  feeRate: number;
  /** market_buckets.tick_size for this bucket. */
  tickSize: number;
  citySlug: string | null;
  /** The station ICAO (per-station CIs key off this). */
  station: string;
  /** The city's UTC offset (hours) at the target date — for the skew report (ADR-05). */
  tzOffsetHours: number;
  /** Station-local target date 'YYYY-MM-DD'. */
  targetDate: string;
  /** Resolution instant, unix seconds = localDayWindow(tz, targetDate).endUtc (ADR-05). */
  resolutionTs: number;
  /** Entry instant, unix seconds = resolutionTs − entryLeadHours·3600 (ADR-05). */
  entryTs: number;
  /** The bucket's book snapshots, ASCENDING by capturedAt (caller-sorted). */
  snapshots: FillSnapshot[];
}

/** The per-bid maker outcome (exported for tests / drill-down). */
export interface MakerEntry {
  /** The rested bid price, tick-rounded DOWN; null when no usable entry book. */
  restPx: number | null;
  /** The snapshot the bid is placed against (first at-or-after entryTs), or null. */
  entrySnapshot: FillSnapshot | null;
  /** restPx is a usable cheap (<cheapMax) price AND there is a post-entry series. */
  eligibleCheap: boolean;
  /** Did the rested bid fill before resolution, per the fill model. */
  filled: boolean;
  /** min(best_ask over the post-entry series) — the ask-touch diagnostic; null when none. */
  minAskAfter: number | null;
  /** Did this bucket resolve in the money. */
  won: boolean;
  /** fee-net EV/$1 as a maker at restPx; NaN when not filled (only filled positions are graded). */
  netEvFilled: number;
  /** won − restPx (the maker edge); NaN when not filled. */
  edgeFilled: number;
  /** restPx − mid at entry: negative ⇒ resting below the mid (passive). NaN when no mid. */
  restVsMid: number;
  /** (resolutionTs − entryTs) / 3600 — the entry lead in hours. */
  leadHours: number;
}

/** Brier(ours) vs Brier(market-implied-at-entry) — the F-006 sanity (lower is better). */
export interface BrierDelta {
  /** Mean Brier of our calibratedP across filled-eligible events. */
  ours: number;
  /** Mean Brier of the market-implied-at-entry probs across the same events. */
  market: number;
  /** ours − market: negative ⇒ our forecast is sharper than the market at entry. */
  delta: number;
  /** Events both Briers were computed over. */
  nEvents: number;
}

/** The adverse-selection GATING SANITY (ADR-03 / R-4). */
export interface AdverseSel {
  /** Hit rate among FILLED bids (should be LOW if AS is real — losers fill). NaN when nFilled=0. */
  filledHitRate: number;
  /** Hit rate among ALL cheap-eligible bids (the unconditional base rate). NaN when nEligible=0. */
  allEligibleHitRate: number;
  nFilled: number;
  nEligible: number;
  /** True iff filledHitRate < allEligibleHitRate (AS appeared — the pessimism held). */
  asConfirmed: boolean;
}

/** The zero-skill Monte-Carlo false-positive calibration (ADR-08 / W4). */
export interface ZeroSkillMc {
  /** Empirical P(PASS) under within-station shuffled outcomes — must be < 0.05 to trust the gate. */
  pPass: number;
  /** Iterations run. */
  iters: number;
}

/** The full maker-spray feasibility report — the pre-registered headline is `filledNetEv`. */
export interface MakerSprayReport {
  /** Total resting bids passed in. */
  nCandidates: number;
  /** Of those, the cheap-eligible ones (usable restPx < cheapMax + a post-entry series). */
  nCheapEligible: number;
  /** Of the eligible, the ones whose rested bid FILLED. */
  nFilled: number;
  /** nFilled / nCheapEligible — the fill rate. NaN when nCheapEligible=0. */
  fillRate: number;
  /** ★ BINDING HEADLINE: filled-position fee-net EV/$1, bootstrap CI (seed 42), POOLED. */
  filledNetEv: EvCi;
  /** Filled-position maker edge (won − restPx), mean ± z·SE. */
  filledEdge: { mean: number; ciLo: number; ciHi: number; n: number };
  /** The adverse-selection gating sanity (R-4). */
  adverseSelection: AdverseSel;
  /** Brier(ours) vs Brier(market-implied-at-entry) over filled-eligible events (F-006). */
  brierVsMarket: BrierDelta;
  /** The zero-skill MC false-positive rate (ADR-08). */
  zeroSkillMc: ZeroSkillMc;
  /** Per-station filled fee-net EV — each a REAL bootstrap CI (so the verdict only READS it). */
  perStation: Map<string, { filledNetEv: EvCi; nFilled: number }>;
  /** rest-vs-mid character: mean restPx−mid + fraction resting below the mid. */
  restVsMid: { mean: number; fracBelowMid: number; n: number };
  /** Coverage + the tz-skew diagnostic. */
  coverage: {
    nWithBook: number;
    nWithPostEntrySeries: number;
    gridMedianGapSec: number;
    maxTzSkewHours: number;
  };
}

/** The adjudication of a report against the FROZEN kill-criterion (ADR-08). */
export interface MakerSprayVerdict {
  /** PASS = the pooled filled fee-net EV 95% CI lower bound clears 0 (the BINDING gate). */
  pass: boolean;
  /**
   * TRUE when `nFilled` is below the sufficiency floor (`minFilled`) — the run carries too little data
   * to adjudicate. An INSUFFICIENT verdict is NOT a FAIL: an empty report's CI is [NaN, NaN], which the
   * `pass` test rejects, so without this flag a ZERO-DATA run rendered as a confident falsification
   * ("market efficient to a rested maker bid"). Callers must branch on this BEFORE reading `pass`.
   */
  insufficient: boolean;
  /** PASS AND the point EV ≥ the operational-margin threshold (default +2% EV/$1). */
  clearsMargin: boolean;
  /** Robustness DESCRIPTOR — the stations whose own filled-EV CI clears 0 (NOT a gate, W4). */
  stationsClearing: string[];
  /** Robustness DESCRIPTOR — true iff the only clearing station is EHAM (NOT a gate). */
  ehamOnly: boolean;
  /** The zero-skill MC P(PASS) — must be < 0.05 to trust the gate (surfaced, not a hard AND-gate here). */
  zeroSkillPPass: number;
  /** True iff adverse selection did NOT appear — the verdict is flagged SUSPECT (R-1). */
  asSuspect: boolean;
  /** The headline pooled filled fee-net EV + CI used to adjudicate. */
  filledNetEv: EvCi;
  /** The pre-registered operational margin threshold (EV/$1) the `clearsMargin` flag uses. */
  marginThreshold: number;
  /** One-line human verdict. */
  summary: string;
}

/** The fill-model cross-validation result (F-008). */
export interface CrossValResult {
  /** Fraction of badatmath's OWN cheap fills our fill model PREDICTS filled. NaN when n=0. */
  agreementRate: number;
  n: number;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// price guards
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const usablePrice = (p: number | null | undefined): p is number =>
  p != null && Number.isFinite(p) && p > 0 && p <= 1;

/** Round a price DOWN to the tick grid (a maker never rounds UP into a worse fill). */
function floorToTick(px: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return px;
  // Work in integer ticks to dodge binary-float drift (0.07/0.01 = 6.9999…).
  return Math.floor(px / tickSize + 1e-9) * tickSize;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// THE NOVEL PIECE — restPrice + the maker fill model
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The rested bid price from the entry book, tick-rounded DOWN, validated to (0,1].
 *   'bid'           → rest at best_bid (passive, behind the queue).
 *   'bid_plus_tick' → rest one tick above the bid (jump the queue by a tick).
 *   'ask_offset'    → rest at best_ask − askOffset (a fixed discount to the ask).
 * Returns null when the needed price is missing/unusable; never throws.
 */
export function restPrice(
  entry: FillSnapshot,
  rule: RestRule,
  opts: { tickSize: number; askOffset: number },
): number | null {
  const tick = Number.isFinite(opts.tickSize) && opts.tickSize > 0 ? opts.tickSize : 0.01;
  let raw: number | null = null;
  if (rule === 'bid') {
    raw = usablePrice(entry.bid) ? entry.bid : null;
  } else if (rule === 'bid_plus_tick') {
    raw = usablePrice(entry.bid) ? entry.bid + tick : null;
  } else {
    // ask_offset
    raw = usablePrice(entry.ask) ? entry.ask - opts.askOffset : null;
  }
  if (raw == null || !Number.isFinite(raw)) return null;
  const px = floorToTick(raw, tick);
  return usablePrice(px) ? px : null;
}

/**
 * THE NOVEL PIECE. Does a BUY resting at `restPx` fill before resolution, from the real book series?
 *   'ask_touch' (default) → filled iff min(best_ask over postEntry) ≤ restPx (ADR-03). Embeds adverse
 *                           selection: the ask collapses to our bid on losers (fill), rises on winners.
 *   'last_trade' (variant) → filled iff any postEntry.lastTrade ≤ restPx (needs MakerSnapshot.lastTrade).
 * Returns { filled, minAskAfter (the ask-touch diagnostic), fillIdx (first crossing index) }.
 * Empty / non-finite postEntry → { filled:false, minAskAfter:null, fillIdx:null }; never throws.
 * NOTE: ask_touch is EXPECTED-pessimistic, NOT provably so (ADR-03) — the AS diagnostic gates the verdict.
 */
export function simulateFill(
  restPx: number,
  postEntry: FillSnapshot[],
  model: FillModel,
): { filled: boolean; minAskAfter: number | null; fillIdx: number | null } {
  if (!usablePrice(restPx) || !Array.isArray(postEntry) || postEntry.length === 0) {
    return { filled: false, minAskAfter: null, fillIdx: null };
  }
  let minAskAfter: number | null = null;
  let fillIdx: number | null = null;
  for (let i = 0; i < postEntry.length; i++) {
    const s = postEntry[i]!;
    const probe = model === 'last_trade' ? s.lastTrade : s.ask;
    if (usablePrice(probe)) {
      // Track min ask for the diagnostic regardless of which model triggers the fill.
      if (model === 'ask_touch') {
        if (minAskAfter === null || probe < minAskAfter) minAskAfter = probe;
      }
      if (probe <= restPx && fillIdx === null) fillIdx = i;
    }
    // last_trade still surfaces the ask floor as a diagnostic (without driving the fill).
    if (model === 'last_trade' && usablePrice(s.ask)) {
      if (minAskAfter === null || s.ask < minAskAfter) minAskAfter = s.ask;
    }
  }
  return { filled: fillIdx !== null, minAskAfter, fillIdx };
}

/**
 * Fee-net EV per $1 staked as a MAKER at `restPx`. Two models, selected by `rebateRate`:
 *
 *   • rebateRate === 0 (DEFAULT — the frozen §12 kill-gate, conservative): the maker is charged the full
 *     taker fee (`takerFeeTotal`, rate·p·(1−p)) less an optional per-share `rebate`, floored at 0. This
 *     DELIBERATELY over-penalises — it charges a fee `takerOnly:true` markets do NOT levy on makers — so
 *     a PASS is robust. Per $1: win → shares·(1−restPx); loss → −1; minus max(0, fee − rebate·shares).
 *
 *   • rebateRate > 0 (the REALISTIC `weather_fees` model): on a `takerOnly:true` market the maker pays NO
 *     fee and EARNS `rebateRate × takerFee` on the fill (live config: rate 0.05, rebateRate 0.25). Per $1:
 *     win → shares·(1−restPx); loss → −1; PLUS rebateRate·takerFeeTotal. The per-share `rebate` arg is
 *     ignored here (the rebate is a share of the fee, not a flat per-share credit).
 *
 * shares = 1/restPx. A NEW fn — NOT a reuse of copy-trade's `netEvPerDollar`. NaN on a degenerate restPx.
 */
export function makerNetEvPerDollar(
  restPx: number,
  won: boolean,
  feeRate: number,
  rebate: number,
  rebateRate = 0,
): number {
  if (!usablePrice(restPx)) return NaN;
  const shares = 1 / restPx;
  const feeUsd = takerFeeTotal(restPx, shares, feeRate);
  const gross = won ? shares * (1 - restPx) : -1;
  if (Number.isFinite(rebateRate) && rebateRate > 0) {
    // realistic weather_fees maker model (takerOnly:true): no fee paid, + a share of the taker's fee.
    return gross + rebateRate * feeUsd;
  }
  const rebateUsd = (Number.isFinite(rebate) ? rebate : 0) * shares;
  const netFee = Math.max(0, feeUsd - rebateUsd);
  return gross - netFee;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// per-bid maker entry (SOLE owner of entry-snapshot resolution — Pass-1 integrity)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Simulate ONE resting maker bid end-to-end. The SOLE owner of `snapshotAtOrAfter(entryTs)` — it
 * resolves the entry snapshot, prices the rested bid, gates on cheap-eligibility, runs the fill
 * model over the post-entry series, and (only when filled) grades + computes the fee-net EV. Pure;
 * never throws. No usable entry book / null restPx ⇒ { eligibleCheap:false, filled:false,
 * netEvFilled:NaN }.
 */
export function makerEntry(bid: RestingBid, opts: MakerSprayOpts = {}): MakerEntry {
  const rule = opts.rule ?? 'bid';
  const fillModel = opts.fillModel ?? 'ask_touch';
  const cheapMax = opts.cheapMax ?? 0.25;
  const cheapMin = opts.cheapMin ?? 0;
  const rebate = opts.rebate ?? 0;
  const rebateRate = opts.rebateRate ?? 0;
  const askOffset = opts.askOffset ?? 0.07;
  const tickSize =
    Number.isFinite(bid.tickSize) && bid.tickSize > 0 ? bid.tickSize : (opts.tickSize ?? 0.01);
  const feeRate = Number.isFinite(bid.feeRate) ? bid.feeRate : (opts.feeRate ?? 0.05);
  const won = bid.bucketWon === true;
  const leadHours = (bid.resolutionTs - bid.entryTs) / 3600;

  const series = Array.isArray(bid.snapshots) ? bid.snapshots : [];
  // snapshotAtOrAfter accepts the structural-superset FillSnapshot[] (it reads only capturedAt).
  const entrySnapshot = snapshotAtOrAfter(series, bid.entryTs);

  const empty = (): MakerEntry => ({
    restPx: null,
    entrySnapshot,
    eligibleCheap: false,
    filled: false,
    minAskAfter: null,
    won,
    netEvFilled: NaN,
    edgeFilled: NaN,
    restVsMid: NaN,
    leadHours,
  });

  if (entrySnapshot === null) return empty();

  const restPx = restPrice(entrySnapshot, rule, { tickSize, askOffset });
  if (restPx === null) return { ...empty(), restPx: null };

  // post-entry series = snapshots strictly after the entry snapshot's captured time (the future book
  // a resting maker bid sees evolve toward resolution). entryTs is the gate; the entry snapshot itself
  // is the placement instant, so the fill window is everything captured at/after it.
  const entryCaptured = entrySnapshot.capturedAt;
  const postEntry = series.filter((s) => s.capturedAt >= entryCaptured);

  const restVsMid = usablePrice(entrySnapshot.mid) ? restPx - entrySnapshot.mid : NaN;
  // SELECTION (the forecast axis): 'all' rests on every cheap bucket; 'forecast' rests ONLY where our
  // calibrated prob exceeds the rested price (calibratedP > restPx) — the maker analog of db1's
  // cheap-longshot rule. This is the ONLY place our forecast enters the EV path (in 'forecast' mode).
  const select = opts.select ?? 'all';
  const forecastOk =
    select === 'all' || (Number.isFinite(bid.calibratedP) && bid.calibratedP > restPx);
  const eligibleCheap = restPx >= cheapMin && restPx < cheapMax && postEntry.length > 0 && forecastOk;

  if (!eligibleCheap) {
    return {
      restPx,
      entrySnapshot,
      eligibleCheap: false,
      filled: false,
      minAskAfter: null,
      won,
      netEvFilled: NaN,
      edgeFilled: NaN,
      restVsMid,
      leadHours,
    };
  }

  const { filled, minAskAfter } = simulateFill(restPx, postEntry, fillModel);
  const netEvFilled = filled ? makerNetEvPerDollar(restPx, won, feeRate, rebate, rebateRate) : NaN;
  const edgeFilled = filled ? (won ? 1 : 0) - restPx : NaN;

  return {
    restPx,
    entrySnapshot,
    eligibleCheap: true,
    filled,
    minAskAfter,
    won,
    netEvFilled,
    edgeFilled,
    restVsMid,
    leadHours,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// aggregate report
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const evCiOf = (values: number[], seed: number): EvCi => {
  const finite = values.filter((v) => Number.isFinite(v));
  const b = bootstrapMeanCi(finite, { seed });
  return { ev: b.mean, evCiLo: b.lo, evCiHi: b.hi, n: b.n };
};

const median = (sortedAsc: number[]): number => {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedAsc[mid]! : (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
};

/** Median inter-snapshot gap (seconds) across all bids' series — the 30-min-grid diagnostic. */
function gridMedianGap(bids: RestingBid[]): number {
  const gaps: number[] = [];
  for (const b of bids) {
    const s = b.snapshots;
    for (let i = 1; i < s.length; i++) {
      const g = s[i]!.capturedAt - s[i - 1]!.capturedAt;
      if (Number.isFinite(g) && g > 0) gaps.push(g);
    }
  }
  gaps.sort((a, b) => a - b);
  return median(gaps);
}

/**
 * A within-station outcome shuffle for the zero-skill MC. Builds a {station → won[]} index ONCE
 * (deterministic, SQL-ordered), then a closure that returns a fresh shuffled `won` array per call
 * using the supplied RNG (Fisher–Yates within each station's index list).
 */
function makeStationShuffler(
  entries: { station: string; won: boolean }[],
): (rand: () => number) => number[] {
  const byStation = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const arr = byStation.get(e.station);
    if (arr) arr.push(i);
    else byStation.set(e.station, [i]);
  });
  const baseWon = entries.map((e) => (e.won ? 1 : 0));
  return (rand: () => number): number[] => {
    const shuffled = baseWon.slice();
    for (const idxs of byStation.values()) {
      // permute the won-flags WITHIN this station's positions (Fisher–Yates)
      const vals = idxs.map((i) => baseWon[i]!);
      for (let k = vals.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        const tmp = vals[k]!;
        vals[k] = vals[j]!;
        vals[j] = tmp;
      }
      idxs.forEach((pos, k) => {
        shuffled[pos] = vals[k]!;
      });
    }
    return shuffled;
  };
}

/**
 * Run the maker spray over a set of resting bids. Filters to cheap-eligible with a usable post-entry
 * book, simulates each (the fill model + grading), and aggregates the binding headline (filled
 * fee-net EV CI), the filled edge, the adverse-selection gating sanity, Brier-vs-market, the
 * zero-skill MC false-positive rate, the per-station REAL CIs, the rest-vs-mid character, and the
 * coverage/tz-skew diagnostics. Pure + total — empty / all-ineligible → a zeroed report (NaN point
 * estimates), never throws.
 *
 * The zero-skill MC is NOT circular (Pass-2 5a): each iteration shuffles `won` within each station,
 * recomputes ONLY a lightweight mini-report { filledNetEv, perStation }, and calls `makerSprayVerdict`
 * in MC-mode on THAT — never reading `report.zeroSkillMc`.
 */
export function simulateSpray(bids: RestingBid[], opts: MakerSprayOpts = {}): MakerSprayReport {
  const seed = opts.bootstrapSeed ?? 42;
  const mcIters = opts.mcIters ?? 1000;
  const rebate = opts.rebate ?? 0;
  const rebateRate = opts.rebateRate ?? 0;

  const candidates = Array.isArray(bids) ? bids : [];
  const entries = candidates.map((b) => ({ bid: b, entry: makerEntry(b, opts) }));

  const eligible = entries.filter((e) => e.entry.eligibleCheap);
  const filled = eligible.filter((e) => e.entry.filled);

  const nCandidates = candidates.length;
  const nCheapEligible = eligible.length;
  const nFilled = filled.length;
  const fillRate = nCheapEligible === 0 ? NaN : nFilled / nCheapEligible;

  // ── BINDING headline: pooled filled fee-net EV CI (seed 42) ──────────────────────────────────────
  const filledNetEvValues = filled.map((e) => e.entry.netEvFilled);
  const filledNetEv = evCiOf(filledNetEvValues, seed);

  // ── filled maker edge (won − restPx), mean ± z·SE ────────────────────────────────────────────────
  const filledEdgeVals = filled.map((e) => e.entry.edgeFilled).filter((v) => Number.isFinite(v));
  const edgeCi = meanConfidenceInterval(filledEdgeVals);
  const filledEdge = { mean: edgeCi.mean, ciLo: edgeCi.lo, ciHi: edgeCi.hi, n: edgeCi.n };

  // ── adverse-selection gating sanity (R-4): filled hit rate vs all-eligible hit rate ──────────────
  const nFilledWon = filled.filter((e) => e.entry.won).length;
  const nEligibleWon = eligible.filter((e) => e.entry.won).length;
  const filledHitRate = nFilled === 0 ? NaN : nFilledWon / nFilled;
  const allEligibleHitRate = nCheapEligible === 0 ? NaN : nEligibleWon / nCheapEligible;
  const adverseSelection: AdverseSel = {
    filledHitRate,
    allEligibleHitRate,
    nFilled,
    nEligible: nCheapEligible,
    // AS confirmed iff the filled set hits LESS often than the eligible base rate (losers fill).
    asConfirmed:
      Number.isFinite(filledHitRate) &&
      Number.isFinite(allEligibleHitRate) &&
      filledHitRate < allEligibleHitRate,
  };

  // ── Brier(ours) vs Brier(market-implied-at-entry) over filled-eligible events (F-006) ────────────
  // 2-category ladder per bid: [P(this bucket wins), P(it loses)]; outcomeIdx = won ? 0 : 1.
  const brierBids = eligible.filter(
    (e) => Number.isFinite(e.bid.calibratedP) && usablePrice(e.bid.marketProbAtEntry),
  );
  const oursBriers: number[] = [];
  const marketBriers: number[] = [];
  for (const e of brierBids) {
    const outcomeIdx = e.entry.won ? 0 : 1;
    const pOurs = Math.min(1, Math.max(0, e.bid.calibratedP));
    const pMkt = Math.min(1, Math.max(0, e.bid.marketProbAtEntry!));
    oursBriers.push(brierScore([pOurs, 1 - pOurs], outcomeIdx));
    marketBriers.push(brierScore([pMkt, 1 - pMkt], outcomeIdx));
  }
  const meanOf = (xs: number[]): number =>
    xs.length === 0 ? NaN : xs.reduce((a, v) => a + v, 0) / xs.length;
  const oursBrier = meanOf(oursBriers);
  const marketBrier = meanOf(marketBriers);
  const brierVsMarket: BrierDelta = {
    ours: oursBrier,
    market: marketBrier,
    delta: Number.isFinite(oursBrier) && Number.isFinite(marketBrier) ? oursBrier - marketBrier : NaN,
    nEvents: brierBids.length,
  };

  // ── per-station REAL bootstrap CIs (so the verdict only READS them, never re-stats) ──────────────
  const perStation = new Map<string, { filledNetEv: EvCi; nFilled: number }>();
  const stationFilled = new Map<string, number[]>();
  for (const e of filled) {
    const arr = stationFilled.get(e.bid.station);
    if (arr) arr.push(e.entry.netEvFilled);
    else stationFilled.set(e.bid.station, [e.entry.netEvFilled]);
  }
  for (const [station, vals] of stationFilled) {
    perStation.set(station, { filledNetEv: evCiOf(vals, seed), nFilled: vals.length });
  }

  // ── rest-vs-mid character ────────────────────────────────────────────────────────────────────────
  const rvm = eligible.map((e) => e.entry.restVsMid).filter((v) => Number.isFinite(v));
  const restVsMid = {
    mean: rvm.length ? rvm.reduce((a, v) => a + v, 0) / rvm.length : NaN,
    fracBelowMid: rvm.length ? rvm.filter((v) => v < 0).length / rvm.length : NaN,
    n: rvm.length,
  };

  // ── coverage + tz-skew ───────────────────────────────────────────────────────────────────────────
  const nWithBook = candidates.filter((b) => b.snapshots.length > 0).length;
  const nWithPostEntrySeries = eligible.length;
  const gridMedianGapSec = gridMedianGap(candidates);
  const maxTzSkewHours = candidates.reduce(
    (m, b) => (Number.isFinite(b.tzOffsetHours) ? Math.max(m, Math.abs(b.tzOffsetHours)) : m),
    0,
  );
  const coverage = { nWithBook, nWithPostEntrySeries, gridMedianGapSec, maxTzSkewHours };

  // ── zero-skill Monte-Carlo (NON-CIRCULAR — Pass-2 5a) ────────────────────────────────────────────
  // Shuffle `won` within each station, rebuild ONLY { filledNetEv, perStation } from the SAME
  // filled set's restPx/feeRate (re-grading EV under the shuffled outcome), and call
  // makerSprayVerdict in MC-mode on that mini-report. pPass = fraction passing the pooled gate.
  const mcFilled = filled.map((e) => ({
    station: e.bid.station,
    restPx: e.entry.restPx as number,
    feeRate: Number.isFinite(e.bid.feeRate) ? e.bid.feeRate : (opts.feeRate ?? 0.05),
    won: e.entry.won,
  }));
  const zeroSkillMc = runZeroSkillMc(mcFilled, { seed, iters: mcIters, rebate, rebateRate });

  return {
    nCandidates,
    nCheapEligible,
    nFilled,
    fillRate,
    filledNetEv,
    filledEdge,
    adverseSelection,
    brierVsMarket,
    zeroSkillMc,
    perStation,
    restVsMid,
    coverage,
  };
}

/**
 * The zero-skill Monte-Carlo driver (extracted so the circularity break is explicit). For each of
 * `iters` iterations it shuffles `won` within each station (seeded mulberry32), re-grades the filled
 * fee-net EV under the shuffled outcome, builds a lightweight mini-report { filledNetEv, perStation },
 * and calls `makerSprayVerdict` in MC-MODE on it. The mini-report carries NO `zeroSkillMc` field, so
 * the verdict→report→MC→verdict loop is broken: this path reads only `filledNetEv` + `perStation`.
 * pPass = fraction of iterations whose mini-verdict passes the pooled gate.
 */
function runZeroSkillMc(
  filled: { station: string; restPx: number; feeRate: number; won: boolean }[],
  opts: { seed: number; iters: number; rebate: number; rebateRate?: number; marginThreshold?: number },
): ZeroSkillMc {
  const iters = opts.iters;
  if (filled.length === 0 || iters <= 0) return { pPass: NaN, iters: Math.max(0, iters) };

  const shuffler = makeStationShuffler(filled);
  const rand = mulberry32(opts.seed);
  // Each MC iteration uses its own deterministic seed derived from the master rand, so the shuffle
  // sequence is reproducible run-to-run (byte-identical determinism).
  let passes = 0;
  for (let it = 0; it < iters; it++) {
    const shuffledWon = shuffler(rand);
    // re-grade fee-net EV under the shuffled outcome
    const netEvs = filled.map((f, i) =>
      makerNetEvPerDollar(f.restPx, shuffledWon[i] === 1, f.feeRate, opts.rebate, opts.rebateRate),
    );
    const pooled = evCiOf(netEvs, opts.seed);
    // per-station mini CIs
    const byStation = new Map<string, number[]>();
    filled.forEach((f, i) => {
      const arr = byStation.get(f.station);
      if (arr) arr.push(netEvs[i]!);
      else byStation.set(f.station, [netEvs[i]!]);
    });
    const perStation = new Map<string, { filledNetEv: EvCi; nFilled: number }>();
    for (const [station, vals] of byStation) {
      perStation.set(station, { filledNetEv: evCiOf(vals, opts.seed), nFilled: vals.length });
    }
    const mini = miniReport(pooled, perStation);
    const v = makerSprayVerdict(mini, {
      marginThreshold: opts.marginThreshold,
      mcMode: true,
    });
    if (v.pass) passes++;
  }
  return { pPass: passes / iters, iters };
}

/**
 * A lightweight mini-report carrying ONLY { filledNetEv, perStation } (the two fields MC-mode reads).
 * Every other field is a benign zero/empty placeholder so the shape type-checks as a MakerSprayReport
 * — MC-mode `makerSprayVerdict` never touches them.
 */
function miniReport(
  filledNetEv: EvCi,
  perStation: Map<string, { filledNetEv: EvCi; nFilled: number }>,
): MakerSprayReport {
  return {
    nCandidates: 0,
    nCheapEligible: 0,
    nFilled: filledNetEv.n,
    fillRate: NaN,
    filledNetEv,
    filledEdge: { mean: NaN, ciLo: NaN, ciHi: NaN, n: 0 },
    adverseSelection: {
      filledHitRate: NaN,
      allEligibleHitRate: NaN,
      nFilled: 0,
      nEligible: 0,
      // In MC-mode the verdict must NOT read this — set true so any accidental read can't flip asSuspect
      // on (a defensive default; MC-mode skips asSuspect entirely).
      asConfirmed: true,
    },
    brierVsMarket: { ours: NaN, market: NaN, delta: NaN, nEvents: 0 },
    zeroSkillMc: { pPass: NaN, iters: 0 },
    perStation,
    restVsMid: { mean: NaN, fracBelowMid: NaN, n: 0 },
    coverage: { nWithBook: 0, nWithPostEntrySeries: 0, gridMedianGapSec: NaN, maxTzSkewHours: 0 },
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// verdict
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Adjudicate a report against the FROZEN kill-criterion (ADR-08, MAKER-SPRAY-SIM.md §9 — written
 * before the number was seen; WO-5 discipline, do not move to fit the result):
 *
 *   PASS = the POOLED filled fee-net EV 95% bootstrap CI lower bound clears 0 (the BINDING gate).
 *   FAIL = the CI straddles/below 0 → the market is efficient to a rested maker bid too; the live
 *          rail stays dormant; the clean maker-efficiency measurement IS the deliverable.
 *
 * It READS per-station `filledNetEv.evCiLo` (already computed) to COUNT clearing stations — it does
 * NOT re-stat (Pass-1 W5: an EvCi cannot be re-run through armEdgeStats; the twin copyTradeVerdict
 * calls nothing). The ≥2-stations / not-EHAM descriptors are reported, NOT co-equal gates (W4).
 *
 * MC-MODE (Pass-2 5a): when `opts.mcMode`, the verdict reads ONLY `filledNetEv` + `perStation` and
 * never touches `zeroSkillMc` / `adverseSelection` — so it is safe to call inside simulateSpray's MC
 * on a mini-report. A NaN CI → pass:false (insufficient evidence fails the gate, the goLiveGate idiom).
 */
export function makerSprayVerdict(
  report: MakerSprayReport,
  opts: {
    marginThreshold?: number;
    minStations?: number;
    mcMode?: boolean;
    /**
     * Sufficiency floor on `nFilled` (default 1 — only a ZERO-fill run is insufficient, so every
     * pre-existing caller is unaffected). §16.6 freezes 200 for the maker-band adjudication; the
     * script wires that as its CLI default. Never applied in `mcMode`: the shuffled mini-report is a
     * skill test on the SAME fills, so the floor belongs to the one real top-level verdict.
     */
    minFilled?: number;
  } = {},
): MakerSprayVerdict {
  const marginThreshold = opts.marginThreshold ?? 0.02;
  const minFilled = opts.minFilled ?? 1;
  const net = report.filledNetEv;
  const insufficient = !opts.mcMode && report.nFilled < minFilled;
  const pass = !insufficient && Number.isFinite(net.evCiLo) && net.evCiLo > 0;
  const clearsMargin = pass && Number.isFinite(net.ev) && net.ev >= marginThreshold;

  // Robustness descriptors — COUNT stations whose own filled-EV CI clears 0 (read, never re-stat).
  const stationsClearing: string[] = [];
  for (const [station, st] of report.perStation) {
    if (Number.isFinite(st.filledNetEv.evCiLo) && st.filledNetEv.evCiLo > 0) {
      stationsClearing.push(station);
    }
  }
  stationsClearing.sort(); // deterministic (SQL/insertion-order-independent)
  const ehamOnly = stationsClearing.length === 1 && stationsClearing[0] === 'EHAM';

  // MC-mode: read ONLY filledNetEv + perStation; never touch zeroSkillMc / adverseSelection.
  const zeroSkillPPass = opts.mcMode ? NaN : report.zeroSkillMc.pPass;
  const asSuspect = opts.mcMode ? false : !report.adverseSelection.asConfirmed;

  const pctf = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');
  const summary = insufficient
    ? `INSUFFICIENT — ${report.nFilled} filled bid(s), below the ${minFilled}-fill sufficiency floor: ` +
      'the pooled CI is not adjudicable. This is NOT evidence of efficiency — the run carries no data.'
    : pass
    ? `PASS — pooled filled fee-net EV ${pctf(net.ev)} /$1, 95% CI [${pctf(net.evCiLo)}, ${pctf(
        net.evCiHi,
      )}] clears 0` +
      (clearsMargin
        ? ` and the +${(marginThreshold * 100).toFixed(0)}% margin`
        : ` but BELOW the +${(marginThreshold * 100).toFixed(0)}% margin`) +
      ` (${stationsClearing.length} station(s) clear; zero-skill P(PASS) ${pctf(zeroSkillPPass)}${
        asSuspect ? '; AS NOT confirmed — SUSPECT' : ''
      })`
    : `FAIL — pooled filled fee-net EV ${pctf(net.ev)} /$1, 95% CI [${pctf(net.evCiLo)}, ${pctf(
        net.evCiHi,
      )}] does not clear 0 → market efficient to a rested maker bid`;

  return {
    pass,
    insufficient,
    clearsMargin,
    stationsClearing,
    ehamOnly,
    zeroSkillPPass,
    asSuspect,
    filledNetEv: net,
    marginThreshold,
    summary,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// fill-model cross-validation (F-008)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * F-008 anchor. badatmath's OWN cheap fills DID execute at their price — what fraction does our fill
 * model PREDICT filled, given the same book series? Low agreement ⇒ the 30-min grid is too coarse to
 * trust ⇒ the headline is caveated, not trusted. Pure; never throws. Empty → { agreementRate:NaN, n:0 }.
 */
export function crossValidateFillModel(
  realFills: { restPx: number; postEntry: FillSnapshot[] }[],
  model: FillModel,
): CrossValResult {
  const fills = Array.isArray(realFills) ? realFills.filter((f) => usablePrice(f.restPx)) : [];
  const n = fills.length;
  if (n === 0) return { agreementRate: NaN, n: 0 };
  let agree = 0;
  for (const f of fills) {
    const { filled } = simulateFill(f.restPx, f.postEntry, model);
    if (filled) agree++;
  }
  return { agreementRate: agree / n, n };
}

// armEdgeStats / GradedBet / wilsonInterval are re-exported for the script spine (P1) so it never
// reaches past this module for the stats it grades the spray-protocol by-product with.
export { armEdgeStats, wilsonInterval };
export type { GradedBet };
