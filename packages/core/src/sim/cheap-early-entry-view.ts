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
 * THE PERSISTED LEDGER (2026-08-15, migration 0129). The replay above can only ever score the captures still in
 * the database, and on the Supabase free tier `opening_captures` is pruned at resolved+1 day (~18–30 MB/day is
 * not retainable). So the forward run's REALIZED entries are persisted per variant and folded back in here
 * (opts.ledger): every variant — the canonical one included, so the gate of record accrues too — is scored over
 * ledger ∪ replay, deduped by (city, targetDate) with the ledger row winning. Without opts.ledger the view is
 * byte-for-byte the pre-0129 replay-only build.
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
  summarizeCheapEarlyLedger,
  cheapEarlyVariantCfg,
  cheapEarlyWindowSet,
  CANONICAL_VARIANT_ID,
  CHEAP_EARLY_CITIES,
  CHEAP_EARLY_ENGINE_VERSION,
  CHEAP_EARLY_VARIANTS,
  type CheapEarlyBacktestRef,
  type CheapEarlyCfg,
  type CheapEarlyCityFilter,
  type CheapEarlyCityHitRates,
  type CheapEarlyEntryRule,
  type CheapEarlyPanel,
  type CheapEarlyTrade,
  type CheapEarlyVariant,
  type CheapEarlyWindow,
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
  /** the RUNNING forward mean net-return over realized trades (simple mean — finite from the first realized trade,
   *  so the headline read is populated from day one). Its city-clustered 95% CI (ciLow/ciHigh) is the GATE DRIVER
   *  (the backtest cells straddled 0) and stays NaN until the §9R-E sufficiency floor — see the gate for the
   *  rigorous clustered mean + CI. */
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

/** the verdict rendered per VARIANT. 'INSUFFICIENT' folds openingVerdict's INSUFFICIENT_DATA (and the
 *  mid-basis PASS_PENDING_REAL_BOOK, which this real-book loop never issues); 'DEAD' is the PRE-REGISTERED
 *  prune — n ≥ the §9R-E market floor with the city-clustered CI wholly below zero, i.e. measured-negative,
 *  not merely unproven. */
export type CheapEarlyVariantVerdict = 'PASS' | 'KILL' | 'INSUFFICIENT' | 'DEAD';

/** the variant's effective strategy params, surfaced so the page's table is self-describing. */
export interface CheapEarlyVariantCfgSummary {
  entryRule: CheapEarlyEntryRule;
  windowLoH: number;
  windowHiH: number;
  askBandLo: number;
  askBandHi: number;
  minEdge: number;
  /** the paper stake per entry — carried per variant so the ledger writer never has to assume a shared stake. */
  stakeUsd: number;
  cityFilter: CheapEarlyCityFilter;
  /** the cities the variant actually scored (top-K resolves to a subset; 'all' is the full allowlist). */
  scoredCities: string[];
}

/** one variant entry, compact — the page drills into a variant without carrying the full ledger six times.
 *  `won: null` marks an OPEN (ungraded) entry; a realized entry always carries a boolean — that is the flag the
 *  0129 ledger writer/seed reads to decide what is persistable. */
export interface CheapEarlyVariantEntry {
  city: string;
  date: string;
  label: string;
  ask: number;
  won: boolean | null;
  net: number;
  /** hours-to-close at entry + the pick's executable depth ($) — carried so the PERSISTED ledger (0129) keeps the
   *  diagnostics the pruned captures can no longer supply. null when the source row never had them. */
  htc: number | null;
  depth: number | null;
}

/** One REALIZED entry read back from `cheap_early_variant_ledger` (0129) — the forward record that survives the
 *  free-tier `opening_captures` prune (resolved+1d), so a variant's n accrues across ticks instead of spanning
 *  only whatever captures are still in the database. Every field but the key + net is optional: an old row (or a
 *  seed off a pre-0129 panel snapshot) simply carries less. */
export interface CheapEarlyLedgerRow {
  city: string;
  targetDate: string;
  label?: string | null;
  ask?: number | null;
  capturedAt?: string | null;
  hoursToClose?: number | null;
  depthUsd?: number | null;
  won?: boolean | null;
  /** the realized net return per $1 staked (the ledger's scoring unit — matches CheapEarlyTrade.netReturn). */
  net: number;
  stakeUsd?: number | null;
}

/** variantId → its persisted realized rows (the shape cheap_early_variant_ledger_read returns). */
export type CheapEarlyLedger = Record<string, CheapEarlyLedgerRow[]>;

/** One pre-registered variant scored side by side with the canonical rule (CHEAP-EARLY-IMPROVE.md §8). */
export interface CheapEarlyVariantBlock {
  id: string;
  label: string;
  cfg: CheapEarlyVariantCfgSummary;
  /** the offline real-book sweep cell this variant was pre-registered from — the "backtest vs forward" column. */
  backtestRef: CheapEarlyBacktestRef;
  /** the §9R-E gate over THIS variant's realized ledger (identical shape to the canonical gate; NEVER written
   *  to bot_gate_snapshot — a variant has no capital path). */
  gate: CheapEarlyGate;
  money: { realizedPnlUsd: number; roi: number; winRate: number };
  nExecuted: number;
  nRealized: number;
  meanNetReturn: number;
  meanEntryAsk: number;
  ciLow: number;
  ciHigh: number;
  nCities: number;
  nDays: number;
  verdict: CheapEarlyVariantVerdict;
  entries: CheapEarlyVariantEntry[];
  /** how the merged realized set was sourced: rows recovered from the persisted 0129 ledger vs rows this tick's
   *  replay produced itself. ledgerRows > 0 is the proof the record survived a capture prune. */
  ledgerRows: number;
  replayRows: number;
}

/** what every variant shares — the denominator they were all scored over + the entry-window SET pulled. */
export interface CheapEarlyVariantsCommon {
  nEventsConsidered: number;
  /** the DISJOINT windows the slim read shipped this tick (0128) — one slice per detached variant window. */
  windowSet: CheapEarlyWindow[];
  /** the engine tag the variants were scored under (an old snapshot can't be read as a current one). */
  engineVersion: string;
  /** false when a topK variant had no city hit rates this tick (it scores nothing — fail-closed). */
  cityHitRatesAvailable: boolean;
  /** true when the persisted 0129 variant ledger was readable this tick (false ⇒ the panel spans only the
   *  captures still in the database — on the free tier that is ~a day, not the accrued forward run). */
  ledgerAvailable: boolean;
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
  /** the pre-registered variant sweep (canonical first) — measurement only, no capital path. */
  variants: CheapEarlyVariantBlock[];
  variantsCommon: CheapEarlyVariantsCommon;
  /** per-city input-fetch errors on the Edge tick that produced this view (the handler overrides the 0 default). */
  cityErrors: number;
}

/** the §9R-E sufficiency bars — imported from the engine (single source of truth; openingVerdict enforces them). */
const GATE = { minMarkets: GATE_MIN_MARKETS, minCities: GATE_MIN_CITIES, minDistinctDays: GATE_MIN_DISTINCT_DAYS };

/** the §9R-E gate block for a replayed panel — one shape, used by the canonical view AND every variant, so a
 *  variant's bars can never disagree with its own verdict (or with how the canonical gate is rendered). */
function gateOf(panel: CheapEarlyPanel): CheapEarlyGate {
  const v = panel.verdict;
  return {
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
}

/** Map a §9R-E label to the variant verdict + apply the PRE-REGISTERED prune: DEAD when the panel has cleared
 *  the market floor AND its city-clustered CI is wholly negative (measured-negative, not merely unproven). */
function variantVerdict(gate: CheapEarlyGate): CheapEarlyVariantVerdict {
  if (gate.nMarkets >= GATE.minMarkets && Number.isFinite(gate.ciHigh) && gate.ciHigh < 0) return 'DEAD';
  if (gate.label === 'PASS') return 'PASS';
  if (gate.label === 'KILL') return 'KILL';
  return 'INSUFFICIENT';
}

/** the (city, targetDate) identity of a scored market — the ledger's primary key, and one market per city per
 *  day by construction (a city lists exactly one temperature event per target date). */
const marketKey = (city: string, targetDate: string): string => `${city} ${targetDate}`;

/** Turn one persisted ledger row into the engine's trade shape, so the merged set is a plain CheapEarlyTrade[]
 *  that every downstream reader (the money tracker, the entries table, the §9R-E verdict) already understands.
 *  Fields the ledger never carried (eventId, observedSpread, the winner temperature, the fee split) come back as
 *  ''/NaN/null — the means that read them filter non-finite values, so a recovered row simply does not vote on
 *  the cost reads it cannot answer. null when the row is unusable (no key, or no finite net). */
function ledgerTrade(row: CheapEarlyLedgerRow, fallbackStakeUsd: number): CheapEarlyTrade | null {
  const city = String(row?.city ?? '');
  const targetDate = String(row?.targetDate ?? '');
  const net = Number(row?.net);
  if (!city || !targetDate || !Number.isFinite(net)) return null;
  const stakeUsd = Number.isFinite(Number(row.stakeUsd)) ? Number(row.stakeUsd) : fallbackStakeUsd;
  const ask = Number.isFinite(Number(row.ask)) ? Number(row.ask) : NaN;
  return {
    eventId: '',
    city,
    targetDate,
    entered: true,
    reason: '',
    entryLabel: String(row.label ?? ''),
    entryTemp: null,
    htcAtEntry: Number.isFinite(Number(row.hoursToClose)) ? Number(row.hoursToClose) : null,
    entryAsk: ask,
    depthUsd: Number.isFinite(Number(row.depthUsd)) ? Number(row.depthUsd) : NaN,
    observedSpread: NaN,
    winnerTemp: null,
    won: row.won === true,
    status: 'realized',
    stakeUsd,
    feeUsd: 0,
    netPnlUsd: net * stakeUsd,
    netReturn: net,
  };
}

/** a variant's panel after the persisted ledger has been folded in, with the provenance split. */
interface MergedPanel {
  panel: CheapEarlyPanel;
  ledgerRows: number;
  replayRows: number;
}

/**
 * Merge a variant's PERSISTED realized rows (0129) into the panel this tick replayed, and re-score the result.
 *
 * Dedupe is by (city, targetDate) with the LEDGER row winning — it was graded when the captures still existed,
 * and a re-replay off a partially-pruned capture series is the weaker witness of the same market. Replay rows the
 * ledger has never seen are kept (that is how new markets enter the record); OPEN replay rows are kept untouched
 * unless the ledger already carries that market graded, which would otherwise double-count one market's stake.
 *
 * With no ledger rows this returns the replayed panel UNTOUCHED (same object) — the pre-0129 behaviour, exactly.
 */
function mergeVariantPanel(panel: CheapEarlyPanel, rows: CheapEarlyLedgerRow[] | undefined, cfg: CheapEarlyCfg): MergedPanel {
  const replayRealized = panel.ledger.filter((t) => t.status === 'realized').length;
  const recovered = (Array.isArray(rows) ? rows : [])
    .map((r) => ledgerTrade(r, cfg.stakeUsd))
    .filter((t): t is CheapEarlyTrade => t !== null);
  if (recovered.length === 0) return { panel, ledgerRows: 0, replayRows: replayRealized };
  const covered = new Set(recovered.map((t) => marketKey(t.city, t.targetDate)));
  const kept = panel.ledger.filter((t) => !covered.has(marketKey(t.city, t.targetDate)));
  const merged = [...recovered, ...kept].sort(
    (a, b) => (a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : a.city.localeCompare(b.city)),
  );
  return {
    panel: summarizeCheapEarlyLedger(merged, {
      nConsidered: panel.nConsidered,
      reasonTally: panel.reasonTally,
      scoredCities: panel.scoredCities,
    }),
    ledgerRows: recovered.length,
    replayRows: kept.filter((t) => t.status === 'realized').length,
  };
}

/** One variant block from an already-replayed (and ledger-merged) panel — the events are built ONCE and replayed
 *  per variant; the ingest, not the replay, is the expensive half. */
function variantBlockOf(
  variant: CheapEarlyVariant,
  cfg: CheapEarlyCfg,
  merged: MergedPanel,
  hitRatesMissing: boolean,
): CheapEarlyVariantBlock {
  const panel = merged.panel;
  const gate = gateOf(panel);
  const realized = panel.ledger.filter((t) => t.status === 'realized');
  const deployed = panel.ledger.reduce((a, t) => a + t.stakeUsd, 0);
  const realizedPnlUsd = realized.reduce((a, t) => a + t.netPnlUsd, 0);
  const entries: CheapEarlyVariantEntry[] = panel.ledger
    .map((t) => ({
      city: t.city,
      date: t.targetDate,
      label: t.entryLabel,
      ask: t.entryAsk,
      won: t.won,
      net: t.netReturn,
      htc: Number.isFinite(t.htcAtEntry as number) ? (t.htcAtEntry as number) : null,
      depth: Number.isFinite(t.depthUsd) ? t.depthUsd : null,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.city.localeCompare(b.city)));
  // a topK variant with no hit rates scored NOTHING (fail-closed) — say so, rather than reporting an empty
  // panel as if the rule simply never fired.
  const missing = hitRatesMissing && cfg.cityFilter.kind === 'topK';
  return {
    id: variant.id,
    label: variant.label,
    cfg: {
      entryRule: cfg.entryRule,
      windowLoH: cfg.windowLoH,
      windowHiH: cfg.windowHiH,
      askBandLo: cfg.askBandLo,
      askBandHi: cfg.askBandHi,
      minEdge: cfg.minEdge,
      stakeUsd: cfg.stakeUsd,
      cityFilter: cfg.cityFilter,
      scoredCities: panel.scoredCities,
    },
    backtestRef: variant.backtestRef,
    gate: missing ? { ...gate, reason: 'no city hit rates' } : gate,
    money: {
      realizedPnlUsd,
      roi: deployed > 0 ? panel.ledger.reduce((a, t) => a + t.netPnlUsd, 0) / deployed : 0,
      winRate: panel.winRate,
    },
    nExecuted: panel.nExecuted,
    nRealized: panel.nRealized,
    meanNetReturn: panel.meanNetReturn,
    meanEntryAsk: panel.meanEntryAsk,
    ciLow: gate.ciLow,
    ciHigh: gate.ciHigh,
    nCities: gate.nCities,
    nDays: gate.nDistinctDays,
    verdict: missing ? 'INSUFFICIENT' : variantVerdict(gate),
    entries,
    ledgerRows: merged.ledgerRows,
    replayRows: merged.replayRows,
  };
}

/** Optional inputs the Edge tick threads in (the pure default is "no hit rates, the frozen variant set"). */
export interface CheapEarlyViewOpts {
  /** per-city recent prediction hit rates (cheap_early_city_hit_rates, 0127) — the topK filter's input. Absent
   *  ⇒ every topK variant scores nothing and reads INSUFFICIENT / 'no city hit rates' (fail-closed). */
  cityHitRates?: CheapEarlyCityHitRates;
  /** the pre-registered variant set (a test seam — production always uses CHEAP_EARLY_VARIANTS). */
  variants?: readonly CheapEarlyVariant[];
  /** the PERSISTED realized entries per variant (cheap_early_variant_ledger_read, 0129). Absent ⇒ the view is
   *  exactly the pre-0129 replay-only build; present ⇒ every variant (canonical included, so the gate of record
   *  accrues too) is scored over ledger ∪ replay. This is what makes n survive the free-tier capture prune. */
  ledger?: CheapEarlyLedger;
}

/**
 * Build the /cheap-early view from the raw capture series + the resolution rows. cfg supplies the frozen
 * strategy params (cities allowlist, window, ask band, stake, fee). The hours-to-close clock (resolvesAt) comes
 * from the captures themselves — no external resolution join is needed to window.
 *
 * The events + resolution map are built ONCE and replayed per pre-registered variant; the CANONICAL variant is
 * the top-level entries/money/assumptions/gate (it reuses that very panel — the block and the headline can
 * never disagree).
 */
export function buildCheapEarlyView(
  captures: RawCaptureRow[],
  resolutions: RawResolution[],
  cfg: CheapEarlyCfg,
  opts: CheapEarlyViewOpts = {},
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

  const variantDefs = opts.variants ?? CHEAP_EARLY_VARIANTS;
  const hitRates = opts.cityHitRates;

  // the CANONICAL panel — the top-level entries/money/assumptions/gate, and the canonical variant's block. It is
  // MERGED with the persisted 0129 ledger before anything reads it, so the headline (and therefore the gate of
  // record) accrues across ticks instead of spanning only the captures that survived the free-tier prune.
  const replayed = replayCheapEarlyPanel(events, cfg, resolvesByEvent, {}, hitRates);
  const canonicalMerged = mergeVariantPanel(replayed, opts.ledger?.[CANONICAL_VARIANT_ID], cfg);
  const panel = canonicalMerged.panel;

  // ── per-event entries from the merged ledger (entered trades — replayed this tick or recovered from 0129) ──
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
  // the day axis is the UNION of "days we saw markets on" and "days we hold entries for": a day whose captures
  // have been pruned still owns its recovered entries (considered 0), so the equity curve keeps the accrued
  // history instead of silently dropping it. Without a ledger the entry days are a subset of the considered
  // days, so the union is the same set — the pre-0129 axis, unchanged.
  const perDay: CheapEarlyPerDay[] = [...new Set([...consideredByDay.keys(), ...dayAgg.keys()])].sort().map((date) => {
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
    // the RUNNING simple mean (finite from the first realized trade) — the headline read is useful from day one;
    // the rigorous city-clustered mean + CI live on the gate (v.*), which stay NaN until the sufficiency floor.
    meanNetReturn: panel.meanNetReturn,
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
  const gate: CheapEarlyGate = gateOf(panel);

  // ── the PRE-REGISTERED variant sweep (CHEAP-EARLY-IMPROVE.md §8) — the same events replayed under each
  //    variant's cfg delta. MEASUREMENT ONLY: these verdicts are rendered on /cheap-early and nowhere else;
  //    the gate of record (bot_gate_snapshot) is written from the CANONICAL block alone. ─────────────────
  const hitRatesMissing = hitRates == null;
  const variants: CheapEarlyVariantBlock[] = variantDefs.map((variant) => {
    const vcfg = cheapEarlyVariantCfg(cfg, variant);
    // the canonical variant IS the headline panel — replay (and merge) it once, never twice (and never
    // differently), so the block and the headline can still not disagree.
    const vmerged = variant.id === CANONICAL_VARIANT_ID && Object.keys(variant.over).length === 0
      ? canonicalMerged
      : mergeVariantPanel(replayCheapEarlyPanel(events, vcfg, resolvesByEvent, {}, hitRates), opts.ledger?.[variant.id], vcfg);
    return variantBlockOf(variant, vcfg, vmerged, hitRatesMissing);
  });
  const variantsCommon: CheapEarlyVariantsCommon = {
    nEventsConsidered: events.length,
    windowSet: cheapEarlyWindowSet(cfg, variantDefs),
    engineVersion: CHEAP_EARLY_ENGINE_VERSION,
    cityHitRatesAvailable: !hitRatesMissing,
    ledgerAvailable: opts.ledger != null,
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
    variants,
    variantsCommon,
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
