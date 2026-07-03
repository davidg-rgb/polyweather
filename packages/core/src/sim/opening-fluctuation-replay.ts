/**
 * core/sim/opening-fluctuation-replay — the FLUCTUATION-TAKER variant of the archive replay engines
 * (the 2026-07-03 operator-requested sim, BUILD-STATE morning queue #3).
 *
 * WHY THIS EXISTS. The corrected 819-event archive moved the plain taker bracket's breakeven from ×0.70 to
 * ×1.14 of the calibrated spread (mean-positive at the real spread, CI-blocked) — so PRICE-PATH taker variants
 * are no longer pre-doomed by the round-trip cost alone. This engine tests the operator's specific question:
 * do intraday FLUCTUATIONS of the key buckets (the forecast-center ±1 set, re-centered per lead as the house
 * forecast refreshes) carry a harvestable taker edge — buy a dip (or ride momentum), sell into the bounce —
 * where the flat-open and first-tick entries could not?
 *
 * THE KEY SET IS LEAD-AWARE, WITH NO LOOK-AHEAD. Each event carries its production `house_gaussian` dists
 * (leads 2/1/0) with their real `made_at`; at any tick t the operative center is the LATEST dist with
 * made_at ≤ t — a fresher forecast is never visible before it existed (the lead-1 center cannot steer a
 * lead-2 tick). The key set = center ± centerHalfWidth in bucket space (±1 bucket ≈ ±1°C on the °C ladders).
 *
 * ENTRY (taker, price-path): within the CURRENT key set, enter when the bucket's mid has dipped at least
 * `dipDepth` below its rolling max over the trailing `momentumWindowMin` minutes (entryMode 'dip'), or risen
 * that much above its rolling min (entryMode 'momentum'). Fill at that tick's execAsk + paperSlippage with the
 * real taker fee curve (takerFeePerShare = rate·p·(1−p)) — the WHOLE point of the variant is to measure the
 * path edge NET of the taker round-trip that killed the plain bracket. One entry per event.
 *
 * EXIT (taker, swept incl. path-based): 'bracket' = fixed TP (entry+tpDeltaPp) + the ternary SL;
 * 'trail' = a trailing peak-bid drawdown stop (exit when bid ≤ postEntryPeakBid − trailPp) + the same ternary
 * SL floor. Both carry the HARD time-stop at resolvesAt − tstopHoursBeforeResolve (taker flatten; the
 * maker-exit engine's clock) and an OPTIONAL `exitOnRecenter` path exit (flatten when a fresher forecast
 * moves the key set off the held bucket). Settlement/mtm mirrors the sibling engines: resolution $1/$0
 * (redeem, no fee), else mark to the last realizable bid (mtm_unresolved — excluded from the gate).
 *
 * NO LOOK-AHEAD (the load-bearing invariant, shared with the siblings). The entry signal at tick t reads only
 * mids at ticks ≤ t; the exit decision at tick t reads only tick t's execBid + the wall clock at t; the walk
 * BREAKS at the first firing — a later up-tick can never rescue a stopped-out trade. The trailing peak is the
 * max of PAST post-entry bids. Pure + total (junk → executed:false / NaN, never throws). Imports only sibling
 * pure modules — never io/trading/fs.
 */
import { openingVerdict, type OpeningMarketResult, type OpeningVerdict, type VerdictOpts, type OpeningBucket } from './opening-convergence.ts';
import type { EventReplayInput, ReplayTick } from './opening-bracket-replay.ts';
import { takerFeePerShare } from '../fees.ts';
import { leadDays, localHourInstant } from '../time.ts';

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Config + types
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One production forecast dist (calibrated house_gaussian) with its REAL made_at — the re-center stream. */
export interface FluctuationDist {
  /** epoch ms the dist was actually made (bucket_probabilities.made_at) — the no-look-ahead anchor. */
  madeAtMs: number;
  /** prob by bucket idx (the same alignment loadPanel's toProbMap produces). */
  probsByIdx: Map<number, number>;
}

/** The fluctuation-taker engine's config — standalone (it does not reuse selectEntries; the entry is a path signal). */
export interface FluctuationCfg {
  cities: string[];
  /** key set = forecast-center ± this many buckets (±1 bucket ≈ ±1°C on the °C ladders — the operator's spec). */
  centerHalfWidth: number;
  /** the path-signal direction: 'dip' = buy a drop (mean-reversion), 'momentum' = buy a rise (continuation). */
  entryMode: 'dip' | 'momentum';
  /** the signal magnitude (implied-prob pp) the path must move within the window to fire. */
  dipDepth: number;
  /** the trailing window (minutes) the rolling reference extreme is computed over. */
  momentumWindowMin: number;
  /** never take an ask above this (the cheap-convergence price cap). */
  maxEntryPrice: number;
  /** the walked-depth floor ($) the signal bucket must carry at the signal tick. */
  depthFloorUsd: number;
  perPositionUsd: number;
  /** additive pessimistic slippage on the taker entry (the paperFill idiom). */
  paperSlippage: number;
  /** the real weather fee curve rate — takerFeePerShare(p, rate) on BOTH legs. */
  takerFeeRate: number;
  /** the exit family: 'bracket' = fixed TP + ternary SL; 'trail' = trailing peak-bid drawdown + ternary SL. */
  exitRule: 'bracket' | 'trail';
  /** bracket TP: taker sell when bid ≥ entry + this. */
  tpDeltaPp: number;
  /** trail: taker sell when bid ≤ post-entry peak bid − this. */
  trailPp: number;
  /** the ternary stop's absolute leg (entry − slDeltaPp where positive…). */
  slDeltaPp: number;
  /** …falling to the relative floor entry×(1−slFrac) for the cheapest band (the F13/F1 idiom). */
  slFrac: number;
  /** the HARD time-stop: taker-flatten at the latest this many hours BEFORE the market resolves. */
  tstopHoursBeforeResolve: number;
  /** the local-hour fallback clock when resolvesAt is unknown (the maker-exit idiom; noon = 12). */
  timeStopLocalHour: number;
  /** OPTIONAL path exit: flatten when a fresher forecast re-centers the key set OFF the held bucket. */
  exitOnRecenter: boolean;
}

export const FLUCTUATION_DEFAULTS: FluctuationCfg = {
  cities: [],
  centerHalfWidth: 1,
  entryMode: 'dip',
  dipDepth: 0.05,
  momentumWindowMin: 120,
  maxEntryPrice: 0.3,
  depthFloorUsd: 100,
  perPositionUsd: 20,
  paperSlippage: 0.01,
  takerFeeRate: 0.05,
  exitRule: 'bracket',
  tpDeltaPp: 0.1,
  trailPp: 0.08,
  slDeltaPp: 0.2,
  slFrac: 0.5,
  tstopHoursBeforeResolve: 18,
  timeStopLocalHour: 12,
  exitOnRecenter: false,
};

/** One market's realized fluctuation-taker trade (the ledger row). */
export interface FluctuationTrade {
  eventId: string;
  city: string;
  targetDate: string;
  entryLabel: string;
  entryAgeH: number | null;
  /** the whole-day lead at the entry tick (0 = target day in progress) — report-only; null on a bad tz. */
  entryLead: number | null;
  /** the fired path-signal magnitude (refExtreme↔mid distance, pp) at the entry tick — report-only. */
  signalMagnitude: number;
  entryPrice: number;
  exitPrice: number;
  /** 'taker_take_profit'|'taker_trail_stop'|'taker_stop_loss'|'taker_recenter'|'taker_time_stop'|
   *  'resolution_settle:win/lose'|'mtm_unresolved' (executed) — or the non-exec reason. */
  exitKind: string;
  entryAt: string;
  exitAt: string;
  feeUsd: number;
  netPnlUsd: number;
  stakeUsd: number;
  netReturn: number;
  executed: boolean;
  bucketIdx: number;
  entryTickIndex: number;
  exitTickIndex: number;
}

const NOT_EXECUTED = (eventId: string, city: string, targetDate: string, reason: string): FluctuationTrade => ({
  eventId, city, targetDate, entryLabel: '', entryAgeH: null, entryLead: null, signalMagnitude: NaN,
  entryPrice: NaN, exitPrice: NaN, exitKind: reason, entryAt: '', exitAt: '', feeUsd: 0,
  netPnlUsd: 0, stakeUsd: 0, netReturn: NaN, executed: false,
  bucketIdx: -1, entryTickIndex: -1, exitTickIndex: -1,
});

/** the F13/F1 ternary stop (the operator-locked absolute delta wherever positive, else the relative floor). */
function stopOf(entry: number, cfg: FluctuationCfg): number {
  return entry - cfg.slDeltaPp > 0 ? entry - cfg.slDeltaPp : entry * (1 - cfg.slFrac);
}

/** a bucket at a tick by idx identity (null if the book dropped it). */
function bucketAt(tick: ReplayTick, idx: number): OpeningBucket | undefined {
  return (Array.isArray(tick.buckets) ? tick.buckets : []).find((b) => b && b.idx === idx);
}

/** the argmax-prob bucket idx of a dist (the forecast CENTER); −1 if the dist carries no finite prob. */
export function distCenterIdx(probsByIdx: Map<number, number>): number {
  let modeIdx = -1;
  let modeProb = Number.NEGATIVE_INFINITY;
  for (const [idx, p] of probsByIdx) {
    if (fin(p) && p > modeProb) {
      modeProb = p;
      modeIdx = idx;
    }
  }
  return modeIdx;
}

/**
 * The index into `dists` (sorted ASC by madeAtMs) of the LATEST dist with madeAtMs ≤ tMs — the operative
 * forecast at time t (−1 = none exists yet: before the first dist the key set is UNDEFINED and no entry /
 * recenter judgment is possible). The no-look-ahead seam: a fresher forecast is invisible before its made_at.
 */
export function activeDistIdx(dists: FluctuationDist[], tMs: number): number {
  let k = -1;
  for (let i = 0; i < dists.length; i++) {
    if (dists[i]!.madeAtMs <= tMs) k = i;
    else break;
  }
  return k;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · replayFluctuationEvent — path-signal taker entry → bracket/trail/recenter/time-stop taker exit
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function replayFluctuationEvent(
  input: EventReplayInput,
  dists: FluctuationDist[],
  cfg: FluctuationCfg,
  resolvesAtMs: number | null,
): FluctuationTrade {
  const eventId = input?.eventId ?? '';
  const city = input?.city ?? '';
  const targetDate = input?.targetDate ?? '';
  if (!input || !Array.isArray(input.ticks) || input.ticks.length === 0) {
    return NOT_EXECUTED(eventId, city, targetDate, 'no_ticks');
  }
  const ticks = input.ticks;
  const ds = (Array.isArray(dists) ? dists : []).filter((d) => d && fin(d.madeAtMs) && d.probsByIdx instanceof Map);

  // the HARD time-stop clock (the maker-exit idiom): resolvesAt − N h, else the local-hour fallback.
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

  // ── (1) ENTRY scan — the first tick where a CURRENT-key-set bucket fires the path signal ──────────────
  const chw = Math.max(0, Math.floor(cfg.centerHalfWidth));
  const windowMs = Math.max(0, cfg.momentumWindowMin) * 60_000;
  let sawDist = false;
  let entryIdx = -1;
  let entryBucketIdx = -1;
  let entryLabel = '';
  let signalMagnitude = NaN;
  let entryAsk = NaN;

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    const tMs = new Date(t.capturedAt).getTime();
    if (!Number.isFinite(tMs)) continue;
    if (tMs >= timeStopMs) break; // no runway left under this exit clock — nothing later can be entered either
    const k = activeDistIdx(ds, tMs);
    if (k < 0) continue; // the key set does not exist yet (no forecast made before t)
    sawDist = true;
    const centerIdx = distCenterIdx(ds[k]!.probsByIdx);
    if (centerIdx < 0) continue;

    // scan the CURRENT key set (center ± chw) for the deepest firing signal at this tick.
    let bestMag = Number.NEGATIVE_INFINITY;
    let bestBucket: OpeningBucket | null = null;
    for (const b of Array.isArray(t.buckets) ? t.buckets : []) {
      if (!b || Math.abs(b.idx - centerIdx) > chw) continue;
      if (!fin(b.mid)) continue;
      // entry gates at THIS tick (the signal tick is the fill tick — taker).
      if (!fin(b.execAsk) || b.execAsk <= 0 || b.execAsk > cfg.maxEntryPrice) continue;
      if (!(b.depthUsd >= cfg.depthFloorUsd)) continue;
      // the rolling reference extreme over the trailing window (ticks ≤ i only — no look-ahead).
      let ref = cfg.entryMode === 'dip' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      for (let j = i; j >= 0; j--) {
        const tj = ticks[j]!;
        const tjMs = new Date(tj.capturedAt).getTime();
        if (!Number.isFinite(tjMs) || tMs - tjMs > windowMs) break; // ticks are time-ordered — past the window
        const mj = bucketAt(tj, b.idx)?.mid ?? null;
        if (!fin(mj)) continue;
        ref = cfg.entryMode === 'dip' ? Math.max(ref, mj) : Math.min(ref, mj);
      }
      if (!Number.isFinite(ref)) continue;
      const mag = cfg.entryMode === 'dip' ? ref - b.mid : b.mid - ref;
      if (mag >= cfg.dipDepth && mag > bestMag) {
        bestMag = mag;
        bestBucket = b;
      }
    }
    if (bestBucket) {
      entryIdx = i;
      entryBucketIdx = bestBucket.idx;
      entryLabel = bestBucket.label;
      signalMagnitude = bestMag;
      entryAsk = bestBucket.execAsk as number;
      break;
    }
  }
  if (entryIdx < 0) return NOT_EXECUTED(eventId, city, targetDate, sawDist ? 'never_signaled' : 'no_dist');

  // ── (2) the taker FILL at the signal tick (ask + pessimistic slippage, real fee curve) ────────────────
  const price = entryAsk + cfg.paperSlippage;
  if (!(price > 0)) return NOT_EXECUTED(eventId, city, targetDate, 'never_signaled');
  const shares = cfg.perPositionUsd / price;
  const stakeUsd = price * shares;
  const entryFee = takerFeePerShare(price, cfg.takerFeeRate) * shares;
  const entryAt = ticks[entryIdx]!.capturedAt;
  const entryAgeH = fin(ticks[entryIdx]!.hoursSinceListing) ? ticks[entryIdx]!.hoursSinceListing : null;
  let entryLead: number | null = null;
  try {
    entryLead = leadDays(new Date(entryAt), targetDate, input.tz);
  } catch {
    entryLead = null;
  }

  const slStop = stopOf(price, cfg);
  const tpLimit = price + cfg.tpDeltaPp;

  // ── (3) EXIT walk from the tick AFTER the fill. NO LOOK-AHEAD; breaks at the first firing ─────────────
  // lastBid seeds from the ENTRY tick's own bid (a mark that really existed at fill time) so a series that
  // ends immediately after the fill marks to it, not to a degenerate 0. peakBid stays post-entry only —
  // the trail measures drawdown from a peak the POSITION lived through, never the pre-fill book.
  const entryTickBid = bucketAt(ticks[entryIdx]!, entryBucketIdx)?.execBid ?? null;
  let lastBid: number | null = fin(entryTickBid) ? entryTickBid : null;
  let peakBid = Number.NEGATIVE_INFINITY; // post-entry running max of the realizable bid (the trail anchor)
  for (let j = entryIdx + 1; j < ticks.length; j++) {
    const t = ticks[j]!;
    const nowMs = new Date(t.capturedAt).getTime();
    const bid = bucketAt(t, entryBucketIdx)?.execBid ?? null;
    if (fin(bid)) {
      lastBid = bid;
      if (bid > peakBid) peakBid = bid;
    }

    // (a) the profit leg — fixed TP (bracket) or the trailing peak-drawdown (trail). Taker sell into the bid.
    if (cfg.exitRule === 'bracket' && fin(bid) && bid >= tpLimit) {
      return settle(bid, 'taker_take_profit', takerFeePerShare(bid, cfg.takerFeeRate) * shares, j);
    }
    if (cfg.exitRule === 'trail' && fin(bid) && Number.isFinite(peakBid) && peakBid - bid >= cfg.trailPp && peakBid > bid) {
      return settle(bid, 'taker_trail_stop', takerFeePerShare(bid, cfg.takerFeeRate) * shares, j);
    }
    // (b) the ternary stop-loss (both exit rules — the protective floor).
    if (fin(bid) && bid <= slStop) {
      return settle(bid, 'taker_stop_loss', takerFeePerShare(bid, cfg.takerFeeRate) * shares, j);
    }
    // (c) OPTIONAL recenter path exit: a fresher forecast moved the key set off the held bucket.
    if (cfg.exitOnRecenter) {
      const k = activeDistIdx(ds, nowMs);
      if (k >= 0) {
        const c = distCenterIdx(ds[k]!.probsByIdx);
        if (c >= 0 && Math.abs(entryBucketIdx - c) > chw) {
          const px = fin(bid) ? bid : lastBid;
          if (px != null) return settle(px, 'taker_recenter', takerFeePerShare(px, cfg.takerFeeRate) * shares, j);
        }
      }
    }
    // (d) the HARD time-stop: taker-flatten at the realizable bid (or the last seen bid).
    if (nowMs >= timeStopMs) {
      const px = fin(bid) ? bid : lastBid;
      if (px != null) return settle(px, 'taker_time_stop', takerFeePerShare(px, cfg.takerFeeRate) * shares, j);
      break; // no bid to flatten into → settle below
    }
  }

  // open at series end (or no bid at the time-stop) → settle at resolution if known, else mark to the last bid.
  const endIdx = ticks.length - 1;
  if (input.resolution && !input.resolution.gradingMismatch && input.resolution.winnerIdx != null) {
    const won = input.resolution.winnerIdx === entryBucketIdx;
    return settle(won ? 1 : 0, `resolution_settle:${won ? 'win' : 'lose'}`, 0, endIdx); // redeem — no taker fee
  }
  return settle(fin(lastBid) ? lastBid : 0, 'mtm_unresolved', 0, endIdx);

  function settle(exitPrice: number, exitKind: string, exitFee: number, exitIdx: number): FluctuationTrade {
    const feeUsd = entryFee + exitFee;
    const netPnlUsd = shares * (exitPrice - price) - feeUsd;
    const safeExitIdx = exitIdx >= entryIdx && exitIdx < ticks.length ? exitIdx : endIdx;
    return {
      eventId, city, targetDate, entryLabel, entryAgeH, entryLead, signalMagnitude,
      entryPrice: price, exitPrice, exitKind, entryAt, exitAt: ticks[safeExitIdx]!.capturedAt,
      feeUsd, netPnlUsd, stakeUsd, netReturn: stakeUsd > 0 ? netPnlUsd / stakeUsd : NaN, executed: true,
      bucketIdx: entryBucketIdx, entryTickIndex: entryIdx, exitTickIndex: safeExitIdx,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · replayFluctuationPanel — run every event, return the §9R-E verdict + the per-trade ledger
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One panel item: the replay input + its production forecast-dist stream (leads 2/1/0, made_at-anchored). */
export interface FluctuationPanelInput {
  event: EventReplayInput;
  dists: FluctuationDist[];
}

export interface FluctuationPanel {
  ledger: FluctuationTrade[];
  /** the frozen §9R-E verdict over the REALIZED (non-mtm) trades (verdictOpts.dayBlockNull = the tightening). */
  verdict: OpeningVerdict;
  meanNetReturn: number;
  winFrac: number;
  totalNetUsd: number;
  nExecuted: number;
  nRealized: number;
}

export function replayFluctuationPanel(
  items: FluctuationPanelInput[],
  cfg: FluctuationCfg,
  resolvesByEvent: Map<string, number | null>,
  verdictOpts: VerdictOpts = {},
): FluctuationPanel {
  const its = (Array.isArray(items) ? items : []).filter(
    (x): x is FluctuationPanelInput => !!x && !!x.event && Array.isArray(x.event.ticks),
  );
  const ledger: FluctuationTrade[] = [];
  const panel: OpeningMarketResult[] = [];
  let realized = 0;
  for (const { event, dists } of its) {
    if (event.resolution?.gradingMismatch) continue; // ambiguous payout — out of scoring entirely
    const t = replayFluctuationEvent(event, dists, cfg, resolvesByEvent.get(event.eventId) ?? null);
    if (!t.executed || !Number.isFinite(t.netReturn) || !Number.isFinite(t.netPnlUsd)) continue;
    ledger.push(t);
    if (!t.exitKind.startsWith('mtm_')) {
      realized++;
      panel.push({ city: event.city, targetDate: event.targetDate, netPnlUsd: t.netPnlUsd, stakeUsd: t.stakeUsd, netReturn: t.netReturn, executed: true });
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
  };
}
