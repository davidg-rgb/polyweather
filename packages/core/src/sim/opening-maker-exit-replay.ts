/**
 * core/sim/opening-maker-exit-replay — the MAKER-EXIT variant of the bracket engine (the lever
 * CONVERGENCE-TUNING.md left open: the convergence edge is a MAKER edge, not a taker edge).
 *
 * WHY THIS EXISTS. The taker bracket replay (sim/opening-bracket-replay.ts) sells the take-profit by CROSSING
 * the spread into the bid + paying the taker fee — and on the 708-event archive that round-trip cost turned a
 * REAL +8.2% (frictionless) price-path edge into −3.0% net (breakeven at ×0.70 of the real spread). This engine
 * tests the redirect: take profit as a MAKER — rest a SELL at the take-profit limit and let a buyer lift it
 * (fill AT the limit, $0 taker fee, + an optional maker rebate) — recovering the exit-leg spread + fee. The
 * stop-loss and the time-stop stay TAKER (you cannot rest above a falling market — that is exactly the §12
 * adverse-selection wall this engine measures honestly: the maker TP only fills on FAVORABLE moves; every
 * unfavorable one flattens as a taker, so the net is (spread+fee+rebate recovered on the up-fills) − (the
 * stalled/adverse ones carried to the taker time-stop)).
 *
 * THE ENTRY LEG IS SHARED. It reuses `enterAndFill` from opening-bracket-replay verbatim (one tested entry path
 * across the taker + maker engines) — only the EXIT differs. The time-stop is `resolvesAt − tstopHoursBeforeResolve`
 * (the spec: "exit … or at the latest N hours from bet closing"), NOT the local-noon clock the taker engine uses.
 *
 * NO LOOK-AHEAD (the load-bearing invariant). The exit decision at tick t reads ONLY tick t's execBid + the wall
 * clock at t; the loop BREAKS at the first firing — a later up-tick can never rescue a stopped-out trade, and the
 * maker TP "fills" only at the tick where the bid actually reaches the resting limit (never retroactively). Pure +
 * total (junk → executed:false / NaN, never throws). Imports only sibling pure modules — never io/trading/fs.
 */
import {
  selectEntries,
  paperFill,
  openingVerdict,
  BOT_DEFAULTS,
  type OpeningCfg,
  type OpeningMarketResult,
  type OpeningVerdict,
  type VerdictOpts,
  type EntryCandidate,
  type PaperFill,
  type OpeningCapture,
} from './opening-convergence.ts';
import { enterAndFill, type EventReplayInput, type ReplayTick } from './opening-bracket-replay.ts';
import { takerFeePerShare } from '../fees.ts';
import { localHourInstant } from '../time.ts';
import { makerQmin, sideScore } from './reward-farming.ts';

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Config + types
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The maker-exit engine's config — the bot's OpeningCfg + the two maker-exit knobs. */
export interface MakerExitCfg extends OpeningCfg {
  /** the maker rebate rate — a FRACTION of the taker fee credited on a MAKER fill (rate · takerFeePerShare(p,
   *  takerFeeRate) · shares), matching reward-farming.ts / reward-inventory.ts (weather tier ≈ 0.25). 0 = the
   *  conservative pure fee-saving floor. The project measured a live weather maker rebate (MAKER-REBATE-HANDOFF.md)
   *  — swept here, never assumed. */
  makerRebateRate: number;
  /** the HARD time-stop: flatten (taker) at the latest this many hours BEFORE the market resolves ("at the latest
   *  N hours from bet closing"). Falls back to the local-noon clock only if resolvesAt is unknown. */
  tstopHoursBeforeResolve: number;
  /**
   * OPTIONAL take-profit placement mode (the 2026-07-03 exit-structure lever). Where does the resting maker
   * SELL sit?
   *   - 'delta' (default — the historical behavior, byte-identical): entry + tpDeltaPp.
   *   - 'abs':   an ABSOLUTE convergence target (tpAbsTarget, e.g. 0.35) — "sell into the 30+ mid-range peak",
   *              independent of what we paid. Floored at entry+0.02 (never rest at/below the entry).
   *   - 'model': OUR forecast prob for the bucket (the level the convergence thesis says the price converges
   *              TO) — the self-consistent target. Same entry+0.02 floor.
   * A higher limit harvests more per fill but fills less often (unfilled → carried to the taker time-stop —
   * exactly the §12 adverse-selection trade-off this engine measures honestly).
   */
  tpMode?: 'delta' | 'abs' | 'model';
  /** the absolute resting-sell target when tpMode='abs' (default 0.35). */
  tpAbsTarget?: number;
  /**
   * OPTIONAL liquidity-reward accrual on the resting TP sell (SIGNAL-BACKLOG.md #1b). Polymarket pays
   * resting-order rewards "regardless of fill" (core/polymarket/rewards.ts), scored by Polymarket's
   * docs-verbatim closeness-to-mid formula (reward-farming.ts: spreadScore/makerQmin) — a ONE-SIDED
   * quote (this engine only rests a SELL, never a matching BUY, so it never reopens the REC-10
   * two-sided adverse-selection wall) earns Qmin/c in the [0.10,0.90] mid range and ZERO in the strict
   * <0.10/>0.90 regime, where two-sided is mandatory. `myPoolShareIfQualifying` is a SWEPT ASSUMPTION
   * (the competition denominator is the dominant unknown per reward-farming.ts — this does not
   * reconstruct a live competitor book), applied only for ticks the resting sell actually qualifies at.
   * Unset (default) = no accrual, byte-identical to every existing caller.
   */
  rewardCfg?: {
    /** the market's daily USDC reward pool (0 = no pool, no accrual). */
    dailyPoolUsd: number;
    /** rewards.max_spread in CENTS (weather markets: 4.5 per REC-3/MAKER-REBATE-HANDOFF.md). */
    maxSpreadCents: number;
    /** MY assumed share of the pool once qualifying — a conservative default of 0 mirrors the
     *  makerRebateRate precedent (MAKER_EXIT_TUNED.makerRebateRate=0): raise once cross-checked. */
    myPoolShareIfQualifying: number;
  };
  /**
   * OPTIONAL basket entry (SIGNAL-BACKLOG.md #5 — variance reduction, NOT a new edge). Every prior maker-exit
   * measurement enters ONE bucket (the forecast center, argmax modelProb). When set > 1, the top-`basketSize`
   * candidates by modelProb (mode ± centerHalfWidth, same gates as the single-bucket path) split
   * cfg.perPositionUsd probability-weighted instead of staking it all on one bucket. Unset/1 = the historical
   * single-bucket behavior, byte-identical — this field is read ONLY by replayMakerExitEventBasket /
   * replayMakerExitPanelBasket; replayMakerExitEvent / replayMakerExitPanel never look at it.
   */
  basketSize?: number;
}

export const MAKER_EXIT_DEFAULTS = {
  makerRebateRate: 0,
  tstopHoursBeforeResolve: 12,
} as const;

/**
 * The TUNED maker-exit params (MAKER-EXIT-SIM.md / MAKER-EXIT-PAPER-LOOP-HANDOFF §5 — the agent-team sweep's
 * in-sample optimum on the 708-event archive). PINNED IN CODE (not the live bot.* config): the forward loop's
 * scope is fixed to these, exactly as convergence-panel pins to BOT_DEFAULTS, so it never mutates the shared
 * bot.* keys (which opening-capture + convergence-panel also read) and never trips the 0066 config-mirror
 * equality test. The forward run RE-VALIDATES them — an in-sample optimum is not a forward truth. makerRebateRate
 * stays the conservative fee-saving floor (0); the operator raises it to the confirmed weather tier once
 * assumption #2 (the realized rebate) is cross-checked against the venue fee schedule. */
export const MAKER_EXIT_TUNED = {
  centerHalfWidth: 0,
  maxEntryPrice: 0.3,
  depthFloorUsd: 150,
  tpDeltaPp: 0.12,
  slDeltaPp: 0.2,
  makerFillWindowMin: 30,
  tstopHoursBeforeResolve: 18,
  makerRebateRate: 0,
} as const;

/** Build the forward loop's MakerExitCfg = the §9R-locked BOT_DEFAULTS + the maker-exit defaults + the tuned
 *  overrides, scoped to `cities` (pass BOT_DEFAULTS.cities — the 10-city §9R TRADABLE allowlist). `over` lets a
 *  caller (a test, or a future operator override read) tighten a single knob without forking the constant. */
export function makerExitCfg(cities: string[], over: Partial<MakerExitCfg> = {}): MakerExitCfg {
  return { ...BOT_DEFAULTS, ...MAKER_EXIT_DEFAULTS, ...MAKER_EXIT_TUNED, cities, ...over };
}

/** One maker-exit market's realized trade (the ledger row the sim prints — entry + exit "like the logged data"). */
export interface MakerExitTrade {
  eventId: string;
  city: string;
  targetDate: string;
  entryLabel: string;
  /** hours_since_listing at the fill tick. */
  entryAgeH: number | null;
  entryPrice: number;
  isMakerEntry: boolean;
  exitPrice: number;
  /** 'maker_take_profit' | 'taker_stop_loss' | 'taker_time_stop' | 'resolution_settle' | 'mtm_unresolved'. */
  exitKind: string;
  isMakerExit: boolean;
  /** ISO of the fill tick + the exit tick (so the ledger reads like the logged potential entries & exits). */
  entryAt: string;
  exitAt: string;
  feeUsd: number;
  rebateUsd: number;
  /** accrued liquidity-reward income on the resting TP sell (0 when cfg.rewardCfg is unset — SIGNAL-BACKLOG #1b). */
  rewardUsd: number;
  netPnlUsd: number;
  stakeUsd: number;
  netReturn: number;
  executed: boolean;
  // ── measurement diagnostics (the forward paper loop's deliverable — MAKER-EXIT-PAPER-LOOP-HANDOFF §3) ──
  /** the chosen forecast-center bucket index (the position's bucket). */
  bucketIdx: number;
  /** tick indices (into input.ticks) of the entry fill + the exit — the measurement anchors. */
  entryTickIndex: number;
  exitTickIndex: number;
  /** ticks the resting maker SELL waited before a buyer lifted it (exitTickIndex − entryTickIndex); null on a
   *  taker exit (assumption #1 — the real maker-fill latency, queue-blind but otherwise true to the live book). */
  makerFillLatencyTicks: number | null;
  /** observed top-of-book spread (bestAsk − bestBid) of the chosen bucket at the entry-fill / exit tick — the
   *  real round-trip cost the taker bracket paid and the maker exit recovers (NaN if a side is missing). */
  observedEntrySpread: number;
  observedExitSpread: number;
  /** the maker rebate rate applied to this trade's maker legs (cfg.makerRebateRate) — recorded so the forward
   *  run MEASURES the rebate assumption (#2) at whatever tier the operator confirms, not a backtest constant. */
  rebateRateUsed: number;
}

const NOT_EXECUTED = (eventId: string, city: string, targetDate: string, reason: string): MakerExitTrade => ({
  eventId, city, targetDate, entryLabel: '', entryAgeH: null, entryPrice: NaN, isMakerEntry: false,
  exitPrice: NaN, exitKind: reason, isMakerExit: false, entryAt: '', exitAt: '', feeUsd: 0, rebateUsd: 0,
  rewardUsd: 0, netPnlUsd: 0, stakeUsd: 0, netReturn: NaN, executed: false,
  bucketIdx: -1, entryTickIndex: -1, exitTickIndex: -1, makerFillLatencyTicks: null,
  observedEntrySpread: NaN, observedExitSpread: NaN, rebateRateUsed: 0,
});

/**
 * Reward-eligible qualification of a resting SELL at `restPrice` for `shares`, at the market's `mid`
 * (SIGNAL-BACKLOG #1b — the docs-verbatim scoring formula, one-sided: qOne=0, no matching bid).
 * Returns the raw Qmin score (>0 iff it qualifies for ANY reward this tick) — 0 in the strict
 * <0.10/>0.90 regime (mandatory two-sided), Qtwo/c in [0.10,0.90] (the one-sided discount). Total: a
 * non-finite mid/restPrice/shares → 0, never throws.
 */
export function restingSellQmin(restPrice: number, shares: number, mid: number | null, maxSpreadCents: number): number {
  if (!fin(mid) || !fin(restPrice) || !fin(shares) || shares <= 0) return 0;
  const qTwo = sideScore([{ price: restPrice, size: shares }], mid, maxSpreadCents);
  return makerQmin(0, qTwo, mid);
}

/** the F13/F1 ternary stop (the operator-locked −12pp wherever entry>0.12, else the relative floor). */
function stopOf(entry: number, cfg: OpeningCfg): number {
  return entry - cfg.slDeltaPp > 0 ? entry - cfg.slDeltaPp : entry * (1 - cfg.slFrac);
}

/** the chosen bucket's execBid at a tick (the realizable sell mark), null if it dropped/no quote. */
function bidAt(tick: EventReplayInput['ticks'][number], idx: number): number | null {
  const b = (Array.isArray(tick.buckets) ? tick.buckets : []).find((x) => x && x.idx === idx);
  return b && fin(b.execBid) ? b.execBid : null;
}

/** the chosen bucket's mid at a tick (the reward-scoring midpoint), null if missing (SIGNAL-BACKLOG #1b). */
function midAt(tick: EventReplayInput['ticks'][number], idx: number): number | null {
  const b = (Array.isArray(tick.buckets) ? tick.buckets : []).find((x) => x && x.idx === idx);
  return b && fin(b.mid) ? b.mid : null;
}

/** the chosen bucket's observed top-of-book spread (bestAsk − bestBid) at a tick — NaN if either side is missing.
 *  The measured round-trip cost (the lever the maker exit recovers): logged per position for the forward read. */
function spreadAt(tick: EventReplayInput['ticks'][number], idx: number): number {
  const b = (Array.isArray(tick.buckets) ? tick.buckets : []).find((x) => x && x.idx === idx);
  return b && fin(b.bestAsk) && fin(b.bestBid) ? b.bestAsk - b.bestBid : NaN;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · replayMakerExitEvent — entry (shared) → maker-TP / taker-SL / taker-timestop exit
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function replayMakerExitEvent(
  input: EventReplayInput,
  cfg: MakerExitCfg,
  resolvesAtMs: number | null,
): MakerExitTrade {
  const eventId = input?.eventId ?? '';
  const city = input?.city ?? '';
  const targetDate = input?.targetDate ?? '';
  const ef = enterAndFill(input, cfg);
  if ('reason' in ef) return NOT_EXECUTED(eventId, city, targetDate, ef.reason);
  return runMakerExitLeg(input, cfg, resolvesAtMs, eventId, city, targetDate, ef.chosen, ef.fillIdx, ef.fill, ef.isMaker);
}

/**
 * The shared per-leg lifecycle AFTER entry is known: resting-sell reward accrual (SIGNAL-BACKLOG #1b) + the
 * maker-TP / taker-SL / taker-time-stop exit walk + settle. Factored out of replayMakerExitEvent (which calls
 * it once, for the single SHARED argmax entry) so the basket variant (replayMakerExitEventBasket,
 * SIGNAL-BACKLOG #5) can call it once per basket leg — ONE tested exit lifecycle regardless of whether the
 * position is a single bucket or a basket of N. Pure + total.
 */
function runMakerExitLeg(
  input: EventReplayInput,
  cfg: MakerExitCfg,
  resolvesAtMs: number | null,
  eventId: string,
  city: string,
  targetDate: string,
  chosen: EntryCandidate,
  fillIdx: number,
  fill: PaperFill,
  isMakerEntry: boolean,
): MakerExitTrade {
  const ticks = input.ticks;
  const bucketIdx = chosen.bucketIdx;
  const shares = fill.shares;
  const stakeUsd = fill.price * fill.shares;
  const entryFee = fill.feeUsd; // 0 on a maker fill, taker fee on the fallback
  const entryAt = ticks[fillIdx]!.capturedAt;
  const entryAgeH = fin(ticks[fillIdx]!.hoursSinceListing) ? ticks[fillIdx]!.hoursSinceListing : null;
  const observedEntrySpread = spreadAt(ticks[fillIdx]!, bucketIdx);
  const rebateRateUsed = Math.max(0, cfg.makerRebateRate);
  // rebate = a FRACTION of the taker fee at the fill price (rate · takerFeePerShare(p, takerFeeRate) · shares) —
  // the convention reward-farming.ts:299 / reward-inventory.ts:251 use. The fee-rate factor is load-bearing:
  // takerFeePerShare(p, 1) would credit the FULL fee-magnitude (1/takerFeeRate ≈ 20× too large at rate 0.05),
  // inflating netPnl → the §9R-E gate in the FALSE-PASS direction once the operator turns the rebate on.
  const rebate = (p: number): number => rebateRateUsed * takerFeePerShare(p, cfg.takerFeeRate) * shares;
  const entryRebate = isMakerEntry ? rebate(fill.price) : 0;

  // the resting maker SELL limit (the take-profit target price) + the protective stop. tpMode 'abs'/'model'
  // replace the relative entry+Δ with an absolute / forecast-prob convergence target, floored at entry+0.02
  // (a resting sell at/below the entry is degenerate). Default 'delta' = the historical entry+tpDeltaPp.
  const tpMode = cfg.tpMode ?? 'delta';
  const exitLimit =
    tpMode === 'abs' ? Math.max(fill.price + 0.02, fin(cfg.tpAbsTarget) ? cfg.tpAbsTarget : 0.35)
    : tpMode === 'model' ? Math.max(fill.price + 0.02, chosen.modelProb)
    : fill.price + cfg.tpDeltaPp;
  const slStop = stopOf(fill.price, cfg);

  // the HARD time-stop: resolvesAt − N hours ("at the latest N hours from bet closing"); fall back to local noon.
  let timeStopMs = Number.POSITIVE_INFINITY;
  if (fin(resolvesAtMs)) {
    timeStopMs = resolvesAtMs - Math.max(0, cfg.tstopHoursBeforeResolve) * 3_600_000;
  } else {
    try {
      timeStopMs = localHourInstant(input.tz, targetDate, cfg.timeStopLocalHour).getTime();
    } catch {
      timeStopMs = Number.POSITIVE_INFINITY; // no clock → carry to series end (settles below)
    }
  }

  // ── RUNWAY GUARD (entry/exit clock agreement) ──────────────────────────────────────────────────────
  // The SHARED entry gate (selectEntries) checks runway against the LOCAL-NOON clock (timeStopLocalHour), but
  // THIS engine's time-stop is resolvesAt − N h (or the noon fallback when resolvesAt is unknown), which for a
  // local-MIDNIGHT daily resolution sits BEFORE noon. A market first-enterable AFTER its maker-exit time-stop
  // passes the noon runway gate yet is already past THIS clock at the fill tick, so the exit walk would fire
  // taker_time_stop on the FIRST post-fill tick — a deterministic spread+fee loss at ~zero hold that biases the
  // realized §9R-E panel down (one-directional). Skip it (no_runway) so the panel measures only markets with real
  // runway under whichever clock governs this exit. Guard on timeStopMs (not resolvesAtMs): when NO clock exists
  // timeStopMs is +Infinity → not finite → no skip (carries to series end), so the noon-fallback path is covered too.
  const entryFillMs = new Date(entryAt).getTime();
  if (Number.isFinite(timeStopMs) && Number.isFinite(entryFillMs) && timeStopMs <= entryFillMs) {
    return NOT_EXECUTED(eventId, city, targetDate, 'no_runway');
  }

  // ── exit walk from the tick AFTER the fill (a resting order needs a later tick to be lifted). NO LOOK-AHEAD ──
  let lastBid: number | null = null;
  let rewardAcc = 0; // accrued liquidity-reward income on the resting SELL (0 forever when cfg.rewardCfg is unset)
  let prevMs = entryFillMs; // the resting sell starts accruing from the moment it began resting
  for (let j = fillIdx + 1; j < ticks.length; j++) {
    const t = ticks[j]!;
    const nowMs = new Date(t.capturedAt).getTime();
    const bid = bidAt(t, bucketIdx);
    if (fin(bid)) lastBid = bid;

    // reward accrual for the interval the resting sell just finished being live (SIGNAL-BACKLOG #1b) — eligibility
    // is evaluated on the PRIOR tick's mid (the state known at the interval's start — no look-ahead into tick j).
    if (cfg.rewardCfg && Number.isFinite(nowMs) && nowMs > prevMs) {
      const dtHours = (nowMs - prevMs) / 3_600_000;
      const q = restingSellQmin(exitLimit, shares, midAt(ticks[j - 1]!, bucketIdx), cfg.rewardCfg.maxSpreadCents);
      if (q > 0) rewardAcc += cfg.rewardCfg.myPoolShareIfQualifying * cfg.rewardCfg.dailyPoolUsd * (dtHours / 24);
    }
    prevMs = nowMs;

    // (a) MAKER take-profit: a buyer lifts the resting sell — fill AT the limit, $0 fee + rebate.
    if (fin(bid) && bid >= exitLimit) {
      return settle(exitLimit, 'maker_take_profit', true, rebate(exitLimit), 0, j, rewardAcc);
    }
    // (b) TAKER stop-loss: cut the loss by crossing into the bid (cannot rest above a falling market — §12).
    if (fin(bid) && bid <= slStop) {
      const fee = takerFeePerShare(bid, cfg.takerFeeRate) * shares;
      return settle(bid, 'taker_stop_loss', false, 0, fee, j, rewardAcc);
    }
    // (c) HARD time-stop (resolvesAt − N h): flatten as a taker at the realizable bid (or the last seen bid).
    if (nowMs >= timeStopMs) {
      const px = fin(bid) ? bid : lastBid;
      if (px != null) {
        const fee = takerFeePerShare(px, cfg.takerFeeRate) * shares;
        return settle(px, 'taker_time_stop', false, 0, fee, j, rewardAcc);
      }
      break; // no bid to flatten into → settle below
    }
  }

  // open at series end (or no bid at the time-stop) → settle at resolution if known, else mark to the last bid.
  const endIdx = ticks.length - 1;
  if (input.resolution && !input.resolution.gradingMismatch && input.resolution.winnerIdx != null) {
    const won = input.resolution.winnerIdx === bucketIdx;
    return settle(won ? 1 : 0, `resolution_settle:${won ? 'win' : 'lose'}`, false, 0, 0, endIdx, rewardAcc); // redeem — no taker fee
  }
  return settle(fin(lastBid) ? lastBid : 0, 'mtm_unresolved', false, 0, 0, endIdx, rewardAcc);

  // exitIdx = the tick the exit fired at (the loop index, or the series end for a settle/mtm) — the measurement
  // anchor: it dates the exit (exitAt), measures the maker-fill latency, and reads the realized exit-side spread.
  function settle(exitPrice: number, exitKind: string, isMakerExit: boolean, exitRebate: number, exitFee: number, exitIdx: number, rewardUsd: number = 0): MakerExitTrade {
    const feeUsd = entryFee + exitFee;
    const rebateUsd = entryRebate + exitRebate;
    const netPnlUsd = shares * (exitPrice - fill.price) - feeUsd + rebateUsd + rewardUsd;
    const safeExitIdx = exitIdx >= fillIdx && exitIdx < ticks.length ? exitIdx : endIdx;
    return {
      eventId, city, targetDate, entryLabel: chosen.label, entryAgeH, entryPrice: fill.price, isMakerEntry,
      exitPrice, exitKind, isMakerExit, entryAt, exitAt: ticks[safeExitIdx]!.capturedAt, feeUsd, rebateUsd, rewardUsd, netPnlUsd, stakeUsd,
      netReturn: stakeUsd > 0 ? netPnlUsd / stakeUsd : NaN, executed: true,
      bucketIdx, entryTickIndex: fillIdx, exitTickIndex: safeExitIdx,
      makerFillLatencyTicks: isMakerExit ? safeExitIdx - fillIdx : null,
      observedEntrySpread, observedExitSpread: spreadAt(ticks[safeExitIdx]!, bucketIdx), rebateRateUsed,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1b · replayMakerExitEventBasket — SIGNAL-BACKLOG.md #5: split entry across the top-N candidates
// (variance reduction, NOT a new edge). Unset/basketSize<=1 callers use replayMakerExitEvent above;
// this is a SEPARATE entry point (never called by replayMakerExitEvent/replayMakerExitPanel) so the
// pinned single-bucket engine stays byte-identical regardless of whether cfg.basketSize is set.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** the chosen bucket's execAsk at a tick (the realizable buy mark), null if it dropped/no quote. */
function askAt(tick: EventReplayInput['ticks'][number], idx: number): number | null {
  const b = (Array.isArray(tick.buckets) ? tick.buckets : []).find((x) => x && x.idx === idx);
  return b && fin(b.execAsk) ? b.execAsk : null;
}

/** build the OpeningCapture selectEntries reads from one tick + the event meta (identical shape to
 *  opening-bracket-replay.ts's private captureOf — duplicated here rather than exported/shared, since it is
 *  trivial glue and the two engines otherwise stay independently readable). */
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
 * Find the first enterable tick and return ALL candidates within mode ± centerHalfWidth (not just the
 * argmax), sorted by modelProb descending, sliced to `basketSize`. Mirrors enterAndFill's step-1 loop
 * (opening-bracket-replay.ts) exactly, generalized from "pick the argmax" to "keep the top N".
 */
function findBasketEntry(
  input: EventReplayInput,
  cfg: MakerExitCfg,
  basketSize: number,
): { entryIdx: number; candidates: EntryCandidate[] } | null {
  const ticks = input.ticks;
  const minAgeH = cfg.minEntryAgeH ?? 0;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    if (minAgeH > 0 && !(fin(t.hoursSinceListing) && t.hoursSinceListing >= minAgeH)) continue;
    const cands = selectEntries(captureOf(input, t), cfg, new Date(t.capturedAt), { requireFlatOpen: false });
    if (cands.length > 0) {
      const sorted = [...cands].sort((a, b) => b.modelProb - a.modelProb).slice(0, Math.max(1, Math.floor(basketSize)));
      return { entryIdx: i, candidates: sorted };
    }
  }
  return null;
}

/**
 * Split cfg.perPositionUsd across `candidates`, weighted by each candidate's modelProb (normalized to sum
 * to 1) — more capital to the bucket the calibrated forecast favors more. Equal-weight fallback when every
 * modelProb is ≤0 (a defensive floor; selectEntries' own gates make this practically unreachable).
 */
function rescaleBasket(
  candidates: EntryCandidate[],
  perPositionUsd: number,
): { candidate: EntryCandidate; weight: number }[] {
  const totalProb = candidates.reduce((a, c) => a + Math.max(0, c.modelProb), 0);
  return candidates.map((c) => {
    const weight = totalProb > 0 ? Math.max(0, c.modelProb) / totalProb : 1 / candidates.length;
    const targetUsd = perPositionUsd * weight;
    return { candidate: { ...c, targetUsd, targetShares: targetUsd / c.execAsk }, weight };
  });
}

/**
 * Per-leg fill lifecycle for an ARBITRARY candidate (not necessarily the argmax) — the maker-first-rest-
 * then-taker-fallback logic generalized from enterAndFill's step 2, since each basket leg fills
 * independently against its OWN bucket's book path. Pure + total: never fills → null.
 */
function fillCandidateAt(
  ticks: EventReplayInput['ticks'],
  entryIdx: number,
  candidate: EntryCandidate,
  cfg: MakerExitCfg,
): { fill: PaperFill; isMaker: boolean; fillIdx: number } | null {
  const entryTime = new Date(ticks[entryIdx]!.capturedAt).getTime();
  for (let j = entryIdx + 1; j < ticks.length; j++) {
    const t = ticks[j]!;
    const liveAsk = askAt(t, candidate.bucketIdx);
    const restMin = (new Date(t.capturedAt).getTime() - entryTime) / 60_000;
    if (Number.isFinite(restMin) && restMin >= cfg.makerFillWindowMin) {
      if (!fin(liveAsk)) continue; // vanished bucket — retry when it reappears (enterAndFill's semantics)
      if (cfg.noChaseTakerFallback === true) {
        const reservation = Math.min(cfg.maxEntryPrice, candidate.modelProb - cfg.entryEdgeMargin);
        if (liveAsk > reservation) continue;
      }
      const fill = paperFill(candidate, candidate.execAsk, liveAsk, cfg, false);
      return fill ? { fill, isMaker: false, fillIdx: j } : null;
    }
    const mf = paperFill(candidate, candidate.execAsk, liveAsk, cfg, true);
    if (mf) return { fill: mf, isMaker: true, fillIdx: j };
  }
  return null;
}

/** One basket leg's realized result — a MakerExitTrade (the exact per-bucket shape, unchanged) + its
 *  probability-weighted share of the basket's total stake. */
export interface MakerExitBasketLeg extends MakerExitTrade {
  basketWeight: number;
}

/** The basket's aggregate result — every filled leg + the summed P&L (the panel-facing numbers). */
export interface MakerExitBasketTrade {
  eventId: string;
  city: string;
  targetDate: string;
  legs: MakerExitBasketLeg[];
  /** candidates requested (top-basketSize by modelProb, before fills) vs. legs that actually filled. */
  nLegsRequested: number;
  nLegsFilled: number;
  netPnlUsd: number;
  stakeUsd: number;
  netReturn: number;
  executed: boolean;
  /** the NOT_EXECUTED reason when nLegsFilled===0 ('no_ticks'|'off_universe'|'never_enterable'|'never_filled'). */
  reason: string;
}

const NOT_EXECUTED_BASKET = (eventId: string, city: string, targetDate: string, reason: string): MakerExitBasketTrade => ({
  eventId, city, targetDate, legs: [], nLegsRequested: 0, nLegsFilled: 0, netPnlUsd: 0, stakeUsd: 0,
  netReturn: NaN, executed: false, reason,
});

/**
 * Replay ONE market's BASKET maker-exit trade: split entry across the top cfg.basketSize candidates by
 * modelProb, run the SAME tested per-leg lifecycle (runMakerExitLeg — entry fill + reward accrual + maker-TP
 * / taker-SL / taker-time-stop exit) independently for each, and sum the realized legs into one aggregate.
 * cfg.basketSize unset/≤1 still works (degenerates to a single leg) but callers wanting the pinned
 * single-bucket engine should use replayMakerExitEvent directly. Pure + total.
 */
export function replayMakerExitEventBasket(
  input: EventReplayInput,
  cfg: MakerExitCfg,
  resolvesAtMs: number | null,
): MakerExitBasketTrade {
  const eventId = input?.eventId ?? '';
  const city = input?.city ?? '';
  const targetDate = input?.targetDate ?? '';
  if (!input || !Array.isArray(input.ticks) || input.ticks.length === 0) {
    return NOT_EXECUTED_BASKET(eventId, city, targetDate, 'no_ticks');
  }
  if (!cfg.cities.includes(city)) return NOT_EXECUTED_BASKET(eventId, city, targetDate, 'off_universe');

  const basketSize = cfg.basketSize && cfg.basketSize > 1 ? Math.floor(cfg.basketSize) : 1;
  const found = findBasketEntry(input, cfg, basketSize);
  if (!found) return NOT_EXECUTED_BASKET(eventId, city, targetDate, 'never_enterable');
  const { entryIdx, candidates } = found;
  const weighted = rescaleBasket(candidates, cfg.perPositionUsd);

  const legs: MakerExitBasketLeg[] = [];
  for (const { candidate, weight } of weighted) {
    const filled = fillCandidateAt(input.ticks, entryIdx, candidate, cfg);
    if (!filled) continue; // this leg never filled — the other legs may still fill independently
    const trade = runMakerExitLeg(
      input, cfg, resolvesAtMs, eventId, city, targetDate,
      candidate, filled.fillIdx, filled.fill, filled.isMaker,
    );
    if (!trade.executed) continue; // no_runway on this leg — drop it, other legs' own clocks may still allow
    legs.push({ ...trade, basketWeight: weight });
  }
  if (legs.length === 0) return NOT_EXECUTED_BASKET(eventId, city, targetDate, 'never_filled');

  const netPnlUsd = legs.reduce((a, l) => a + l.netPnlUsd, 0);
  const stakeUsd = legs.reduce((a, l) => a + l.stakeUsd, 0);
  return {
    eventId, city, targetDate, legs,
    nLegsRequested: candidates.length,
    nLegsFilled: legs.length,
    netPnlUsd, stakeUsd,
    netReturn: stakeUsd > 0 ? netPnlUsd / stakeUsd : NaN,
    executed: true,
    reason: '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · replayMakerExitPanel — run every event, return the §9R-E verdict + the per-trade ledger
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface MakerExitPanel {
  /** every executed trade (the ledger). */
  ledger: MakerExitTrade[];
  /** the frozen §9R-E verdict over the REALIZED (non-mtm) trades. */
  verdict: OpeningVerdict;
  /** mean realized net return + win fraction + total net $ over the realized trades (the optimizer's objective). */
  meanNetReturn: number;
  winFrac: number;
  totalNetUsd: number;
  nExecuted: number;
  nRealized: number;
  /** the share of realized exits that were MAKER take-profits (vs taker SL/time-stop) — the adverse-selection read. */
  makerExitFrac: number;
}

/**
 * Replay the maker-exit strategy over a panel. `resolvesByEvent` maps eventId → the market's resolution epoch ms
 * (the time-stop anchor); a missing entry falls back to the local-noon clock. The verdict scores REALIZED trades
 * only (mtm_unresolved excluded — it can never PASS on an unrealized mark, the one false-GO direction).
 */
export function replayMakerExitPanel(
  events: EventReplayInput[],
  cfg: MakerExitCfg,
  resolvesByEvent: Map<string, number | null>,
  verdictOpts: VerdictOpts = {},
): MakerExitPanel {
  const evs = (Array.isArray(events) ? events : []).filter((e): e is EventReplayInput => !!e && Array.isArray(e.ticks));
  const ledger: MakerExitTrade[] = [];
  const panel: OpeningMarketResult[] = [];
  let makerExits = 0;
  let realized = 0;
  for (const e of evs) {
    if (e.resolution?.gradingMismatch) continue; // ambiguous payout — out of scoring entirely
    const t = replayMakerExitEvent(e, cfg, resolvesByEvent.get(e.eventId) ?? null);
    if (!t.executed || !Number.isFinite(t.netReturn) || !Number.isFinite(t.netPnlUsd)) continue;
    ledger.push(t);
    if (!t.exitKind.startsWith('mtm_')) {
      realized++;
      if (t.isMakerExit) makerExits++;
      panel.push({ city: e.city, targetDate: e.targetDate, netPnlUsd: t.netPnlUsd, stakeUsd: t.stakeUsd, netReturn: t.netReturn, executed: true });
    }
  }
  const verdict = openingVerdict(panel, verdictOpts);
  const realizedRows = ledger.filter((t) => !t.exitKind.startsWith('mtm_'));
  return {
    ledger,
    verdict,
    meanNetReturn: mean(realizedRows.map((t) => t.netReturn)),
    winFrac: realizedRows.length ? realizedRows.filter((t) => t.netPnlUsd > 0).length / realizedRows.length : NaN,
    totalNetUsd: realizedRows.reduce((a, t) => a + t.netPnlUsd, 0),
    nExecuted: ledger.length,
    nRealized: realized,
    makerExitFrac: realized ? makerExits / realized : NaN,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2b · replayMakerExitPanelBasket — the basket twin of replayMakerExitPanel (SIGNAL-BACKLOG.md #5)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface MakerExitPanelBasket {
  ledger: MakerExitBasketTrade[];
  /** the frozen §9R-E verdict over FULLY-REALIZED baskets only (any leg still mtm_unresolved excludes the
   *  whole basket — never certify partial-mark net profit, the same discipline as the single-bucket panel). */
  verdict: OpeningVerdict;
  meanNetReturn: number;
  winFrac: number;
  totalNetUsd: number;
  nExecuted: number;
  nRealized: number;
  /** the share of realized LEGS (across every realized basket) that exited as a maker take-profit. */
  makerExitFrac: number;
}

/**
 * Replay the BASKET maker-exit strategy over a panel — the twin of replayMakerExitPanel for
 * cfg.basketSize > 1. `resolvesByEvent` / verdictOpts semantics are identical. Pure + total.
 */
export function replayMakerExitPanelBasket(
  events: EventReplayInput[],
  cfg: MakerExitCfg,
  resolvesByEvent: Map<string, number | null>,
  verdictOpts: VerdictOpts = {},
): MakerExitPanelBasket {
  const evs = (Array.isArray(events) ? events : []).filter((e): e is EventReplayInput => !!e && Array.isArray(e.ticks));
  const ledger: MakerExitBasketTrade[] = [];
  const panel: OpeningMarketResult[] = [];
  let makerExitLegs = 0;
  let realizedLegs = 0;
  let realized = 0;
  for (const e of evs) {
    if (e.resolution?.gradingMismatch) continue;
    const t = replayMakerExitEventBasket(e, cfg, resolvesByEvent.get(e.eventId) ?? null);
    if (!t.executed || !Number.isFinite(t.netReturn) || !Number.isFinite(t.netPnlUsd)) continue;
    ledger.push(t);
    const allRealized = t.legs.length > 0 && t.legs.every((l) => !l.exitKind.startsWith('mtm_'));
    if (allRealized) {
      realized++;
      realizedLegs += t.legs.length;
      makerExitLegs += t.legs.filter((l) => l.isMakerExit).length;
      panel.push({ city: e.city, targetDate: e.targetDate, netPnlUsd: t.netPnlUsd, stakeUsd: t.stakeUsd, netReturn: t.netReturn, executed: true });
    }
  }
  const verdict = openingVerdict(panel, verdictOpts);
  return {
    ledger,
    verdict,
    meanNetReturn: mean(panel.map((p) => p.netReturn)),
    winFrac: panel.length ? panel.filter((p) => p.netPnlUsd > 0).length / panel.length : NaN,
    totalNetUsd: panel.reduce((a, p) => a + p.netPnlUsd, 0),
    nExecuted: ledger.length,
    nRealized: realized,
    makerExitFrac: realizedLegs ? makerExitLegs / realizedLegs : NaN,
  };
}
