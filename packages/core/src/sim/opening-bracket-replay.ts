/**
 * core/sim/opening-bracket-replay — the PURE bracket-EXIT replay engine for the opening-convergence panel
 * (the companion to sim/opening-convergence.ts + the hold-to-resolution scorer in opening-resolution-score.ts).
 *
 * WHY THIS EXISTS. opening-resolution-score scores BUY-and-HOLD-to-resolution (does our forecast-center bucket
 * win more often than it costs?). This engine scores the OTHER bet — the actual thesis — the BRACKET EXIT:
 * buy the forecast-center cheap, then SELL INTO THE CONVERGENCE *before* resolution on a fixed take-profit /
 * stop-loss / station-local-noon time-stop. It answers what the hold scorer cannot: does the bracket exit net
 * positive after spread + fees + the stop-loss leg — i.e. is there a convergence-re-rating edge that does NOT
 * depend on the forecast being correct at resolution.
 *
 * The flat-open premise was falsified 2026-06-28 (markets list pre-informed), so the entry here runs with
 * selectEntries(..., { requireFlatOpen: false }) — every OTHER gate (universe, runway, mode, edge, depth, the
 * 20% price cap) is preserved; ONLY the flat-open gate is skipped. A forward mark-path probe over the captured
 * data showed the bracket-exit mechanism has a pulse (execBid re-rates UP ~79% of enterable events, a profitable
 * sell-back existed ~62%, avg best round-trip +10.4pp vs entry ask) — BUT only ~12% reached the configured +25pp
 * take-profit. "A profitable exit existed" is a LOOK-AHEAD ceiling, not a capture rule. This engine applies the
 * REAL fixed bracket rule (no look-ahead) for the honest net P&L, and SWEEPS the take-profit to see whether a
 * lower TP harvests the convergence better than +25pp.
 *
 * NO LOOK-AHEAD (the load-bearing invariant). The exit decision at tick t reads ONLY the execBid mark at t + the
 * wall clock at t; the series is walked in time order and the exit loop BREAKS at the first firing — a later
 * up-tick can NEVER rescue a trade that already stopped out. The ONE legitimate use of a later tick is the
 * maker-fill model: a resting maker BUY fills only if a LATER ask trades THROUGH the limit (the order rests in
 * the book — realistic paperFill maker semantics, not look-ahead). bestReachableBid is computed in a SEPARATE
 * pass and is REPORT-ONLY (the ceiling-vs-capture gap diagnostic) — it never touches a decision.
 *
 * Pure + total (junk → executed:false / NaN / [], never throws). Imports only ./opening-convergence.ts,
 * ./fees.ts, ./time.ts — NEVER io/trading. Reuses selectEntries / bracketDecision / paperFill / openingVerdict
 * verbatim (one source of truth for "what would we do"); this engine is only the per-tick LIFECYCLE around them.
 */
import {
  selectEntries,
  bracketDecision,
  paperFill,
  openingVerdict,
  type OpeningBucket,
  type OpeningCfg,
  type OpeningCapture,
  type OpeningMarketResult,
  type OpeningLabel,
  type VerdictOpts,
  type EntryCandidate,
  type OpenPosition,
  type PaperFill,
} from './opening-convergence.ts';
import { takerFeePerShare } from '../fees.ts';

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** a missing/absent book field → NaN (the file's convention for "not observed"), never a silent 0. */
const numOrNaN = (v: number | null | undefined): number => (fin(v) ? v : NaN);

/** mean (NaN on empty) — local copy so the engine pulls in no stats dep. */
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One captured order-book snapshot of a market (the bracket-replay view of an `opening_captures` row). */
export interface ReplayTick {
  /** the capture wall-clock (ISO) — the tick's time, used for the maker window + the time-stop clock. */
  capturedAt: string;
  buckets: OpeningBucket[];
  /** the city's IANA tz NAME (for the DST-correct local-noon time-stop). */
  tz: string;
  /** station-local YYYY-MM-DD (the time-stop calendar day). */
  targetDate: string;
  /** now − createdAtGamma at this tick (the listing-anchor age; isFlatOpen/selectEntries read it). */
  hoursSinceListing: number;
}

/** One market's full replay input: ordered ticks + the event's resolution. */
export interface EventReplayInput {
  eventId: string;
  city: string;
  targetDate: string;
  tz: string;
  /** the capture series ordered ASCENDING by capturedAt (a future tick must never precede an earlier one). */
  ticks: ReplayTick[];
  resolution: {
    /** poly_resolved_winner_idx ?? winning_bucket_idx (venue where settled, else our truth grade); null = unresolved. */
    winnerIdx: number | null;
    /** our grader flagged venue↔truth disagreement — ambiguous payout, dropped from the verdict panel. */
    gradingMismatch: boolean;
  };
}

/** One market's realized bracket trade (or a non-fill). */
export interface BracketTrade {
  /** hours_since_listing at the FILL tick (when capital was actually deployed); null when never filled. */
  entryAgeH: number | null;
  /** the realized BUY price (makerLimit on a maker fill, worse-of+slippage on a taker fallback). */
  entryPrice: number;
  isMaker: boolean;
  // ── the ENTRY-TICK BOOK (the four fields below are snapshotted at the FILL tick — the tick capital was actually
  //    deployed, the same tick entryAgeH and entryPrice are anchored to, NOT the earlier decision tick a maker order
  //    was placed on). REPORT-ONLY: nothing in this engine reads them. They exist so an INVERSE-SIDE arm (buy NO
  //    instead of YES) is computable as post-processing on the SAME executed population — identical selection,
  //    identical gates, inverse side — rather than needing a second engine. All NaN when never filled. ──
  /** the YES bestBid at the fill tick. NaN when the book showed no bid (or the bucket vanished from the ladder). */
  entryBestBid: number;
  /** the YES executable (depth-walked) BID at the fill tick — a NO position's cost basis is `1 − this`. NaN when
   *  the source row predates the exit-side columns (the earliest archive shards carry no execBid at all). */
  entryExecBid: number;
  /** buyable $ (ask-side depth-walk) at the fill tick — the YES arm's executable size. */
  entryDepthUsd: number;
  /** sellable $ (BID-side depth-walk) at the fill tick — the size someone could hit the YES bid for, i.e. the
   *  executable-depth check for the NO arm. ⚠ 0 IS AMBIGUOUS: it means both "genuinely no bid-side depth" and
   *  "this row has no sellback_depth_usd field at all" (mapBucket floors that absent column to 0, not null). */
  entrySellbackDepthUsd: number;
  /** the forecast-center bucket label we BOUGHT — the predicted-Tmax bucket / the temperature the bet opened on. */
  entryLabel: string;
  /** the ladder idx we BOUGHT (−1 when never filled) — REPORT-ONLY; the selection-rule attribution key. */
  bucketIdx: number;
  /** REPORT-ONLY momentum-vs-information diagnostic: would the bucket we bought have WON at resolution?
   *  null = unknown (unresolved or grading_mismatch). Read against a take_profit exit it separates "we harvested
   *  a transient re-rating bump" (mostly false) from "the market was pricing in a correct outcome" (mostly true).
   *  NEVER a decision input — it reads the resolution, which the replay cannot see at decision time. */
  wouldHaveWonAtResolution: boolean | null;
  /** the exit kind + reason (take_profit / stop_loss / time_stop / resolution_settle / mtm_*). */
  exitReason: string;
  /** the realized SELL/settle price (execBid on a bracket exit, $1/$0 on resolution, last bid on a mark). */
  exitPrice: number;
  netPnlUsd: number;
  stakeUsd: number;
  netReturn: number;
  executed: boolean;
  /** the MAX execBid reached after entry (the look-ahead ceiling) — REPORT-ONLY, NEVER used in the decision. */
  bestReachableBid: number;
  /** POST-REALIZATION counterfactual (bracket exits only — NaN for resolution-settle / mtm / non-fills): the
   *  BEST realizable value the market reached AFTER our exit tick — max(later execBids, the resolution payout if
   *  it settled). "Did holding past our exit do better?" REPORT-ONLY, never a decision. */
  postExitBestBid: number;
  /** the WORST realizable value after our exit tick — min(later execBids, the resolution payout). REPORT-ONLY. */
  postExitWorstBid: number;
}

/** One take-profit's panel summary (the verdict numbers + the ceiling-vs-capture gap). */
export interface TpSweepRow {
  tpDeltaPp: number;
  /** all input markets considered (excludes grading_mismatch). */
  nEvents: number;
  /** markets that produced a fill (ENTERED) — incl. still-in-flight marked-open positions; the entry-rate numerator. */
  nExecuted: number;
  /** nExecuted / nEvents — the share of considered markets the bracket rule actually entered. */
  executedFrac: number;
  // ── the openingVerdict numbers: REALIZED markets only (bracket-exited or resolution-settled; in-flight
  //    mtm_unresolved marks are EXCLUDED so the §9R-E gate certifies CLOSED net profit, not unrealized marks) ──
  nMarkets: number;
  nCities: number;
  nDistinctDays: number;
  winFrac: number;
  meanNetReturn: number;
  ciLow: number;
  ciHigh: number;
  zeroSkillPassRate: number;
  /** what the FIXED rule actually caught: mean realized per-$ net return over executed trades. */
  ruleCaptureRoi: number;
  /** the look-ahead ceiling: mean (bestReachableBid − entryPrice) over executed trades (price pp; a sell-back COULD
   *  have realised this, the rule did not). The gap to ruleCaptureRoi is the headroom a smarter exit might harvest. */
  avgBestReachableRoundtrip: number;
  label: OpeningLabel;
  reason: string;
}

/** The full TP sweep + the pre-registered headline gate. */
export interface BracketPanel {
  perTp: TpSweepRow[];
  /** the PRE-REGISTERED bot-default tpDeltaPp (cfg.tpDeltaPp) — THAT row is THE GATE; the rest of the sweep is
   *  EXPLORATORY (selecting the best TP in-sample is the winner's-curse — never promote a swept TP to a GO). */
  headlineTp: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** the same bucket across a later tick, by idx identity (null if the book dropped it). */
function bucketOf(tick: ReplayTick, idx: number): OpeningBucket | undefined {
  return (Array.isArray(tick.buckets) ? tick.buckets : []).find((b) => b && b.idx === idx);
}

/** build the OpeningCapture selectEntries reads from one tick + the event meta. */
function captureOf(input: EventReplayInput, tick: ReplayTick): OpeningCapture {
  return {
    eventId: input.eventId,
    city: input.city,
    targetDate: tick.targetDate || input.targetDate,
    tz: tick.tz || input.tz,
    createdAtGamma: null,
    hoursSinceListing: tick.hoursSinceListing,
    resolvesAt: null,
    negRisk: true,
    evVol24h: null,
    buckets: Array.isArray(tick.buckets) ? tick.buckets : [],
    houseSeeded: true,
  };
}

/**
 * OPTIONAL replay overrides (the 2026-07-24 MARKET-SIGNAL seam — scripts/research/convergence-capture-score.ts).
 * Both default off ⇒ byte-identical to the frozen forecast-seeded replay.
 *
 *  - selectRule(pastTicks, i): the center bucket idx to buy at tick `i`, chosen from the MARKET's revealed
 *    signal instead of our forecast's argmax(houseProb). NO LOOK-AHEAD IS STRUCTURALLY ENFORCED: the rule is
 *    handed `ticks.slice(0, i + 1)` — a fresh array that physically cannot contain a future tick — so a rule
 *    cannot cheat even by accident. Returning null falls back to the default forecast-argmax center.
 *  - ignoreHouseEdge: forwarded verbatim to selectEntries (drop the model-edge requirement; the entry
 *    reservation becomes the hard maxEntryPrice cap). Also governs the no-chase taker-fallback reservation
 *    below, so the two stay the same bar.
 */
export interface ReplayOpts {
  selectRule?: (ticks: ReplayTick[], i: number) => number | null;
  ignoreHouseEdge?: boolean;
  /**
   * How a `selectRule` returning null is read. Default (false, and the frozen behavior) = "no opinion, use the
   * forecast argmax". True = "no signal at this tick, DO NOT ENTER — try the next tick".
   *
   * This matters more than it looks. A market-signal arm that falls back to argmax(houseProb) whenever its rule
   * is silent is not a market-signal arm — it is a BLEND of the market rule and the forecast control, and the
   * contamination is worst exactly where the rule is weakest. It also makes a "wait for the signal" rule
   * expressible at all (e.g. a momentum rule that needs a prior tick before it can say anything).
   */
  requireRuleTarget?: boolean;
}

const NOT_EXECUTED = (reason: string): BracketTrade => ({
  entryAgeH: null,
  entryPrice: NaN,
  isMaker: false,
  entryBestBid: NaN,
  entryExecBid: NaN,
  entryDepthUsd: NaN,
  entrySellbackDepthUsd: NaN,
  entryLabel: '',
  bucketIdx: -1,
  wouldHaveWonAtResolution: null,
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · replayEvent — the per-market bracket lifecycle (entry → maker/taker fill → bracket exit → settle)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The entry leg's result: the chosen forecast-center candidate + the maker/taker fill + its tick indices. */
export interface EntryFill {
  chosen: EntryCandidate;
  entryIdx: number;
  fillIdx: number;
  fill: PaperFill;
  isMaker: boolean;
}

/**
 * The SHARED entry leg — find the first enterable tick, pick the forecast-center candidate (argmax houseProb),
 * and run the maker-first fill lifecycle (rest at makerLimit; fill maker if a later ask trades THROUGH the limit
 * within makerFillWindowMin, else cancel + taker fallback). Pure + total — returns the fill, or a `reason` string
 * ('no_ticks'|'never_enterable'|'never_filled'). Extracted so the taker bracket engine (replayEvent) AND the
 * maker-EXIT engine (sim/opening-maker-exit-replay.ts) share ONE tested entry path — the entry leg is identical
 * across the two; only the exit differs. (selectEntries' requireFlatOpen:false is the post-falsification universe.)
 */
export function enterAndFill(
  input: EventReplayInput,
  cfg: OpeningCfg,
  opts?: ReplayOpts,
): EntryFill | { reason: string } {
  if (!input || !Array.isArray(input.ticks) || input.ticks.length === 0) return { reason: 'no_ticks' };
  const ticks = input.ticks;
  const ignoreHouseEdge = opts?.ignoreHouseEdge === true;

  // ── (1) find the FIRST enterable tick + the center candidate ──────────────────────────────────────────
  // the OPTIONAL minEntryAgeH entry-timing gate (0/unset = off → byte-identical): skip ticks younger than the
  // floor; an unknown age fails the armed gate (fail closed — cannot verify "old enough").
  const minAgeH = cfg.minEntryAgeH ?? 0;
  let entryIdx = -1;
  let chosen: EntryCandidate | null = null;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    if (minAgeH > 0 && !(fin(t.hoursSinceListing) && t.hoursSinceListing >= minAgeH)) continue;
    // the OPTIONAL market-signal target (unset = the frozen forecast argmax). ticks.slice(0, i + 1) is the
    // no-look-ahead enforcement: the rule is handed a COPY that ends at the current tick.
    const target = opts?.selectRule ? opts.selectRule(ticks.slice(0, i + 1), i) : null;
    // a silent rule under requireRuleTarget means "no signal yet", NOT "use the forecast" — skip the tick.
    if (opts?.requireRuleTarget === true && opts.selectRule && !fin(target)) continue;
    const cands = selectEntries(captureOf(input, t), cfg, new Date(t.capturedAt), {
      requireFlatOpen: false,
      ...(fin(target) ? { targetIdx: target } : {}),
      ...(ignoreHouseEdge ? { ignoreHouseEdge: true } : {}),
    });
    if (cands.length > 0) {
      // Default (no explicit target): the forecast CENTER = the highest-modelProb (argmax houseProb) candidate.
      // With an explicit market-signal target: the TARGET bucket itself when selectEntries admitted it (the
      // centerHalfWidth neighbours are still emitted and still enterable, but the signal named ONE bucket —
      // buying a neighbour instead would silently re-introduce a different selection rule). Falls back to the
      // argmax-modelProb reduce when the target itself failed a gate (which is NaN-total: NaN > NaN is false,
      // so an all-NaN candidate set deterministically keeps the first/lowest idx). ONE entry per event.
      chosen =
        (fin(target) ? cands.find((c) => c.bucketIdx === target) : undefined) ??
        cands.reduce((a, b) => (b.modelProb > a.modelProb ? b : a));
      entryIdx = i;
      break;
    }
  }
  if (!chosen || entryIdx < 0) return { reason: 'never_enterable' };

  // ── (2) maker-first fill lifecycle over LATER ticks (the maker rests in the book) ─────────────────────
  const entryTime = new Date(ticks[entryIdx]!.capturedAt).getTime();
  let fill: PaperFill | null = null;
  let isMaker = false;
  let fillIdx = -1;
  for (let j = entryIdx + 1; j < ticks.length; j++) {
    const t = ticks[j]!;
    const liveAsk = bucketOf(t, chosen.bucketIdx)?.execAsk ?? null;
    const restMin = (new Date(t.capturedAt).getTime() - entryTime) / 60_000;
    if (Number.isFinite(restMin) && restMin >= cfg.makerFillWindowMin) {
      // maker window elapsed (bracketDecision cancel_maker_take) → taker fallback at THIS tick. A vanished
      // center bucket (no live ask) cannot be taken: without this guard paperFill's worse-of would fall back
      // to the now-stale entry-tick ask and record a fill against a book that is no longer there. `continue`
      // (not break) keeps the window elapsed so the take retries when the bucket reappears, else the event
      // ends `never_filled` — matching the bot's real cancel-maker-then-take-the-current-book semantics.
      if (!fin(liveAsk)) continue;
      // the OPTIONAL no-chase guard (unset = off → byte-identical): never take a book that ran away past the
      // reservation the entry decision was priced at — retry when it comes back inside, else never_filled.
      if (cfg.noChaseTakerFallback === true) {
        // the same bar the entry decision passed — which under ignoreHouseEdge is the hard cap alone (a NaN
        // modelProb would otherwise make `liveAsk > NaN` false and disable the guard entirely).
        const reservation = ignoreHouseEdge
          ? cfg.maxEntryPrice
          : Math.min(cfg.maxEntryPrice, chosen.modelProb - cfg.entryEdgeMargin);
        if (liveAsk > reservation) continue;
      }
      fill = paperFill(chosen, chosen.execAsk, liveAsk, cfg, false);
      isMaker = false;
      fillIdx = j;
      break;
    }
    // a resting maker BUY fills only if a LATER ask traded THROUGH the limit (the ONE legit later-tick use).
    const mf = paperFill(chosen, chosen.execAsk, liveAsk, cfg, true);
    if (mf) {
      fill = mf;
      isMaker = true;
      fillIdx = j;
      break;
    }
  }
  if (!fill || fillIdx < 0) return { reason: 'never_filled' }; // order rested unfilled to series end
  return { chosen, entryIdx, fillIdx, fill, isMaker };
}

/**
 * Replay ONE market's bracket trade at a given take-profit. Pure + total.
 *
 *  1. ENTER at the FIRST enterable tick — selectEntries(cap, cfg, tickTime, { requireFlatOpen:false }) — and pick
 *     the forecast CENTER (the candidate with the highest modelProb = argmax houseProb). One entry per event.
 *  2. FILL maker-first: rest at makerLimit; over LATER ticks paperFill maker if an ask trades through the limit
 *     within makerFillWindowMin, else cancel + taker fallback (bracketDecision cancel_maker_take → paperFill taker).
 *  3. EXIT: walk ticks forward from the fill calling bracketDecision(pos, execBid, tickTime, tz, cfgWithTp) until
 *     take_profit / stop_loss / time_stop fires; sell at that tick's execBid (taker fee on the exit). NO LOOK-AHEAD.
 *  4. SETTLE leftover-open-at-series-end at the resolution winner ($1/$0), else mark to the last realizable execBid.
 *
 * cfgWithTp overrides cfg.tpDeltaPp with the swept value. bestReachableBid is a SEPARATE report-only pass.
 */
export function replayEvent(
  input: EventReplayInput,
  cfg: OpeningCfg,
  tpDeltaPp: number,
  opts?: ReplayOpts,
): BracketTrade {
  const ef = enterAndFill(input, cfg, opts);
  if ('reason' in ef) return NOT_EXECUTED(ef.reason);
  const ticks = input.ticks;
  const cfgTp: OpeningCfg = { ...cfg, tpDeltaPp };
  const { chosen, fillIdx, fill, isMaker } = ef;

  const shares = fill.shares;
  const stakeUsd = fill.price * fill.shares;
  const entryFee = fill.feeUsd;
  const entryAgeH = fin(ticks[fillIdx]!.hoursSinceListing) ? ticks[fillIdx]!.hoursSinceListing : null;
  // the FILL-tick book of the bucket we bought — report-only, for the inverse-side (NO) arm's cost basis + capacity.
  const fillBook = bucketOf(ticks[fillIdx]!, chosen.bucketIdx);

  // ── bestReachableBid: a SEPARATE report-only pass over EVERY post-fill tick (NEVER a decision input) ───
  let best = Number.NEGATIVE_INFINITY;
  for (let j = fillIdx; j < ticks.length; j++) {
    const m = bucketOf(ticks[j]!, chosen.bucketIdx)?.execBid ?? null;
    if (fin(m) && m > best) best = m;
  }
  const bestReachableBid = Number.isFinite(best) ? best : NaN;

  // ── (3) bracket exit walk — time-ordered, BREAKS at the first firing (no look-ahead) ──────────────────
  const pos: OpenPosition = {
    entryPrice: fill.price,
    modelProb: chosen.modelProb,
    tokenYes: chosen.tokenYes,
    targetDate: input.targetDate,
    side: 'BUY-YES',
    state: 'armed', // filled — no longer maker_resting
  };
  let exited = false;
  let exitIdx = -1; // the tick we flattened on (for the post-realization curve walk below)
  let exitPrice = NaN;
  let exitReason = '';
  let netPnlUsd = 0;
  let lastBid: number | null = null;
  let firedUnfillable: string | null = null; // a bracket that FIRED but had no bid to flatten into (time_stop only)
  for (let j = fillIdx; j < ticks.length; j++) {
    const t = ticks[j]!;
    const mark = bucketOf(t, chosen.bucketIdx)?.execBid ?? null;
    if (fin(mark)) lastBid = mark;
    const action = bracketDecision(pos, mark, new Date(t.capturedAt), t.tz || input.tz, cfgTp);
    if (action.kind === 'take_profit' || action.kind === 'stop_loss' || action.kind === 'time_stop') {
      // sell at the realizable execBid; a time-stop with no current bid falls to the last seen bid, else
      // (no bid ever) it cannot be flattened on-book → fall through to resolution settlement below.
      const px = fin(mark) ? mark : fin(lastBid) ? lastBid : null;
      if (px != null) {
        const exitFee = takerFeePerShare(px, cfg.takerFeeRate) * shares; // exit is a taker sell into the bid
        exitPrice = px;
        netPnlUsd = shares * px - exitFee - stakeUsd - entryFee;
        exitReason = `${action.kind}:${action.reason}`;
        exited = true;
        exitIdx = j;
      } else {
        // the bracket fired but there is NO bid to flatten into (only a clock-only time_stop reaches here, since
        // bracketDecision returns `hold` on a null mark). It settles below; remember the fired kind so the
        // exit-kind attribution (exitKindOf) survives the fall-through instead of mis-reading as resolution/mtm.
        firedUnfillable = action.kind;
      }
      break; // a fired bracket flattens the position — never reconsider later ticks (NO LOOK-AHEAD)
    }
  }

  // ── (4) settle a position still open at series end (or an un-fillable fired bracket) ──────────────────
  if (!exited) {
    const prefix = firedUnfillable ? `${firedUnfillable}→` : ''; // preserves the fired kind for exitKindOf
    if (!input.resolution.gradingMismatch && input.resolution.winnerIdx != null) {
      const won = input.resolution.winnerIdx === chosen.bucketIdx;
      exitPrice = won ? 1 : 0;
      netPnlUsd = shares * (won ? 1 : 0) - stakeUsd - entryFee; // redeem at resolution — no taker fee
      exitReason = `${prefix}resolution_settle:${won ? 'win' : 'lose'}`;
    } else {
      // unresolved OR ambiguous (grading_mismatch) → mark to the last realizable execBid (conservative; a MARK,
      // not a trade, so no fee). grading_mismatch markets are additionally dropped from the verdict in replayPanel.
      const mtm = fin(lastBid) ? lastBid : 0;
      exitPrice = mtm;
      netPnlUsd = shares * mtm - stakeUsd - entryFee;
      exitReason = `${prefix}${input.resolution.gradingMismatch ? 'mtm_grading_mismatch' : 'mtm_unresolved'}`;
    }
  }

  // ── post-realization curve: only for a genuine bracket exit (we actually flattened a sell before the end).
  //    Walk EVERY tick AFTER the exit and fold in the resolution payout as the terminal "if held" point, so we
  //    can later see whether holding past our exit would have done better/worse. REPORT-ONLY (never a decision). ──
  let postExitBestBid = NaN;
  let postExitWorstBid = NaN;
  if (exited && exitIdx >= 0) {
    let hi = Number.NEGATIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    for (let j = exitIdx + 1; j < ticks.length; j++) {
      const m = bucketOf(ticks[j]!, chosen.bucketIdx)?.execBid ?? null;
      if (fin(m)) {
        if (m > hi) hi = m;
        if (m < lo) lo = m;
      }
    }
    if (!input.resolution.gradingMismatch && input.resolution.winnerIdx != null) {
      const payout = input.resolution.winnerIdx === chosen.bucketIdx ? 1 : 0; // the terminal "held to settle" value
      if (payout > hi) hi = payout;
      if (payout < lo) lo = payout;
    }
    postExitBestBid = Number.isFinite(hi) ? hi : NaN;
    postExitWorstBid = Number.isFinite(lo) ? lo : NaN;
  }

  return {
    entryAgeH,
    entryPrice: fill.price,
    isMaker,
    entryBestBid: numOrNaN(fillBook?.bestBid),
    entryExecBid: numOrNaN(fillBook?.execBid),
    entryDepthUsd: numOrNaN(fillBook?.depthUsd),
    entrySellbackDepthUsd: numOrNaN(fillBook?.sellbackDepthUsd),
    entryLabel: chosen.label,
    bucketIdx: chosen.bucketIdx,
    wouldHaveWonAtResolution:
      input.resolution.gradingMismatch || input.resolution.winnerIdx == null
        ? null
        : input.resolution.winnerIdx === chosen.bucketIdx,
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · replayPanel — sweep the take-profit, run the frozen §9R-E verdict at each, headline the pre-reg TP
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function replayPanel(
  events: EventReplayInput[],
  cfg: OpeningCfg,
  tpValues: number[],
  verdictOpts: VerdictOpts & ReplayOpts = {},
): BracketPanel {
  // the selection seam rides on the same opts bag as the verdict flags (one call site, one object); it is
  // forwarded to replayEvent and IGNORED by openingVerdict, which reads only its own keys.
  const replayOpts: ReplayOpts = {
    selectRule: verdictOpts.selectRule,
    ignoreHouseEdge: verdictOpts.ignoreHouseEdge,
    requireRuleTarget: verdictOpts.requireRuleTarget,
  };
  const evs = (Array.isArray(events) ? events : []).filter((e): e is EventReplayInput => !!e && Array.isArray(e.ticks));
  // the headline TP (cfg.tpDeltaPp) is ALWAYS in the sweep — that row is the pre-registered gate even if a caller
  // passes a --tps set without it. de-dup + sort for a stable table.
  const set = new Set<number>((Array.isArray(tpValues) ? tpValues : []).filter((v) => Number.isFinite(v)));
  set.add(cfg.tpDeltaPp);
  const tps = [...set].sort((a, b) => a - b);

  // grading_mismatch markets are EXCLUDED from scoring (ambiguous payout) — they never count toward executedFrac
  // either (they were never a clean opportunity).
  const considered = evs.filter((e) => !e.resolution?.gradingMismatch);

  const perTp = tps.map((tp): TpSweepRow => {
    const scored: BracketTrade[] = []; // EVERY executed (entered) trade — the entry-rate basis (incl. in-flight)
    const realized: BracketTrade[] = []; // bracket-exited or resolution-settled only — the §9R-E gate basis
    const panel: OpeningMarketResult[] = [];
    for (const e of considered) {
      const t = replayEvent(e, cfg, tp, replayOpts);
      if (t.executed && Number.isFinite(t.netReturn) && Number.isFinite(t.netPnlUsd)) {
        scored.push(t);
        // REALIZED-ONLY gate: exclude still-in-flight, conservatively mark-to-bid positions (mtm_unresolved /
        // a fired-but-unfillable time_stop→mtm). The gate certifies CLOSED net profit; it can never PASS on an
        // unrealized mark (the one path to a false-GO), and the in-flight tail self-realizes within ~24h (noon
        // time-stop), so the ≥40-market floor is reached on closed markets anyway. (grading_mismatch already out.)
        if (!t.exitReason.includes('mtm_')) {
          realized.push(t);
          panel.push({
            city: e.city,
            targetDate: e.targetDate,
            netPnlUsd: t.netPnlUsd,
            stakeUsd: t.stakeUsd,
            netReturn: t.netReturn,
            executed: true,
          });
        }
      }
    }
    const v = openingVerdict(panel, verdictOpts);
    return {
      tpDeltaPp: tp,
      nEvents: considered.length,
      nExecuted: scored.length, // ENTERED (incl. in-flight) — the entry-rate numerator
      executedFrac: considered.length > 0 ? scored.length / considered.length : 0,
      nMarkets: v.nMarkets, // REALIZED/closed only — the gate count
      nCities: v.nCities,
      nDistinctDays: v.nDistinctDays,
      winFrac: v.winFrac,
      meanNetReturn: v.meanNetReturn,
      ciLow: v.ciLow,
      ciHigh: v.ciHigh,
      zeroSkillPassRate: v.zeroSkillPassRate,
      ruleCaptureRoi: mean(realized.map((t) => t.netReturn)), // what the rule actually CAUGHT (closed trades)
      avgBestReachableRoundtrip: mean(
        realized.map((t) => t.bestReachableBid - t.entryPrice).filter((x) => Number.isFinite(x)),
      ),
      label: v.label,
      reason: v.reason,
    };
  });

  return { perTp, headlineTp: cfg.tpDeltaPp };
}
