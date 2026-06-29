/**
 * core/sim/opening-convergence-view — the PURE dashboard view-model for the /convergence overview page.
 *
 * Turns the raw `opening_captures` series (+ the venue resolution map) into the five things the operator page
 * shows, all by REUSING the tested bracket-replay engine (one source of truth for "what would we do"):
 *
 *   1. logged potential ENTRIES — every fresh-allowlist market the bracket rule actually entered, with the
 *      maker/taker fill, the entry age, and the realized (or marked-open) EXIT + net P&L.
 *   2. EXITS — the exit kind (take-profit / stop-loss / time-stop / resolution / open-marked) per entry.
 *   3. per-day CHANCES — markets considered vs entered per station-local target day + the fire rate.
 *   4. TUNING recommendations — the take-profit sweep (executed%, rule-capture ROI, the look-ahead ceiling,
 *      the §9R-E verdict per TP) + the best in-sample TP, flagged EXPLORATORY (in-sample selection = winner's
 *      curse — never a GO).
 *   5. a FICTIVE MONEY TRACKER — assumes the bot's recommended `perPositionUsd` stake per entry (depth-gated:
 *      selectEntries requires ≥ depthFloorUsd, so the small stake is always fillable), and tracks the running
 *      paper P&L (realized exits + marked-open positions) as an equity curve over the target days.
 *
 * NOTHING here is a live trade or a capital decision — it is the forward PAPER measurement made legible. The
 * §9R-E gate (≥40 markets / ≥6 cities / ≥7 days) still governs any GO; below it the verdict is INSUFFICIENT.
 * Pure + total: junk → empty sections, never throws. Imports only the engine + the raw mappers; no I/O.
 */
import type { OpeningCfg, OpeningLabel } from './opening-convergence.ts';
import { replayEvent, replayPanel } from './opening-bracket-replay.ts';
import { buildEvents, type RawCaptureRow, type Resolution } from './opening-bracket-ingest.ts';

/** The resolution row shape the RPC returns (one per market_event id in the window). */
export interface RawResolution {
  id: string;
  winnerIdx: number | null;
  gradingMismatch: boolean;
}

export type ConvergenceExitKind =
  | 'take_profit'
  | 'stop_loss'
  | 'time_stop'
  | 'resolution_win'
  | 'resolution_lose'
  | 'open_marked';

/** One logged potential entry (the engine's bracket trade made legible). */
export interface ConvergenceEntry {
  eventId: string;
  city: string;
  targetDate: string;
  entryAgeH: number | null;
  entryPrice: number;
  isMaker: boolean;
  stakeUsd: number;
  exitKind: ConvergenceExitKind;
  exitReason: string;
  exitPrice: number;
  netPnlUsd: number;
  netReturn: number;
  /** the look-ahead best sell-back bid (REPORT-ONLY ceiling — what a perfect exit could have caught). */
  bestReachableBid: number;
  /** realized = a fired bracket or a settled resolution; open = still marked-to-bid (unresolved). */
  status: 'realized' | 'open';
}

/** One station-local target day: how many markets we considered vs entered, and that day's paper P&L. */
export interface ConvergencePerDay {
  date: string;
  considered: number;
  entered: number;
  firePct: number;
  stakeUsd: number;
  netPnlUsd: number;
}

/** One take-profit sweep row (the engine's TpSweepRow, page-shaped). */
export interface ConvergenceTuningRow {
  tpDeltaPp: number;
  executedFrac: number;
  nMarkets: number;
  winFrac: number;
  ruleCaptureRoi: number;
  /** avgBestReachableRoundtrip — the look-ahead ceiling (price pp a perfect sell-back could have caught). */
  ceiling: number;
  meanNetReturn: number;
  ciLow: number;
  ciHigh: number;
  zeroSkillPassRate: number;
  label: OpeningLabel;
  isHeadline: boolean;
}

/** The fictive money tracker — the bot's recommended stake per entry + the running paper P&L. */
export interface ConvergenceMoney {
  /** the recommended fictive spend per entry = cfg.perPositionUsd (depth-gated, always fillable). */
  perEntryStakeUsd: number;
  deployedUsd: number;
  netPnlUsd: number;
  realizedPnlUsd: number;
  openMarkedPnlUsd: number;
  roi: number;
  nEntries: number;
  nRealized: number;
  nOpen: number;
  nWins: number;
  nLosses: number;
  winRate: number;
  /** cumulative paper P&L over the target days (ascending) — the equity curve. */
  equity: { date: string; dayUsd: number; cumUsd: number }[];
}

/** The §9R-E gate progress toward a verdict (the headline TP row). */
export interface ConvergenceGate {
  label: OpeningLabel;
  reason: string;
  nMarkets: number;
  minMarkets: number;
  nCities: number;
  minCities: number;
  nDistinctDays: number;
  minDistinctDays: number;
}

export interface ConvergenceView {
  days: number;
  cities: string[];
  headlineTpDeltaPp: number;
  /** fresh-allowlist markets considered in the window (the entry-rule denominator). */
  nFreshEvents: number;
  entries: ConvergenceEntry[];
  perDay: ConvergencePerDay[];
  tuning: ConvergenceTuningRow[];
  /** the best in-sample rule-capture TP (EXPLORATORY — winner's curse; not a GO). null if no executed trades. */
  recommendedTp: { tpDeltaPp: number; ruleCaptureRoi: number } | null;
  money: ConvergenceMoney;
  gate: ConvergenceGate;
}

/** the §9R-E sufficiency bars (mirrored for the gate read-out; the engine enforces the same constants). */
const GATE = { minMarkets: 40, minCities: 6, minDistinctDays: 7 };

/** the take-profit sweep for the tuning panel (the headline cfg.tpDeltaPp is always added by replayPanel). */
export const CONVERGENCE_TP_SWEEP = [0.06, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25];

function exitKindOf(reason: string): ConvergenceExitKind {
  if (reason.startsWith('take_profit')) return 'take_profit';
  if (reason.startsWith('stop_loss')) return 'stop_loss';
  if (reason.startsWith('time_stop')) return 'time_stop';
  if (reason === 'resolution_settle:win') return 'resolution_win';
  if (reason === 'resolution_settle:lose') return 'resolution_lose';
  return 'open_marked'; // mtm_unresolved / mtm_grading_mismatch
}

/**
 * Build the /convergence view from the raw capture series + the resolution rows. cfg supplies the §9R-locked
 * params (cities allowlist, perPositionUsd stake, tpDeltaPp headline, fee/depth) — pass BOT_DEFAULTS (or the
 * parsed live config). tps overrides the sweep (defaults to CONVERGENCE_TP_SWEEP).
 */
export function buildConvergenceView(
  captures: RawCaptureRow[],
  resolutions: RawResolution[],
  cfg: OpeningCfg & { perPositionUsd: number },
  tps: number[] = CONVERGENCE_TP_SWEEP,
): ConvergenceView {
  const resMap = new Map<string, Resolution>(
    (Array.isArray(resolutions) ? resolutions : []).map((r) => [
      String(r.id),
      { winnerIdx: r.winnerIdx ?? null, gradingMismatch: r.gradingMismatch === true },
    ]),
  );
  const events = buildEvents(Array.isArray(captures) ? captures : [], resMap);

  // ── tuning panel: the full TP sweep + the frozen §9R-E verdict per TP ──────────────────────────────
  const panel = replayPanel(events, cfg, tps);
  const tuning: ConvergenceTuningRow[] = panel.perTp.map((r) => ({
    tpDeltaPp: r.tpDeltaPp,
    executedFrac: r.executedFrac,
    nMarkets: r.nMarkets,
    winFrac: r.winFrac,
    ruleCaptureRoi: r.ruleCaptureRoi,
    ceiling: r.avgBestReachableRoundtrip,
    meanNetReturn: r.meanNetReturn,
    ciLow: r.ciLow,
    ciHigh: r.ciHigh,
    zeroSkillPassRate: r.zeroSkillPassRate,
    label: r.label,
    isHeadline: r.tpDeltaPp === panel.headlineTp,
  }));
  const headline = tuning.find((r) => r.isHeadline) ?? null;
  const recommendedTp = tuning
    .filter((r) => Number.isFinite(r.ruleCaptureRoi))
    .reduce<{ tpDeltaPp: number; ruleCaptureRoi: number } | null>(
      (best, r) => (best === null || r.ruleCaptureRoi > best.ruleCaptureRoi ? { tpDeltaPp: r.tpDeltaPp, ruleCaptureRoi: r.ruleCaptureRoi } : best),
      null,
    );

  // ── per-event entries at the HEADLINE TP (the bot-default rule) ────────────────────────────────────
  const entries: ConvergenceEntry[] = [];
  for (const e of events) {
    const t = replayEvent(e, cfg, cfg.tpDeltaPp);
    if (!t.executed || !Number.isFinite(t.netPnlUsd) || !Number.isFinite(t.netReturn)) continue;
    const kind = exitKindOf(t.exitReason);
    entries.push({
      eventId: e.eventId,
      city: e.city,
      targetDate: e.targetDate,
      entryAgeH: t.entryAgeH,
      entryPrice: t.entryPrice,
      isMaker: t.isMaker,
      stakeUsd: t.stakeUsd,
      exitKind: kind,
      exitReason: t.exitReason,
      exitPrice: t.exitPrice,
      netPnlUsd: t.netPnlUsd,
      netReturn: t.netReturn,
      bestReachableBid: t.bestReachableBid,
      status: kind === 'open_marked' ? 'open' : 'realized',
    });
  }
  entries.sort((a, b) => (a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : a.city.localeCompare(b.city)));

  // ── per-day chances: considered (fresh events) vs entered, per target day ──────────────────────────
  const consideredByDay = new Map<string, number>();
  for (const e of events) consideredByDay.set(e.targetDate, (consideredByDay.get(e.targetDate) ?? 0) + 1);
  const dayAgg = new Map<string, { entered: number; stake: number; net: number }>();
  for (const en of entries) {
    const d = dayAgg.get(en.targetDate) ?? { entered: 0, stake: 0, net: 0 };
    d.entered++;
    d.stake += en.stakeUsd;
    d.net += en.netPnlUsd;
    dayAgg.set(en.targetDate, d);
  }
  const perDay: ConvergencePerDay[] = [...consideredByDay.keys()]
    .sort()
    .map((date) => {
      const considered = consideredByDay.get(date) ?? 0;
      const d = dayAgg.get(date) ?? { entered: 0, stake: 0, net: 0 };
      return {
        date,
        considered,
        entered: d.entered,
        firePct: considered > 0 ? d.entered / considered : 0,
        stakeUsd: d.stake,
        netPnlUsd: d.net,
      };
    });

  // ── fictive money tracker: Σ over entries + the cumulative equity curve over target days ────────────
  const realized = entries.filter((e) => e.status === 'realized');
  const open = entries.filter((e) => e.status === 'open');
  const deployedUsd = entries.reduce((a, e) => a + e.stakeUsd, 0);
  const netPnlUsd = entries.reduce((a, e) => a + e.netPnlUsd, 0);
  const realizedPnlUsd = realized.reduce((a, e) => a + e.netPnlUsd, 0);
  const openMarkedPnlUsd = open.reduce((a, e) => a + e.netPnlUsd, 0);
  let cum = 0;
  const equity = perDay.map((d) => {
    cum += d.netPnlUsd;
    return { date: d.date, dayUsd: d.netPnlUsd, cumUsd: cum };
  });
  const money: ConvergenceMoney = {
    perEntryStakeUsd: cfg.perPositionUsd,
    deployedUsd,
    netPnlUsd,
    realizedPnlUsd,
    openMarkedPnlUsd,
    roi: deployedUsd > 0 ? netPnlUsd / deployedUsd : 0,
    nEntries: entries.length,
    nRealized: realized.length,
    nOpen: open.length,
    nWins: realized.filter((e) => e.netPnlUsd > 0).length,
    nLosses: realized.filter((e) => e.netPnlUsd <= 0).length,
    winRate: realized.length > 0 ? realized.filter((e) => e.netPnlUsd > 0).length / realized.length : 0,
    equity,
  };

  // ── gate progress (the headline TP row's §9R-E counts) ─────────────────────────────────────────────
  const gate: ConvergenceGate = {
    label: headline?.label ?? 'INSUFFICIENT_DATA',
    reason: panel.perTp.find((r) => r.tpDeltaPp === panel.headlineTp)?.reason ?? 'no panel',
    nMarkets: headline?.nMarkets ?? 0,
    minMarkets: GATE.minMarkets,
    nCities: new Set(realized.concat(open).map((e) => e.city)).size,
    minCities: GATE.minCities,
    nDistinctDays: new Set(entries.map((e) => e.targetDate)).size,
    minDistinctDays: GATE.minDistinctDays,
  };

  return {
    days: 0, // set by the caller (the RPC window) — kept here for shape completeness
    cities: cfg.cities,
    headlineTpDeltaPp: cfg.tpDeltaPp,
    nFreshEvents: events.length,
    entries,
    perDay,
    tuning,
    recommendedTp,
    money,
    gate,
  };
}
