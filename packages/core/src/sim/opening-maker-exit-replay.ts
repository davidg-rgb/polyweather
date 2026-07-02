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
} from './opening-convergence.ts';
import { enterAndFill, type EventReplayInput } from './opening-bracket-replay.ts';
import { takerFeePerShare } from '../fees.ts';
import { localHourInstant } from '../time.ts';

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
  netPnlUsd: 0, stakeUsd: 0, netReturn: NaN, executed: false,
  bucketIdx: -1, entryTickIndex: -1, exitTickIndex: -1, makerFillLatencyTicks: null,
  observedEntrySpread: NaN, observedExitSpread: NaN, rebateRateUsed: 0,
});

/** the F13/F1 ternary stop (the operator-locked −12pp wherever entry>0.12, else the relative floor). */
function stopOf(entry: number, cfg: OpeningCfg): number {
  return entry - cfg.slDeltaPp > 0 ? entry - cfg.slDeltaPp : entry * (1 - cfg.slFrac);
}

/** the chosen bucket's execBid at a tick (the realizable sell mark), null if it dropped/no quote. */
function bidAt(tick: EventReplayInput['ticks'][number], idx: number): number | null {
  const b = (Array.isArray(tick.buckets) ? tick.buckets : []).find((x) => x && x.idx === idx);
  return b && fin(b.execBid) ? b.execBid : null;
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

  const ticks = input.ticks;
  const { chosen, fillIdx, fill, isMaker: isMakerEntry } = ef;
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
  for (let j = fillIdx + 1; j < ticks.length; j++) {
    const t = ticks[j]!;
    const nowMs = new Date(t.capturedAt).getTime();
    const bid = bidAt(t, bucketIdx);
    if (fin(bid)) lastBid = bid;

    // (a) MAKER take-profit: a buyer lifts the resting sell — fill AT the limit, $0 fee + rebate.
    if (fin(bid) && bid >= exitLimit) {
      return settle(exitLimit, 'maker_take_profit', true, rebate(exitLimit), 0, j);
    }
    // (b) TAKER stop-loss: cut the loss by crossing into the bid (cannot rest above a falling market — §12).
    if (fin(bid) && bid <= slStop) {
      const fee = takerFeePerShare(bid, cfg.takerFeeRate) * shares;
      return settle(bid, 'taker_stop_loss', false, 0, fee, j);
    }
    // (c) HARD time-stop (resolvesAt − N h): flatten as a taker at the realizable bid (or the last seen bid).
    if (nowMs >= timeStopMs) {
      const px = fin(bid) ? bid : lastBid;
      if (px != null) {
        const fee = takerFeePerShare(px, cfg.takerFeeRate) * shares;
        return settle(px, 'taker_time_stop', false, 0, fee, j);
      }
      break; // no bid to flatten into → settle below
    }
  }

  // open at series end (or no bid at the time-stop) → settle at resolution if known, else mark to the last bid.
  const endIdx = ticks.length - 1;
  if (input.resolution && !input.resolution.gradingMismatch && input.resolution.winnerIdx != null) {
    const won = input.resolution.winnerIdx === bucketIdx;
    return settle(won ? 1 : 0, `resolution_settle:${won ? 'win' : 'lose'}`, false, 0, 0, endIdx); // redeem — no taker fee
  }
  return settle(fin(lastBid) ? lastBid : 0, 'mtm_unresolved', false, 0, 0, endIdx);

  // exitIdx = the tick the exit fired at (the loop index, or the series end for a settle/mtm) — the measurement
  // anchor: it dates the exit (exitAt), measures the maker-fill latency, and reads the realized exit-side spread.
  function settle(exitPrice: number, exitKind: string, isMakerExit: boolean, exitRebate: number, exitFee: number, exitIdx: number): MakerExitTrade {
    const feeUsd = entryFee + exitFee;
    const rebateUsd = entryRebate + exitRebate;
    const netPnlUsd = shares * (exitPrice - fill.price) - feeUsd + rebateUsd;
    const safeExitIdx = exitIdx >= fillIdx && exitIdx < ticks.length ? exitIdx : endIdx;
    return {
      eventId, city, targetDate, entryLabel: chosen.label, entryAgeH, entryPrice: fill.price, isMakerEntry,
      exitPrice, exitKind, isMakerExit, entryAt, exitAt: ticks[safeExitIdx]!.capturedAt, feeUsd, rebateUsd, netPnlUsd, stakeUsd,
      netReturn: stakeUsd > 0 ? netPnlUsd / stakeUsd : NaN, executed: true,
      bucketIdx, entryTickIndex: fillIdx, exitTickIndex: safeExitIdx,
      makerFillLatencyTicks: isMakerExit ? safeExitIdx - fillIdx : null,
      observedEntrySpread, observedExitSpread: spreadAt(ticks[safeExitIdx]!, bucketIdx), rebateRateUsed,
    };
  }
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
