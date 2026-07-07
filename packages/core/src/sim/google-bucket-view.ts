/**
 * core/sim/google-bucket-view — the PURE dashboard view-model for the /convergence page (repurposed as the
 * GOOGLE-PICKS-BUCKET forward paper panel; the operator's "Test 2").
 *
 * The taker twin of opening-convergence-view: it turns the raw `opening_captures` series (+ the venue resolution
 * map + the latest per-event Google forecast) into the operator's forward read of a PURE Google-driven taker
 * strategy, by REUSING the tested google-bucket replay engine (one source of truth for "what would we do"):
 *
 *   1. logged potential ENTRIES — every fresh market whose Google-predicted bucket was buyable cheap
 *      (execAsk < askMax), with the taker fill and the canonical absolute take-profit EXIT (tpAbs 0.30, no SL,
 *      else hold-to-resolution) + net P&L. The ENTRY is held FIXED; a side-car block sweeps FIVE TP-only exit
 *      variants {0.30..0.50} over that same entry so the operator can read which exit is most favourable.
 *   2. per-day CHANCES — markets considered vs entered per station-local target day + the fire rate.
 *   3. a FICTIVE MONEY TRACKER — the fixed per-position stake per entry + the running paper P&L (equity curve).
 *   4. the §9R-E gate progress toward a verdict (≥40 markets / ≥6 cities / ≥7 days, clustered CI, zero-skill MC),
 *      straight from openingVerdict over the REALIZED taker ledger (in-flight mtm marks excluded).
 *   5. Google COVERAGE — how many fresh markets carried a Google forecast vs not (Google is a ~1-week forward
 *      seed; ~10 of 45 cities have NO Google feed yet — those markets simply don't trade, they never crash).
 *
 * NOTHING here is a live trade or a capital decision — it is the forward PAPER measurement made legible. Pure +
 * total: junk → empty sections, never throws. Imports only the engine + the shared raw mappers (buildEvents —
 * the SAME ingest the /convergence + /maker-exit views use, so the fresh universe cannot drift); no I/O.
 */
import {
  GATE_MIN_MARKETS,
  GATE_MIN_CITIES,
  GATE_MIN_DISTINCT_DAYS,
  openingVerdict,
  type OpeningLabel,
  type OpeningMarketResult,
} from './opening-convergence.ts';
import { buildEvents, type RawCaptureRow, type Resolution } from './opening-bracket-ingest.ts';
import type { RawResolution } from './opening-convergence-view.ts';
import { cToF } from '../units.ts';
import type { Unit } from '../types.ts';
import { googleBucketIdx, replayGoogleBracket, type GoogleBracketCfg } from './google-bucket-replay.ts';

/** One per-event Google forecast row the google_paper_inputs RPC returns (latest google source_forecasts row). */
export interface RawGooglePrediction {
  eventId: string;
  /** the latest Google daily-max forecast for the event's icao+target_date (°C); null = no Google feed for it. */
  tmaxC: number | null;
  /** the city's native unit ('C' | 'F') — Google is °C, an °F city converts before bucketing. */
  unit: string | null;
  /** the city's IANA tz (carried for parity; the Google strategy has no time-stop, so it is display-only). */
  tz: string | null;
}

export type GoogleExitKind =
  | 'take_profit'
  | 'stop_loss'
  | 'resolution_win'
  | 'resolution_lose'
  | 'open_marked';

/** One logged potential entry (a Google-bucket taker trade made legible). */
export interface GoogleEntry {
  eventId: string;
  city: string;
  targetDate: string;
  /** the Google daily-max forecast (°C) that picked the bucket. */
  googleTmaxC: number;
  /** the whole-degree native call (floor of the native-unit forecast) — the bucket we bought. */
  predictedNative: number;
  /** the Google-predicted bucket label we bought. */
  entryLabel: string;
  entryAgeH: number | null;
  entryPrice: number;
  stakeUsd: number;
  exitKind: GoogleExitKind;
  exitReason: string;
  exitPrice: number;
  netPnlUsd: number;
  netReturn: number;
  /** realized = a fired bracket or a settled resolution; open = still marked-to-bid (unresolved). */
  status: 'realized' | 'open';
}

/** One station-local target day: how many markets we considered vs entered, and that day's paper P&L. */
export interface GooglePerDay {
  date: string;
  considered: number;
  entered: number;
  firePct: number;
  stakeUsd: number;
  netPnlUsd: number;
}

/** The fictive money tracker — the fixed stake per entry + the running paper P&L. */
export interface GoogleMoney {
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

/** The §9R-E gate progress toward a verdict — straight from openingVerdict over the realized taker ledger. */
export interface GoogleGate {
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

/**
 * One take-profit exit variant in the side-by-side comparison. The ENTRY is held FIXED across all variants
 * (buy execAsk < askMax, no SL); only the TP level moves — so the entered population (nTrades) is IDENTICAL
 * across variants by construction, and only the exit mix (nTpHit vs nHeldToResolution) + P&L differ.
 */
export interface GoogleTpVariant {
  /** the take-profit level for this variant (execBid ≥ tpAbs sells). */
  tpAbs: number;
  /** executed trades — identical across all variants (entry depends only on askMax). */
  nTrades: number;
  /** of those, how many exited via take-profit (monotone non-increasing as tpAbs rises — harder to reach). */
  nTpHit: number;
  /** how many instead settled at resolution (win or lose) — the hold-to-resolution floor (no SL). */
  nHeldToResolution: number;
  /** total net paper P&L across all trades (realized + open marks). */
  netPnlUsd: number;
  /** net paper P&L over REALIZED (non-open) trades only — the gate-comparable figure. */
  realizedPnlUsd: number;
  /** mean net return across executed trades. */
  meanNetReturn: number;
  /** realized wins / realized count. */
  winRate: number;
}

/** The exit-variant comparison block: five TP-only variants over the SAME fixed entry population. */
export interface GoogleTpComparison {
  /** entered markets — IDENTICAL for every variant by construction (surfaced so the page can assert it). */
  nEntered: number;
  /** one entry per TP level, ascending (0.30 → 0.50); 0.30 is the canonical/headline variant. */
  variants: GoogleTpVariant[];
}

export interface GoogleView {
  days: number;
  cities: string[];
  /** the live thresholds this view replayed (surfaced so the page shows the config). */
  askMin: number;
  askMax: number;
  tpAbs: number;
  slAbs: number;
  /** °C-only mode: when true, US °F markets were excluded from the strategy (see nExcludedFahrenheit). */
  excludeFahrenheit: boolean;
  /** max entry age in hours since listing (buy window closes this long after the market opens; 0 = disabled). */
  maxEntryAgeH: number;
  perEntryStakeUsd: number;
  /** fresh markets considered in the window (the entry-rule denominator, gm-excluded). */
  nFreshEvents: number;
  /** of those, how many carried a bucketable Google forecast (the ones the strategy could even act on). */
  nGoogleEvents: number;
  /** fresh markets with NO Google forecast (Google is a ~1-week forward seed; ~10/45 cities have no feed). */
  nNoGoogleEvents: number;
  /** °F markets that HAD a Google forecast but were skipped by the °C-only filter (0 when excludeFahrenheit is off). */
  nExcludedFahrenheit: number;
  /** the cities whose fresh markets lacked a Google forecast this window (rendered "no Google data"). */
  citiesNoGoogle: string[];
  entries: GoogleEntry[];
  perDay: GooglePerDay[];
  money: GoogleMoney;
  gate: GoogleGate;
  /** the five-TP-variant exit comparison over the SAME fixed entry (the operator wants the most-favourable exit). */
  tpComparison: GoogleTpComparison;
  /** per-city input-fetch errors on the Edge tick that produced this view (the handler overrides the 0 default). */
  cityErrors: number;
}

/**
 * The five take-profit exit levels the panel sweeps side-by-side over the SAME fixed entry (execAsk < askMax,
 * no SL). 0.30 is the canonical/headline variant that drives the single-config entries/money/per-day/gate.
 */
export const GOOGLE_TP_VARIANTS = [0.3, 0.35, 0.4, 0.45, 0.5] as const;
/** index of the canonical (headline) variant within GOOGLE_TP_VARIANTS — tpAbs 0.30. */
const CANONICAL_TP_IDX = 0;

/** the §9R-E sufficiency bars — imported from the engine (single source of truth; openingVerdict enforces them). */
const GATE = { minMarkets: GATE_MIN_MARKETS, minCities: GATE_MIN_CITIES, minDistinctDays: GATE_MIN_DISTINCT_DAYS };

function exitKindOf(reason: string): GoogleExitKind {
  if (reason.startsWith('take_profit')) return 'take_profit';
  if (reason.startsWith('stop_loss')) return 'stop_loss';
  if (reason === 'resolution_settle:win') return 'resolution_win';
  if (reason === 'resolution_settle:lose') return 'resolution_lose';
  return 'open_marked'; // mtm_unresolved / mtm_grading_mismatch
}

/**
 * Build the /convergence (Google-picks-bucket) view from the raw capture series + resolution rows + the
 * per-event Google forecasts. cfg supplies the thresholds (askMax/tpAbs/slAbs), the stake, and the cities scope
 * (GOOGLE_DEFAULTS pinned with the run's capture universe). The days field is set by the caller (the RPC window).
 */
export function buildGoogleView(
  captures: RawCaptureRow[],
  resolutions: RawResolution[],
  google: RawGooglePrediction[],
  cfg: GoogleBracketCfg,
): GoogleView {
  const caps = Array.isArray(captures) ? captures : [];
  const resMap = new Map<string, Resolution>(
    (Array.isArray(resolutions) ? resolutions : []).map((r) => [
      String(r.id),
      { winnerIdx: r.winnerIdx ?? null, gradingMismatch: r.gradingMismatch === true },
    ]),
  );
  const events = buildEvents(caps, resMap);

  // resolvesAt per event (constant per event; first non-null among its captures) — the purchase-window anchor
  // for replayGoogleBracket's [opening, resolvesAt − minHoursToResolution] entry gate. buildEvents drops it.
  const resolvesAtByEvent = new Map<string, string>();
  for (const r of caps) {
    if (r?.eventId == null || r.resolvesAt == null) continue;
    const key = String(r.eventId);
    if (!resolvesAtByEvent.has(key)) resolvesAtByEvent.set(key, String(r.resolvesAt));
  }

  // googleByEvent (eventId → the latest Google forecast + the city's native unit). tmaxC null ⇒ no feed.
  const googleByEvent = new Map<string, { tmaxC: number | null; unit: Unit }>();
  for (const g of Array.isArray(google) ? google : []) {
    if (!g || g.eventId == null) continue;
    const unit: Unit = g.unit === 'F' ? 'F' : 'C';
    const tmaxC = g.tmaxC != null && Number.isFinite(Number(g.tmaxC)) ? Number(g.tmaxC) : null;
    googleByEvent.set(String(g.eventId), { tmaxC, unit });
  }

  // grading_mismatch markets (ambiguous payout) are EXCLUDED from scoring — so the entries / per-day / money /
  // gate counts all derive from the SAME gm-excluded population (one source of truth, matching the taker views).
  const considered = events.filter((e) => !e.resolution.gradingMismatch);

  const entries: GoogleEntry[] = [];
  const panelRows: OpeningMarketResult[] = []; // REALIZED (non-mtm) trades — the §9R-E gate basis
  const citiesNoGoogle = new Set<string>();
  let nGoogleEvents = 0;
  let nNoGoogleEvents = 0;
  let nExcludedFahrenheit = 0;

  // per-TP-variant accumulators (same order as GOOGLE_TP_VARIANTS). The ENTRY is fixed across variants, so the
  // executed set — and thus nTrades — is identical; only the exit mix + P&L differ. realized-vs-open split is
  // kept so realizedPnlUsd / winRate mirror the gate's "closed net profit only" convention.
  const variantAcc = GOOGLE_TP_VARIANTS.map((tpAbs) => ({
    tpAbs,
    nTrades: 0,
    nTpHit: 0,
    nHeldToResolution: 0,
    netPnlUsd: 0,
    realizedPnlUsd: 0,
    sumReturn: 0,
    nRealized: 0,
    nWins: 0,
  }));

  for (const e of considered) {
    const g = googleByEvent.get(e.eventId);
    if (!g || g.tmaxC == null) {
      // no Google feed for this market — it simply cannot be a Google-bucket trade (never a crash).
      nNoGoogleEvents++;
      citiesNoGoogle.add(e.city);
      continue;
    }
    if (cfg.excludeFahrenheit && g.unit === 'F') {
      // °C-only mode (operator-set): US °F markets went 0/6 in the forward sweep (floor-vs-rounding bucket-mapping
      // suspect). Excluded from the strategy — counted here for transparency, never entered/scored.
      nExcludedFahrenheit++;
      continue;
    }
    // the ladder labels are constant per event; use the first tick that carries buckets.
    const ladder = e.ticks.find((t) => Array.isArray(t.buckets) && t.buckets.length > 0)?.buckets ?? [];
    const predIdx = googleBucketIdx(ladder, g.tmaxC, g.unit);
    if (predIdx == null) continue; // Google present but its forecast couldn't be bucketed (junk ladder)
    nGoogleEvents++;

    // replay the SAME fixed entry (execAsk < askMax, SL disabled) against every TP-only exit variant. The entry
    // is TP-independent, so the executed population is identical across variants by construction.
    const resolvesAt = resolvesAtByEvent.get(e.eventId) ?? null;
    const variantTrades = GOOGLE_TP_VARIANTS.map((tpAbs) =>
      replayGoogleBracket(e, predIdx, { ...cfg, tpAbs, slAbs: 0 }, resolvesAt),
    );

    // fold each executed variant into its accumulator (exit mix: TP-hit vs held-to-resolution vs open-marked).
    for (let vi = 0; vi < GOOGLE_TP_VARIANTS.length; vi++) {
      const vt = variantTrades[vi]!;
      if (!vt.executed || !Number.isFinite(vt.netPnlUsd) || !Number.isFinite(vt.netReturn)) continue;
      const acc = variantAcc[vi]!;
      const vk = exitKindOf(vt.exitReason);
      acc.nTrades++;
      acc.sumReturn += vt.netReturn;
      acc.netPnlUsd += vt.netPnlUsd;
      if (vk === 'take_profit') acc.nTpHit++;
      if (vk === 'resolution_win' || vk === 'resolution_lose') acc.nHeldToResolution++;
      if (vk !== 'open_marked') {
        acc.nRealized++;
        acc.realizedPnlUsd += vt.netPnlUsd;
        if (vt.netPnlUsd > 0) acc.nWins++;
      }
    }

    // the CANONICAL (tpAbs 0.30) variant drives the existing single-config sections (entries/money/per-day/gate).
    const t = variantTrades[CANONICAL_TP_IDX]!;
    if (!t.executed || !Number.isFinite(t.netPnlUsd) || !Number.isFinite(t.netReturn)) continue;
    const kind = exitKindOf(t.exitReason);
    const native = g.unit === 'F' ? cToF(g.tmaxC) : g.tmaxC;
    entries.push({
      eventId: e.eventId,
      city: e.city,
      targetDate: e.targetDate,
      googleTmaxC: g.tmaxC,
      predictedNative: Math.floor(native),
      entryLabel: t.entryLabel,
      entryAgeH: t.entryAgeH,
      entryPrice: t.entryPrice,
      stakeUsd: t.stakeUsd,
      exitKind: kind,
      exitReason: t.exitReason,
      exitPrice: t.exitPrice,
      netPnlUsd: t.netPnlUsd,
      netReturn: t.netReturn,
      status: kind === 'open_marked' ? 'open' : 'realized',
    });
    // in-flight (mtm) marks are ENTERED but NOT scored by the gate (it certifies CLOSED net profit only).
    if (!t.exitReason.includes('mtm_')) {
      panelRows.push({
        city: e.city,
        targetDate: e.targetDate,
        netPnlUsd: t.netPnlUsd,
        stakeUsd: t.stakeUsd,
        netReturn: t.netReturn,
        executed: true,
      });
    }
  }

  // ── the five-TP-variant exit comparison (same fixed entry population; only the TP level moves) ─────────────
  const tpComparison: GoogleTpComparison = {
    nEntered: entries.length,
    variants: variantAcc.map((a) => ({
      tpAbs: a.tpAbs,
      nTrades: a.nTrades,
      nTpHit: a.nTpHit,
      nHeldToResolution: a.nHeldToResolution,
      netPnlUsd: a.netPnlUsd,
      realizedPnlUsd: a.realizedPnlUsd,
      meanNetReturn: a.nTrades > 0 ? a.sumReturn / a.nTrades : 0,
      winRate: a.nRealized > 0 ? a.nWins / a.nRealized : 0,
    })),
  };
  entries.sort((a, b) => (a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : a.city.localeCompare(b.city)));

  // ── per-day chances: considered (gm-excluded fresh events) vs entered, per target day ─────────────────
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
  const perDay: GooglePerDay[] = [...consideredByDay.keys()].sort().map((date) => {
    const consideredN = consideredByDay.get(date) ?? 0;
    const d = dayAgg.get(date) ?? { entered: 0, stake: 0, net: 0 };
    return {
      date,
      considered: consideredN,
      entered: d.entered,
      firePct: consideredN > 0 ? d.entered / consideredN : 0,
      stakeUsd: d.stake,
      netPnlUsd: d.net,
    };
  });

  // ── fictive money tracker: Σ over entries + the cumulative equity curve over target days ──────────────
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
  const money: GoogleMoney = {
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

  // ── gate progress: openingVerdict over the realized taker ledger; the bars come from the SAME verdict ──
  const v = openingVerdict(panelRows);
  const gate: GoogleGate = {
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
    askMin: cfg.askMin,
    askMax: cfg.askMax,
    tpAbs: cfg.tpAbs,
    slAbs: cfg.slAbs,
    excludeFahrenheit: cfg.excludeFahrenheit,
    maxEntryAgeH: cfg.maxEntryAgeH,
    perEntryStakeUsd: cfg.perPositionUsd,
    nFreshEvents: considered.length,
    nGoogleEvents,
    nNoGoogleEvents,
    nExcludedFahrenheit,
    citiesNoGoogle: [...citiesNoGoogle].sort(),
    entries,
    perDay,
    money,
    gate,
    tpComparison,
    cityErrors: 0, // pure default; the google-paper-panel Edge handler overrides with the tick's real count
  };
}
