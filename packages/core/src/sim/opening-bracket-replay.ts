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
  type EntryCandidate,
  type OpenPosition,
} from './opening-convergence.ts';
import { takerFeePerShare } from '../fees.ts';

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

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
  /** the forecast-center bucket label we BOUGHT — the predicted-Tmax bucket / the temperature the bet opened on. */
  entryLabel: string;
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · replayEvent — the per-market bracket lifecycle (entry → maker/taker fill → bracket exit → settle)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

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
export function replayEvent(input: EventReplayInput, cfg: OpeningCfg, tpDeltaPp: number): BracketTrade {
  if (!input || !Array.isArray(input.ticks) || input.ticks.length === 0) return NOT_EXECUTED('no_ticks');
  const ticks = input.ticks;
  const cfgTp: OpeningCfg = { ...cfg, tpDeltaPp };

  // ── (1) find the FIRST enterable tick + the forecast-center candidate ─────────────────────────────────
  let entryIdx = -1;
  let chosen: EntryCandidate | null = null;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    const cands = selectEntries(captureOf(input, t), cfg, new Date(t.capturedAt), { requireFlatOpen: false });
    if (cands.length > 0) {
      // the forecast CENTER = the highest-modelProb (argmax houseProb) candidate; ONE entry per event.
      chosen = cands.reduce((a, b) => (b.modelProb > a.modelProb ? b : a));
      entryIdx = i;
      break;
    }
  }
  if (!chosen || entryIdx < 0) return NOT_EXECUTED('never_enterable');

  // ── (2) maker-first fill lifecycle over LATER ticks (the maker rests in the book) ─────────────────────
  const entryTime = new Date(ticks[entryIdx]!.capturedAt).getTime();
  let fill = null as ReturnType<typeof paperFill>;
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
  if (!fill || fillIdx < 0) return NOT_EXECUTED('never_filled'); // order rested unfilled to series end

  const shares = fill.shares;
  const stakeUsd = fill.price * fill.shares;
  const entryFee = fill.feeUsd;
  const entryAgeH = fin(ticks[fillIdx]!.hoursSinceListing) ? ticks[fillIdx]!.hoursSinceListing : null;

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
    entryLabel: chosen.label,
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

export function replayPanel(events: EventReplayInput[], cfg: OpeningCfg, tpValues: number[]): BracketPanel {
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
      const t = replayEvent(e, cfg, tp);
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
    const v = openingVerdict(panel);
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
