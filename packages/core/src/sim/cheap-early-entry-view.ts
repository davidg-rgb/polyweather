/**
 * core/sim/cheap-early-entry-view — the PURE dashboard view-model for the /cheap-early forward-paper page.
 *
 * The cheap-early twin of opening-maker-exit-view: it turns the raw `opening_captures` series (+ the venue
 * resolution map) into the operator's forward read of the CHEAP-EARLY-ENTRY strategy (CHEAP-EARLY-ENTRY.md), by
 * REUSING the tested cheap-early replay engine (one source of truth for "what would we do"):
 *
 *   1. logged potential ENTRIES — every fresh-allowlist market the rule entered (the [24,36]h house-pick at a
 *      0.20–0.33 ask), held to resolution, won/lost + net P&L.
 *   2. per-day CHANCES — markets considered vs entered per station-local target day + the fire rate.
 *   3. a FICTIVE MONEY TRACKER — the fixed stake per entry + the running paper P&L (equity curve).
 *   4. the MEASURED READS the ~1-month backtest could not settle (CHEAP-EARLY-ENTRY.md §4/§5): the forward
 *      mean net-return + its city-clustered CI (the gate driver), the win rate (informational — a ≥3× bet wins
 *      < 50% and is still +EV), and the cost/capacity confirmation (spread + depth are NOT the wall — §3).
 *   5. the §9R-E gate progress toward a verdict (≥40 markets / ≥6 cities / ≥7 days; binds on ciLow>0 +
 *      zero-skill MC, NOT winFrac — handoff §2).
 *
 * NOTHING here is a live trade or a capital decision — it is the forward PAPER measurement made legible; the
 * §9R-E gate governs any GO (which additionally needs ≥2 non-overlapping PASSes + an explicit operator step —
 * never this build). Pure + total: junk → empty sections, never throws. Imports only the engine + the shared raw
 * mappers (buildEvents — the SAME ingest the /convergence + /maker-exit views use, so the universes cannot
 * drift); no I/O.
 */
import { GATE_MIN_MARKETS, GATE_MIN_CITIES, GATE_MIN_DISTINCT_DAYS } from './opening-convergence.ts';
import type { OpeningLabel } from './opening-convergence.ts';
import { buildEvents, type RawCaptureRow, type Resolution } from './opening-bracket-ingest.ts';
import type { RawResolution } from './opening-convergence-view.ts';
import {
  replayCheapEarlyPanel,
  CHEAP_EARLY_CITIES,
  type CheapEarlyCfg,
  type CheapEarlyTrade,
} from './cheap-early-entry-replay.ts';

/** One logged potential entry (a cheap-early trade made legible). */
export interface CheapEarlyEntry {
  eventId: string;
  city: string;
  targetDate: string;
  /** the house-pick bucket label bought — our predicted-Tmax bucket / the temperature the bet opened on. */
  entryLabel: string;
  /** hours-to-close at the entry tick (the "latest allowable" point in [24,36]h). */
  htcAtEntry: number | null;
  entryAsk: number;
  depthUsd: number;
  observedSpread: number;
  stakeUsd: number;
  /** the winning bucket's temperature (parsed from its label) — for the ledger's win/lose column. */
  winnerTemp: number | null;
  won: boolean | null;
  netPnlUsd: number;
  netReturn: number;
  /** realized = graded at resolution; open = still pending (marked-to-bid, excluded from the gate). */
  status: 'realized' | 'open';
}

/** One station-local target day: markets considered vs entered, the fire rate, and that day's paper P&L. */
export interface CheapEarlyPerDay {
  date: string;
  considered: number;
  entered: number;
  firePct: number;
  stakeUsd: number;
  netPnlUsd: number;
}

/** The fictive money tracker — the fixed stake per entry + the running paper P&L. */
export interface CheapEarlyMoney {
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

/** The measured reads the ~1-month backtest could not settle (CHEAP-EARLY-ENTRY.md §4/§5). */
export interface CheapEarlyAssumptions {
  /** the forward mean net-return + its city-clustered 95% CI — the GATE DRIVER (the backtest cells straddled 0). */
  meanNetReturn: number;
  ciLow: number;
  ciHigh: number;
  /** the bucket-hit rate (informational — NOT the gate bar; a ≥3× bet wins < 50% and is still +EV). */
  winRate: number;
  /** cost + capacity — confirms CHEAP-EARLY-ENTRY.md §3 forward: tight spread, ample house-pick depth. */
  meanEntryAsk: number;
  meanObservedSpread: number;
  meanDepthUsd: number;
  /** temporal extent accrued (the CI narrows as these grow): realized markets, cities, distinct target days. */
  nMarkets: number;
  nCities: number;
  nDistinctDays: number;
  /** fire rate over the window (entered / considered) + entries-per-distinct-day (the powering rate). */
  firePct: number;
  entriesPerDay: number;
  /** why the considered markets that did NOT enter were dropped (band / depth / no-window / gm). */
  reasonTally: Record<string, number>;
}

/** The §9R-E gate progress — straight from openingVerdict over the realized cheap-early ledger (minWinFrac 0). */
export interface CheapEarlyGate {
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

export interface CheapEarlyView {
  days: number;
  cities: string[];
  /** the frozen strategy params this view replayed (handoff §0) — surfaced so the page shows the live config. */
  windowLoH: number;
  windowHiH: number;
  askBandLo: number;
  askBandHi: number;
  stakeUsd: number;
  /** fresh-allowlist markets considered in the window (the entry-rule denominator, gm-excluded from scoring). */
  nConsidered: number;
  entries: CheapEarlyEntry[];
  perDay: CheapEarlyPerDay[];
  money: CheapEarlyMoney;
  assumptions: CheapEarlyAssumptions;
  gate: CheapEarlyGate;
  /** per-city input-fetch errors on the Edge tick that produced this view (the handler overrides the 0 default). */
  cityErrors: number;
}

/** the §9R-E sufficiency bars — imported from the engine (single source of truth; openingVerdict enforces them). */
const GATE = { minMarkets: GATE_MIN_MARKETS, minCities: GATE_MIN_CITIES, minDistinctDays: GATE_MIN_DISTINCT_DAYS };

/**
 * Build the /cheap-early view from the raw capture series + the resolution rows. cfg supplies the frozen
 * strategy params (cities allowlist, window, ask band, stake, fee). The hours-to-close clock (resolvesAt) comes
 * from the captures themselves — no external resolution join is needed to window.
 */
export function buildCheapEarlyView(
  captures: RawCaptureRow[],
  resolutions: RawResolution[],
  cfg: CheapEarlyCfg,
): CheapEarlyView {
  const caps = Array.isArray(captures) ? captures : [];
  const resMap = new Map<string, Resolution>(
    (Array.isArray(resolutions) ? resolutions : []).map((r) => [
      String(r.id),
      { winnerIdx: r.winnerIdx ?? null, gradingMismatch: r.gradingMismatch === true },
    ]),
  );
  const events = buildEvents(caps, resMap);

  // resolvesByEvent (eventId → the venue resolution epoch ms — the hours-to-close anchor) from the raw captures;
  // first finite resolvesAt per event wins (it is constant per event — the Gamma endDate).
  const resolvesByEvent = new Map<string, number | null>();
  for (const c of caps) {
    if (!c.eventId || resolvesByEvent.has(c.eventId)) continue;
    const ms = c.resolvesAt ? Date.parse(c.resolvesAt) : NaN;
    resolvesByEvent.set(c.eventId, Number.isFinite(ms) ? ms : null);
  }

  const panel = replayCheapEarlyPanel(events, cfg, resolvesByEvent);

  // ── per-event entries from the replayed ledger (entered trades) ───────────────────────────────────────
  const entries: CheapEarlyEntry[] = panel.ledger
    .filter((t: CheapEarlyTrade) => t.entered && Number.isFinite(t.netPnlUsd) && Number.isFinite(t.netReturn))
    .map((t: CheapEarlyTrade) => ({
      eventId: t.eventId,
      city: t.city,
      targetDate: t.targetDate,
      entryLabel: t.entryLabel,
      htcAtEntry: t.htcAtEntry,
      entryAsk: t.entryAsk,
      depthUsd: t.depthUsd,
      observedSpread: t.observedSpread,
      stakeUsd: t.stakeUsd,
      winnerTemp: t.winnerTemp,
      won: t.won,
      netPnlUsd: t.netPnlUsd,
      netReturn: t.netReturn,
      status: t.status,
    }));
  entries.sort((a, b) => (a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : a.city.localeCompare(b.city)));

  // ── per-day chances: considered (fresh, in-universe, gm-excluded from scoring) vs entered, per target day ──
  const considered = events.filter((e) => cfg.cities.includes(e.city) && !e.resolution.gradingMismatch);
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
  const perDay: CheapEarlyPerDay[] = [...consideredByDay.keys()].sort().map((date) => {
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
  const money: CheapEarlyMoney = {
    perEntryStakeUsd: cfg.stakeUsd,
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

  // ── the measured reads (CHEAP-EARLY-ENTRY.md §4/§5) — over the REALIZED ledger + the gate verdict ──────
  const v = panel.verdict;
  const assumptions: CheapEarlyAssumptions = {
    meanNetReturn: v.meanNetReturn,
    ciLow: v.ciLow,
    ciHigh: v.ciHigh,
    winRate: panel.winRate,
    meanEntryAsk: panel.meanEntryAsk,
    meanObservedSpread: panel.meanObservedSpread,
    meanDepthUsd: panel.meanDepthUsd,
    nMarkets: v.nMarkets,
    nCities: v.nCities,
    nDistinctDays: v.nDistinctDays,
    firePct: panel.nConsidered > 0 ? panel.nExecuted / panel.nConsidered : 0,
    entriesPerDay: perDay.length > 0 ? entries.length / perDay.length : 0,
    reasonTally: panel.reasonTally,
  };

  // ── gate progress: ALL counts + the label/reason come straight from the ONE openingVerdict, so the displayed
  //    bars can never disagree with the verdict label. ─────────────────────────────────────────────────────
  const gate: CheapEarlyGate = {
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
    windowLoH: cfg.windowLoH,
    windowHiH: cfg.windowHiH,
    askBandLo: cfg.askBandLo,
    askBandHi: cfg.askBandHi,
    stakeUsd: cfg.stakeUsd,
    nConsidered: considered.length,
    entries,
    perDay,
    money,
    assumptions,
    gate,
    cityErrors: 0, // pure default; the cheap-early-panel Edge handler overrides with the tick's real count
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Config — the one operator-tunable knob (the city widening) + the enabled pause gate
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The cheap-early operational config the Edge tick reads (the frozen strategy params stay pinned in CODE —
 *  CHEAP_EARLY_DEFAULTS — so the loop never mutates the shared bot.* keys; only the city list + the pause are
 *  live-tunable). */
export interface CheapEarlyConfig {
  cities: string[];
  enabled: boolean;
}

/** Parse the flat `config` rows into the cheap-early operational config. `cheap_early.cities` accepts a JSON
 *  array OR a comma-separated list (empty/absent ⇒ the frozen 4 live cities); `cheap_early.enabled` accepts
 *  1/0/true/false (absent ⇒ true). Pure + total (bad JSON / bad values fall back to the default). */
export function parseCheapEarlyConfig(rows: { key: string; value: string | null }[]): CheapEarlyConfig {
  const map = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.key, r.value]));
  const rawCities = map.get('cheap_early.cities');
  let cities: string[] = [...CHEAP_EARLY_CITIES];
  if (rawCities != null && String(rawCities).trim() !== '') {
    const s = String(rawCities).trim();
    let parsed: string[] | null = null;
    if (s.startsWith('[')) {
      try {
        const j = JSON.parse(s);
        if (Array.isArray(j)) parsed = j.map((x) => String(x).trim()).filter((x) => x.length > 0);
      } catch {
        parsed = null;
      }
    } else {
      parsed = s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
    }
    if (parsed && parsed.length > 0) cities = parsed;
  }
  const rawEnabled = map.get('cheap_early.enabled');
  const enabled = rawEnabled == null || rawEnabled === '' ? true : /^(1|true|yes|on)$/i.test(String(rawEnabled).trim());
  return { cities, enabled };
}
