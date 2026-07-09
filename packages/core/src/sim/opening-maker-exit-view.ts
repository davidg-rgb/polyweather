/**
 * core/sim/opening-maker-exit-view — the PURE dashboard view-model for the /maker-exit forward-paper page.
 *
 * The maker-exit twin of opening-convergence-view (the /convergence taker-bracket page): it turns the raw
 * `opening_captures` series (+ the venue resolution map) into the operator's forward read of the MAKER-EXIT
 * convergence strategy (MAKER-EXIT-SIM.md → MAKER-EXIT-PAPER-LOOP-HANDOFF.md), by REUSING the tested maker-exit
 * replay engine (one source of truth for "what would we do"):
 *
 *   1. logged potential ENTRIES — every fresh-allowlist market the rule entered, the maker/taker entry fill,
 *      and its MAKER-take-profit / TAKER-stop-loss / TAKER-time-stop EXIT + net P&L (rebate-credited maker legs).
 *   2. per-day CHANCES — markets considered vs entered per station-local target day + the fire rate.
 *   3. a FICTIVE MONEY TRACKER — the bot's recommended perPositionUsd stake per entry + the running paper P&L.
 *   4. the THREE MEASURED ASSUMPTIONS the 708-event backtest could not resolve (the loop's whole reason to exist,
 *      handoff §1) — the realized MAKER-FILL RATE (assumption #1, the §12 adverse-selection read), the realized
 *      REBATE at the configured tier (assumption #2), and the DAYS / cities / markets accrued (assumption #3).
 *   5. the §9R-E gate progress toward a verdict (≥40 markets / ≥6 cities / ≥7 days, clustered CI, zero-skill MC).
 *   4b. the v2 "WHY zero" pool-context extension (SIGNAL-BACKLOG #1 follow-on, 2026-07-03/04) — when
 *      qualifyingTickFrac reads 0/low, decomposes the resting TP sell's disqualification into distance-from-mid,
 *      price-band membership, and min_size failure, plus a one-line dominantDisqualifier read. ADDITIVE ONLY —
 *      the §9R-E gate math (item 5) is untouched by this extension.
 *
 * NOTHING here is a live trade or a capital decision — it is the forward PAPER measurement made legible; the
 * §9R-E gate still governs any GO and stays the capital backstop. Pure + total: junk → empty sections, never
 * throws. Imports only the engine + the shared raw mappers (buildEvents — the SAME ingest the /convergence view
 * and the authoritative scorer use, so the universes cannot drift); no I/O.
 */
import { GATE_MIN_MARKETS, GATE_MIN_CITIES, GATE_MIN_DISTINCT_DAYS } from './opening-convergence.ts';
import type { OpeningLabel } from './opening-convergence.ts';
import { buildEvents, type RawCaptureRow, type Resolution } from './opening-bracket-ingest.ts';
import type { RawResolution } from './opening-convergence-view.ts';
import {
  replayMakerExitPanel,
  type MakerExitCfg,
  type MakerExitTrade,
  type MakerExitDisqualifierStats,
} from './opening-maker-exit-replay.ts';

export type MakerExitKind =
  | 'maker_take_profit'
  | 'taker_stop_loss'
  | 'taker_time_stop'
  | 'resolution_win'
  | 'resolution_lose'
  | 'open_marked';

/** One logged potential entry (a maker-exit trade made legible) — carries the measurement diagnostics. */
export interface MakerExitEntry {
  eventId: string;
  city: string;
  targetDate: string;
  /** the forecast-center bucket label we bought — our predicted-Tmax bucket / the temperature the bet opened on. */
  entryLabel: string;
  entryAgeH: number | null;
  entryPrice: number;
  isMakerEntry: boolean;
  stakeUsd: number;
  exitKind: MakerExitKind;
  exitPrice: number;
  isMakerExit: boolean;
  feeUsd: number;
  rebateUsd: number;
  netPnlUsd: number;
  netReturn: number;
  /** ── measurement diagnostics (handoff §3) ── */
  makerFillLatencyTicks: number | null;
  observedEntrySpread: number;
  observedExitSpread: number;
  rebateRateUsed: number;
  /** realized = a fired exit or a settled resolution; open = still marked-to-bid (unresolved). */
  status: 'realized' | 'open';
}

/** One station-local target day: how many markets we considered vs entered, and that day's paper P&L. */
export interface MakerExitPerDay {
  date: string;
  considered: number;
  entered: number;
  firePct: number;
  stakeUsd: number;
  netPnlUsd: number;
}

/** The fictive money tracker — the bot's recommended stake per entry + the running paper P&L. */
export interface MakerExitMoney {
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

/** The three measured assumptions the backtest could not resolve (handoff §1) + their supporting reads. */
export interface MakerExitAssumptions {
  /** #1 — the realized maker-fill rate: share of REALIZED exits that filled as a MAKER take-profit (the §12
   *  adverse-selection read; the most likely way the forward run KILLs if it craters). NaN with no realized. */
  makerFillRate: number;
  /** mean ticks a winning maker SELL waited before a buyer lifted it (over the maker-TP exits). */
  meanMakerFillLatencyTicks: number;
  /** #2 — the realized maker rebate ($, over realized trades) at the configured tier + the rate applied. */
  realizedRebateUsd: number;
  rebateRateUsed: number;
  /** the measured round-trip cost the maker exit recovers (mean observed top-of-book spread, entry/exit legs). */
  meanObservedEntrySpread: number;
  meanObservedExitSpread: number;
  /** #3 — temporal extent accrued (the CI narrows as these grow): realized markets, cities, distinct target days. */
  nMarkets: number;
  nCities: number;
  nDistinctDays: number;
  /** #4 — SIGNAL-BACKLOG #1 follow-on (2026-07-03): of every tick the resting TP sell was live (realized trades
   *  only), the fraction whose prior-tick mid put it in Polymarket's reward-qualifying band — weighted by
   *  resting ticks. Measures the pool-SHARE-agnostic input directly on the live book: does the order even
   *  qualify? The $ pool share stays an explicit unknown — this never accrues or assumes a dollar amount. NaN
   *  with zero resting ticks accrued yet. */
  qualifyingTickFrac: number;
  /** the raw numerator/denominator behind qualifyingTickFrac (so a reader sees the sample size, not just the ratio). */
  nQualifyingRestingTicks: number;
  nRestingTicks: number;
  /** #4b — v2 "WHY zero" pool-context extension (SIGNAL-BACKLOG #1 follow-on, 2026-07-03): decomposes a
   *  disqualified resting tick into WHY — too far from mid (PRICE-BAND), stake below the venue's min_size
   *  floor (SIZE), or neither (the residual is the strict two-sided mid-regime rule, which this diagnostic
   *  does not decompose further — see MakerExitDisqualifierStats' docstring). Straight passthrough from the
   *  panel; same tick-weighted / never-fabricated / pool-SHARE-agnostic conventions as qualifyingTickFrac. */
  meanDistFromMidPp: number;
  fracWithinAdvertisedBand: number;
  fracFailsMinSize: number;
  dominantDisqualifier: MakerExitDisqualifierStats['dominantDisqualifier'];
}

/** The §9R-E gate progress toward a verdict — straight from openingVerdict over the realized maker-exit ledger. */
export interface MakerExitGate {
  label: OpeningLabel;
  reason: string;
  nMarkets: number;
  minMarkets: number;
  nCities: number;
  minCities: number;
  nDistinctDays: number;
  minDistinctDays: number;
  winFrac: number;
  meanNetReturn: number;
  ciLow: number;
  ciHigh: number;
  zeroSkillPassRate: number;
}

export interface MakerExitView {
  days: number;
  cities: string[];
  /** the tuned maker-exit params this view replayed (handoff §5) — surfaced so the page shows the live config. */
  tpDeltaPp: number;
  slDeltaPp: number;
  tstopHoursBeforeResolve: number;
  makerRebateRate: number;
  /** fresh-allowlist markets considered in the window (the entry-rule denominator, gm-excluded). */
  nFreshEvents: number;
  entries: MakerExitEntry[];
  perDay: MakerExitPerDay[];
  money: MakerExitMoney;
  assumptions: MakerExitAssumptions;
  gate: MakerExitGate;
  /** per-city input-fetch errors on the Edge tick that produced this view (the handler overrides the 0 default). */
  cityErrors: number;
}

/** the §9R-E sufficiency bars — imported from the engine (single source of truth; openingVerdict enforces them). */
const GATE = { minMarkets: GATE_MIN_MARKETS, minCities: GATE_MIN_CITIES, minDistinctDays: GATE_MIN_DISTINCT_DAYS };

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const meanFinite = (xs: number[]): number => {
  const f = xs.filter((x) => Number.isFinite(x));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN;
};

function exitKindOf(reason: string): MakerExitKind {
  if (reason === 'maker_take_profit') return 'maker_take_profit';
  if (reason === 'taker_stop_loss') return 'taker_stop_loss';
  if (reason === 'taker_time_stop') return 'taker_time_stop';
  if (reason === 'resolution_settle:win') return 'resolution_win';
  if (reason === 'resolution_settle:lose') return 'resolution_lose';
  return 'open_marked'; // mtm_unresolved
}

/**
 * Build the /maker-exit view from the raw capture series + the resolution rows. cfg supplies the §9R-locked
 * params + the tuned maker-exit knobs (cities allowlist, perPositionUsd stake, tpDeltaPp/slDeltaPp,
 * tstopHoursBeforeResolve, makerRebateRate, fee/depth) — pass the pinned MAKER_EXIT defaults (handoff §5).
 * The time-stop anchor (resolvesAt) comes from the captures themselves (the venue resolution clock), so no
 * external resolution join is needed for a realized exit — the 18h time-stop flattens from the captured book.
 */
export function buildMakerExitView(
  captures: RawCaptureRow[],
  resolutions: RawResolution[],
  cfg: MakerExitCfg,
): MakerExitView {
  const caps = Array.isArray(captures) ? captures : [];
  const resMap = new Map<string, Resolution>(
    (Array.isArray(resolutions) ? resolutions : []).map((r) => [
      String(r.id),
      { winnerIdx: r.winnerIdx ?? null, gradingMismatch: r.gradingMismatch === true },
    ]),
  );
  const events = buildEvents(caps, resMap);

  // resolvesByEvent (eventId → the venue resolution epoch ms — the maker-exit time-stop anchor) from the raw
  // captures; first finite resolvesAt per event wins (it is constant per event — the Gamma endDate).
  const resolvesByEvent = new Map<string, number | null>();
  for (const c of caps) {
    if (!c.eventId || resolvesByEvent.has(c.eventId)) continue;
    const ms = c.resolvesAt ? Date.parse(c.resolvesAt) : NaN;
    resolvesByEvent.set(c.eventId, Number.isFinite(ms) ? ms : null);
  }

  // grading_mismatch markets (ambiguous payout) are EXCLUDED from scoring — replayMakerExitPanel filters them
  // out, so the entries / per-day / money / gate counts derive from the SAME excluded population (one source).
  const considered = events.filter((e) => !e.resolution.gradingMismatch);
  // priceBasis 'real-book': the forward loop replays the REAL captured book (the whole point vs the
  // synthetic-book backtest that false-passed — MAKER-EXIT-SIM.md root-cause banner).
  const panel = replayMakerExitPanel(events, cfg, resolvesByEvent, { priceBasis: 'real-book' });

  // ── per-event entries from the replayed ledger (executed trades) ─────────────────────────────────────
  const entries: MakerExitEntry[] = panel.ledger
    .filter((t: MakerExitTrade) => t.executed && Number.isFinite(t.netPnlUsd) && Number.isFinite(t.netReturn))
    .map((t: MakerExitTrade) => ({
      eventId: t.eventId,
      city: t.city,
      targetDate: t.targetDate,
      entryLabel: t.entryLabel,
      entryAgeH: t.entryAgeH,
      entryPrice: t.entryPrice,
      isMakerEntry: t.isMakerEntry,
      stakeUsd: t.stakeUsd,
      exitKind: exitKindOf(t.exitKind),
      exitPrice: t.exitPrice,
      isMakerExit: t.isMakerExit,
      feeUsd: t.feeUsd,
      rebateUsd: t.rebateUsd,
      netPnlUsd: t.netPnlUsd,
      netReturn: t.netReturn,
      makerFillLatencyTicks: t.makerFillLatencyTicks,
      observedEntrySpread: t.observedEntrySpread,
      observedExitSpread: t.observedExitSpread,
      rebateRateUsed: t.rebateRateUsed,
      status: t.exitKind.startsWith('mtm_') ? ('open' as const) : ('realized' as const),
    }));
  entries.sort((a, b) => (a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : a.city.localeCompare(b.city)));

  // ── per-day chances: considered (fresh, gm-excluded) vs entered, per target day ──────────────────────
  const consideredByDay = new Map<string, number>();
  for (const e of considered) consideredByDay.set(e.targetDate, (consideredByDay.get(e.targetDate) ?? 0) + 1);
  const dayAgg = new Map<string, { entered: number; stake: number; net: number }>();
  for (const en of entries) {
    const d = dayAgg.get(en.targetDate) ?? { entered: 0, stake: 0, net: 0 };
    d.entered++;
    d.stake += en.stakeUsd;
    d.net += en.netPnlUsd;
    dayAgg.set(en.targetDate, d);
  }
  const perDay: MakerExitPerDay[] = [...consideredByDay.keys()].sort().map((date) => {
    const consideredN = consideredByDay.get(date) ?? 0;
    const d = dayAgg.get(date) ?? { entered: 0, stake: 0, net: 0 };
    return { date, considered: consideredN, entered: d.entered, firePct: consideredN > 0 ? d.entered / consideredN : 0, stakeUsd: d.stake, netPnlUsd: d.net };
  });

  // ── fictive money tracker: Σ over entries + the cumulative equity curve over target days ─────────────
  const realized = entries.filter((e) => e.status === 'realized');
  const open = entries.filter((e) => e.status === 'open');
  const deployedUsd = entries.reduce((a, e) => a + e.stakeUsd, 0);
  const netPnlUsd = entries.reduce((a, e) => a + e.netPnlUsd, 0);
  const realizedPnlUsd = realized.reduce((a, e) => a + e.netPnlUsd, 0);
  let cum = 0;
  const equity = perDay.map((d) => {
    cum += d.netPnlUsd;
    return { date: d.date, dayUsd: d.netPnlUsd, cumUsd: cum };
  });
  const money: MakerExitMoney = {
    perEntryStakeUsd: cfg.perPositionUsd,
    deployedUsd,
    netPnlUsd,
    realizedPnlUsd,
    openMarkedPnlUsd: open.reduce((a, e) => a + e.netPnlUsd, 0),
    roi: deployedUsd > 0 ? netPnlUsd / deployedUsd : 0,
    nEntries: entries.length,
    nRealized: realized.length,
    nOpen: open.length,
    nWins: realized.filter((e) => e.netPnlUsd > 0).length,
    nLosses: realized.filter((e) => e.netPnlUsd <= 0).length,
    winRate: realized.length > 0 ? realized.filter((e) => e.netPnlUsd > 0).length / realized.length : 0,
    equity,
  };

  // ── the three measured assumptions (handoff §1) — over the REALIZED ledger only ──────────────────────
  const makerTps = realized.filter((e) => e.isMakerExit);
  const assumptions: MakerExitAssumptions = {
    makerFillRate: panel.makerExitFrac, // realized maker-TP share — the §12 adverse-selection read (#1)
    meanMakerFillLatencyTicks: meanFinite(makerTps.map((e) => (fin(e.makerFillLatencyTicks) ? e.makerFillLatencyTicks : NaN))),
    realizedRebateUsd: realized.reduce((a, e) => a + (Number.isFinite(e.rebateUsd) ? e.rebateUsd : 0), 0), // #2
    rebateRateUsed: cfg.makerRebateRate,
    meanObservedEntrySpread: meanFinite(realized.map((e) => e.observedEntrySpread)),
    meanObservedExitSpread: meanFinite(realized.map((e) => e.observedExitSpread)),
    nMarkets: panel.verdict.nMarkets, // #3 — the temporal extent the CI narrows over
    nCities: panel.verdict.nCities,
    nDistinctDays: panel.verdict.nDistinctDays,
    qualifyingTickFrac: panel.qualifyingTickFrac, // #4 — the reward-eligibility tick diagnostic
    nQualifyingRestingTicks: panel.nQualifyingRestingTicks,
    nRestingTicks: panel.nRestingTicks,
    meanDistFromMidPp: panel.meanDistFromMidPp, // #4b — the v2 "WHY zero" pool-context extension
    fracWithinAdvertisedBand: panel.fracWithinAdvertisedBand,
    fracFailsMinSize: panel.fracFailsMinSize,
    dominantDisqualifier: panel.dominantDisqualifier,
  };

  // ── gate progress: ALL counts + the label/reason come straight from the ONE openingVerdict over the realized
  //    ledger, so the displayed bars can never disagree with the verdict label. ──────────────────────────────
  const v = panel.verdict;
  const gate: MakerExitGate = {
    label: v.label,
    reason: v.reason,
    nMarkets: v.nMarkets,
    minMarkets: GATE.minMarkets,
    nCities: v.nCities,
    minCities: GATE.minCities,
    nDistinctDays: v.nDistinctDays,
    minDistinctDays: GATE.minDistinctDays,
    winFrac: v.winFrac,
    meanNetReturn: v.meanNetReturn,
    ciLow: v.ciLow,
    ciHigh: v.ciHigh,
    zeroSkillPassRate: v.zeroSkillPassRate,
  };

  return {
    days: 0, // set by the caller (the RPC window) — kept here for shape completeness
    cities: cfg.cities,
    tpDeltaPp: cfg.tpDeltaPp,
    slDeltaPp: cfg.slDeltaPp,
    tstopHoursBeforeResolve: cfg.tstopHoursBeforeResolve,
    makerRebateRate: cfg.makerRebateRate,
    nFreshEvents: considered.length,
    entries,
    perDay,
    money,
    assumptions,
    gate,
    cityErrors: 0, // pure default; the maker-exit-panel Edge handler overrides with the tick's real count
  };
}
