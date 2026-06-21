/**
 * RSC data loaders (§6.21) — one 0022 dash_* RPC round trip per page, plus
 * the derived view-models the pages need (exposure summary via core,
 * EdgeChart display recompute, goLiveGate readout). Framework-free: every
 * loader takes the WebDb port, so the PGlite suite drives the REAL loaders;
 * pages bind serverDb() from supabase.ts.
 */
import {
  AMSTERDAM_CLIMATOLOGY,
  armEdgeStats,
  armTruthStats,
  exposureSummary,
  parseConfigRows,
  peakHourWindow,
  recommendBestTime,
} from '@weather-edge/core';
import type { AppConfig, BestTimeView, EdgeRow } from '@weather-edge/core';
import { goLiveGate, type GateDeps } from '@weather-edge/trading';
import { compareEdgeRows, recomputeEdgeRows } from './edge-display.ts';
import type { EdgeComparison, EventDetailForEdges, LadderRowPayload, StoredEdgeEval } from './edge-display.ts';
import type { WebDb } from './api/deps.ts';

async function one<T>(db: WebDb, fn: string, args: Record<string, unknown> = {}): Promise<T | null> {
  const [row] = await db.rpc<Record<string, T>>(fn, args);
  return row?.[fn] ?? null;
}

async function loadConfig(db: WebDb): Promise<AppConfig> {
  return parseConfigRows(await db.getConfigRows());
}

// --- / (today overview) --------------------------------------------------------

export interface OpenRec {
  betId: string;
  eventSlug: string;
  city: string;
  label: string;
  q: unknown;
  execAsk: unknown;
  edge: unknown;
  minEdge: unknown;
  kellyRaw: unknown;
  kellyFrac: unknown;
  cappedFrac: unknown;
  stake: unknown;
  shares: unknown;
  mode: string;
  recommendedAt: string;
  audit: Record<string, unknown>;
}

export interface ExposureSlice {
  key: string;
  usd: number;
}

export interface TodayOverview {
  bankroll: number;
  mode: string;
  championSource: string;
  openRecs: OpenRec[];
  pnlSeries: { at: string; balance: unknown }[];
  breakerStates: { key: string; value: string }[];
  jobHealth: { job: string; lastOk: string | null; running: string | null }[];
  exposures: {
    byEvent: ExposureSlice[];
    byCluster: ExposureSlice[];
    byDay: ExposureSlice[];
  };
  caps: {
    perEventCapUsd: number;
    clusterCapUsd: number;
    dailyCapUsd: number;
  };
}

interface TodayOverviewPayload {
  bankroll: unknown;
  openRecs: OpenRec[];
  openBets: { eventId: string; citySlug: string; cluster: string; stakeUsd: unknown; targetDate: string }[];
  pnlSeries: { at: string; balance: unknown }[];
  breakerStates: { key: string; value: string }[];
  jobHealth: { job: string; lastOk: string | null; running: string | null }[];
}

export async function getTodayOverview(db: WebDb): Promise<TodayOverview> {
  const cfg = await loadConfig(db);
  const v = await one<TodayOverviewPayload>(db, 'dash_today_overview', {
    p_mode: cfg.tradingMode,
    p_champion: cfg.championSource,
  });
  if (!v) throw new Error('dash_today_overview returned nothing');
  const bankroll = Number(v.bankroll);
  const summary = exposureSummary(
    v.openBets.map((b) => ({
      eventId: b.eventId,
      citySlug: b.citySlug,
      cluster: b.cluster,
      stakeUsd: Number(b.stakeUsd),
      targetDate: String(b.targetDate).slice(0, 10),
    })),
    bankroll,
  );
  const slices = (m: Map<string, number>): ExposureSlice[] =>
    [...m.entries()].map(([key, usd]) => ({ key, usd })).sort((a, b) => b.usd - a.usd);
  return {
    bankroll,
    mode: cfg.tradingMode,
    championSource: cfg.championSource,
    openRecs: v.openRecs,
    pnlSeries: v.pnlSeries,
    breakerStates: v.breakerStates,
    jobHealth: v.jobHealth,
    exposures: {
      byEvent: slices(summary.byEvent),
      byCluster: slices(summary.byCluster),
      byDay: slices(summary.byDay),
    },
    caps: {
      perEventCapUsd: bankroll * cfg.perEventCapPct,
      clusterCapUsd: bankroll * cfg.clusterCapPct,
      dailyCapUsd: bankroll * cfg.dailyCapPct,
    },
  };
}

// --- /events (collection-health index, WEB-2) ------------------------------------

export interface EventListRow {
  slug: string;
  city: string;
  citySlug: string;
  targetDate: string;
  acceptingOrders: boolean;
  ladderOk: boolean;
  /** jsonb-string-safe numerics (file convention, cf. OpenRec.q) — page coerces with num(). */
  nBuckets: unknown;
  lastSnapshotAt: string | null;
  lastConsensusAt: string | null;
  hasHouse: boolean;
  volume24h: unknown;
}

export interface EventsListView {
  events: EventListRow[];
  champion: string;
  counts: {
    open: unknown;
    withSnapshot: unknown;
    withConsensus: unknown;
    withHouse: unknown;
    withLadder: unknown;
  };
}

const EMPTY_EVENTS_COUNTS = {
  open: 0,
  withSnapshot: 0,
  withConsensus: 0,
  withHouse: 0,
  withLadder: 0,
} as const;

/**
 * Load the open-events collection-health table for the /events landing
 * (dash_events_list, 0029). Mirrors getCalibrationView's null-tolerant default
 * (events=[]) so a fresh/empty DB renders the empty state, not a throw.
 */
export async function getEventsList(db: WebDb): Promise<EventsListView> {
  const cfg = await loadConfig(db);
  const v = await one<EventsListView>(db, 'dash_events_list', { p_champion: cfg.championSource });
  return {
    events: v?.events ?? [],
    champion: v?.champion ?? cfg.championSource,
    counts: v?.counts ?? { ...EMPTY_EVENTS_COUNTS },
  };
}

// --- /events/[slug] --------------------------------------------------------------

export interface EventBetRow {
  betId: string;
  label: string;
  status: string;
  mode: string;
  q: unknown;
  execAsk: unknown;
  edge: unknown;
  minEdge: unknown;
  stake: unknown;
  shares: unknown;
  executedPrice: unknown;
  executedShares: unknown;
  pnl: unknown;
  audit: Record<string, unknown>;
  recommendedAt: string;
}

export interface EventDetailPayload extends EventDetailForEdges {
  event: {
    id: string;
    slug: string;
    targetDate: string;
    unit: string;
    city: string;
    citySlug: string;
    tz: string;
    acceptingOrders: boolean;
    volume24h: unknown;
    winningBucketIdx: number | null;
    ladderOk: boolean;
    closed: boolean;
  };
  ladder: LadderRowPayload[];
  houseDist: {
    probs: unknown[];
    mu: unknown;
    sigma: unknown;
    nowcast: boolean;
    madeAt: string;
    lead: number;
  } | null;
  consensusDist: { probs: unknown[]; madeAt: string } | null;
  snapshotsSpark: { at: string; mid: unknown }[];
  bets: EventBetRow[];
  edgeEvaluations: StoredEdgeEval[];
  runningMax: {
    maxNative: unknown;
    maxTenthsC: unknown;
    nObs: unknown;
    lastObsAt: string;
  } | null;
}

export interface EventDetailView {
  detail: EventDetailPayload;
  recomputed: EdgeRow[] | null;
  comparison: EdgeComparison;
  championSource: string;
}

export async function getEventDetail(db: WebDb, slug: string): Promise<EventDetailView | null> {
  const cfg = await loadConfig(db);
  const detail = await one<EventDetailPayload>(db, 'dash_event_detail', {
    p_slug: slug,
    p_champion: cfg.championSource,
  });
  if (!detail) return null;
  const recomputed = recomputeEdgeRows(detail, cfg);
  const comparison = compareEdgeRows(detail, recomputed);
  return { detail, recomputed, comparison, championSource: cfg.championSource };
}

// --- /city/[slug] ------------------------------------------------------------------

export interface CityDetailPayload {
  city: {
    slug: string;
    name: string;
    unit: string;
    tz: string;
    region: string;
    bettingEnabled: boolean;
  };
  openEventToday: { slug: string; targetDate: string } | null;
  stationHistory: { id: string; icao: string; verified: boolean; validFrom: string; validTo: string | null }[];
  calibrationHeatmap: {
    model: string;
    lead: number;
    slot: string;
    bias: unknown;
    sigma: unknown;
    n: unknown;
    weight: unknown;
  }[];
  brierTrend: {
    source: string;
    lead: number;
    window: string;
    brier: unknown;
    brierMarket: unknown;
    ece: unknown;
    sharpness: unknown;
    n: unknown;
  }[];
  betHistory: { betId: string; eventSlug: string; label: string; status: string; stake: unknown; pnl: unknown; recommendedAt: string }[];
  divergenceLog: { date: string; flags: string[]; wu: unknown; metar: unknown; iemF: unknown }[];
}

export interface CityDetailView {
  city: CityDetailPayload;
  /** Today's open event with our overlay (§12 — reuses DistributionOverlay). */
  openEvent: EventDetailView | null;
}

export async function getCityDetail(db: WebDb, slug: string): Promise<CityDetailView | null> {
  const city = await one<CityDetailPayload>(db, 'dash_city_detail', {
    p_slug: slug,
    p_champion: (await loadConfig(db)).championSource,
  });
  if (!city || !city.city) return null;
  const openEvent = city.openEventToday ? await getEventDetail(db, city.openEventToday.slug) : null;
  return { city, openEvent };
}

// --- /city/[slug] observations inspector (0035) ----------------------------------

export interface StationObservationRow {
  /** date_local (jsonb date → 'YYYY-MM-DD'). */
  date: string;
  /** numeric-string-safe (file convention) — page coerces with num()/fmtTemp(). */
  tmaxNative: unknown;
  unit: string;
  nObs: unknown;
  provenance: string | null;
  metarNative: unknown;
  iemF: unknown;
  era5C: unknown;
  flags: string[];
  finalized: boolean;
}

export interface StationObservationsView {
  icao: string;
  unit: string;
  /** The window actually applied (after defaulting + clamping in the RPC). */
  window: { from: string; to: string; limit: unknown };
  /** Full-history coverage (NOT windowed) — so the span stays visible while rows filter. */
  summary: {
    n: unknown;
    firstDate: string | null;
    lastDate: string | null;
    wu: unknown;
    iem: unknown;
    flagged: unknown;
    finalized: unknown;
  };
  rows: StationObservationRow[];
}

/**
 * Daily-Tmax history for the city's current station (dash_station_observations, 0035).
 * Null `from`/`to`/`limit` let the RPC apply its own defaults (last 90 days, ≤120 rows).
 * Returns null for an unknown city / no current station mapping — and degrades to null
 * (not a thrown 500) if the RPC itself errors, so this additive section can never take
 * down the rest of the /city page (incl. when the page deploys ahead of the 0035 RPC).
 */
export async function getStationObservations(
  db: WebDb,
  slug: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<StationObservationsView | null> {
  try {
    return await one<StationObservationsView>(db, 'dash_station_observations', {
      p_slug: slug,
      p_from: opts.from ?? null,
      p_to: opts.to ?? null,
      p_limit: opts.limit ?? null,
    });
  } catch {
    return null;
  }
}

// --- /city/[slug] prediction-vs-actual + forecast skill (0038) -------------------

export interface StationPredictionRow {
  /** date_local (jsonb date → 'YYYY-MM-DD'). */
  date: string;
  /** All °C, numeric-string-safe (file convention) — page coerces with num()/fmtTemp()/fmtDelta(). */
  actualC: unknown;
  fcPlus1C: unknown;
  fcPlus2C: unknown;
  fcPlus3C: unknown;
  /** Signed error = actual − forecast (null when that lead had no forecast). */
  errPlus1: unknown;
  errPlus2: unknown;
  errPlus3: unknown;
  nModels: unknown;
  provenance: string | null;
}

/** Per-lead forecast skill over full finalized history (MAE/bias in °C; null when n=0). */
export interface LeadSkill {
  n: unknown;
  mae: unknown;
  bias: unknown;
}

export interface StationPredictionsView {
  icao: string;
  /** Always 'C' — this is the always-°C verification view (matches the 0037 export). */
  unit: string;
  /** The window actually applied (after defaulting + clamping in the RPC). */
  window: { from: string; to: string; limit: unknown };
  /** Full finalized history (NOT windowed) — so skill + span stay visible while rows filter. */
  summary: {
    n: unknown;
    withForecast: unknown;
    firstDate: string | null;
    lastDate: string | null;
    lead1: LeadSkill;
    lead2: LeadSkill;
    lead3: LeadSkill;
  };
  rows: StationPredictionRow[];
}

/**
 * Prediction-vs-actual + forecast skill for the city's current station
 * (dash_station_predictions, 0038). Null `from`/`to`/`limit` let the RPC apply its
 * own defaults (last 90 days, ≤120 rows). Returns null for an unknown city / no
 * current station mapping — and degrades to null (not a thrown 500) if the RPC itself
 * errors, so this additive section can never take down the rest of the /city page
 * (incl. when the page deploys ahead of the 0038 RPC).
 */
export async function getStationPredictions(
  db: WebDb,
  slug: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<StationPredictionsView | null> {
  try {
    return await one<StationPredictionsView>(db, 'dash_station_predictions', {
      p_slug: slug,
      p_from: opts.from ?? null,
      p_to: opts.to ?? null,
      p_limit: opts.limit ?? null,
    });
  } catch {
    return null;
  }
}

// --- /amsterdam paper-trade simulation (0039) -----------------------------------------

export interface ArmStanding {
  hour: number;
  nBets: unknown;
  nGraded: unknown;
  nPending: unknown;
  nWon: unknown;
  staked: unknown;
  pnl: unknown;
  roi: unknown;
  hitRate: unknown;
  avgAsk: unknown;
  pnlAtCompare: unknown;
  isLeader: boolean;
  /**
   * Per-arm confidence intervals (0042) computed in TS from the graded (won, ask) rows via
   * core/sim/stats armEdgeStats — so "is this arm's edge clearly off zero?" is answerable at a glance.
   * NaN (→ null in the page) when the arm has no graded bets. `edge`/`ev` recompute the point estimates
   * over the GRADED population (the paired-CI basis), so they're the authoritative ones for the panel.
   */
  hitCiLo: number;
  hitCiHi: number;
  /** Mean paired gap (won − ask) over graded bets — the low-variance headline edge. */
  edge: number;
  edgeCiLo: number;
  edgeCiHi: number;
  /** Mean realised EV per $1 staked, fee-free (won ? 1/ask−1 : −1). */
  ev: number;
  evCiLo: number;
  evCiHi: number;
  /**
   * Floor "truth accuracy" (0043) — a forecast-skill lens SEPARATE from the market: did our whole-°C call
   * equal floor(real KNMI high)? With the decimal signed error (nowcast basis − real high). nTruth/truthHitRate/
   * mae/bias are the RPC point estimates; the CIs are computed in the loader (armTruthStats) like the edge CIs.
   */
  nTruth: unknown;
  /** Truth-floor wins over the SAME finite-signed-error population as nTruth (for the pooled overall accuracy). */
  nTruthWon: number;
  truthHitRate: unknown;
  truthHitCiLo: number;
  truthHitCiHi: number;
  /** Mean absolute signed error (°C) — the arm's nowcast MAE at 0.1° resolution. */
  mae: unknown;
  /** Mean signed error (°C); positive = the nowcast ran hot vs the real high. */
  bias: unknown;
  biasCiLo: number;
  biasCiHi: number;
}

export interface SimBetRow {
  date: string;
  hour: number;
  predictedC: unknown;
  label: string | null;
  ask: unknown;
  runMaxC: unknown;
  /** De-biased lead-1 forecast (°C) available at placement; null when none. */
  forecastC: unknown;
  status: string;
  won: boolean | null;
  pnl: unknown;
  actualC: unknown;
  /** KNMI decimal true high (°C, 0.1°); null until truth lands. */
  actualDecimalC: unknown;
  /** Signed forecast error (°C): nowcast basis − decimal actual; null until truth lands. */
  signedErrorC: unknown;
  /** Floor truth: predicted whole °C == floor(decimal actual); null until truth lands. */
  truthWon: boolean | null;
}

export interface SimLatestRow {
  predictedC: unknown;
  label: string | null;
  ask: unknown;
  runMaxC: unknown;
  /** De-biased lead-1 forecast (°C) available at placement; null when none. */
  forecastC: unknown;
  status: string;
  won: boolean | null;
  pnl: unknown;
  actualC: unknown;
  /** KNMI decimal true high (°C, 0.1°); null until truth lands. */
  actualDecimalC: unknown;
  /** Signed forecast error (°C): nowcast basis − decimal actual; null until truth lands. */
  signedErrorC: unknown;
  /** Floor truth: predicted whole °C == floor(decimal actual); null until truth lands. */
  truthWon: boolean | null;
}

/** Floor-truth coverage — how much decimal KNMI truth is wired in (the reference table + the filled bets). */
export interface TruthCoverage {
  nBetsWithTruth: unknown;
  nDaysWithTruth: unknown;
  tableFirstDate: string | null;
  tableLastDate: string | null;
  tableNDays: unknown;
}

/**
 * The hero "real-time vs 20-year average" chart payload (0044). Joins the committed Schiphol climatology
 * (the avg temperature + avg running-max curves and the peak-hour distribution band, for the active month /
 * hot-day period) with the latest day's live running-max trace and the model's recommended lock window.
 */
export interface PeakHourChartView {
  month: number;
  hot: boolean;
  /** Mean instantaneous temperature (°C) by local hour 0..23 — the dashed "20-yr average" trace. */
  avgTempC: number[];
  /** Mean running-max-so-far (°C) by local hour 0..23 — comparable to today's bet floor. */
  avgRunMaxC: number[];
  /** Share of days whose max lands at each local hour 0..23 — rendered as the faint distribution behind the band. */
  peakHistogram: number[];
  /** Central ≥50% peak-hour window + modal hour, for the band annotation. */
  peakWindow: { fromHour: number; toHour: number; modeHour: number };
  medianPeakHour: number;
  /** The latest bet day's running-max by arm hour — the live blue overlay. */
  latestDate: string | null;
  todayRunMax: { hour: number; runMaxC: number }[];
  recommendedHour: number | null;
}

/**
 * Tomorrow's prediction (0046) — the bias-corrected lead-1 NWP forecast of tomorrow's high routed to the
 * whole-°C bucket and priced against tomorrow's live ladder. `forecastC` is the displayed forecast (the
 * trailing-debias-corrected value when ≥20 prior pairs exist, else the raw cross-model mean — `biasCorrected`
 * flags which). null fields when the NWP feed has no tomorrow capture; the whole object is null when the RPC
 * predates 0046 (the page degrades to "ships with the 0046 deploy").
 */
export interface TomorrowView {
  targetDate: string | null;
  hasMarket: boolean;
  /** How many lead-1 model captures the ensemble mean is over. */
  nModels: unknown;
  rawForecastC: unknown;
  biasC: unknown;
  biasN: unknown;
  biasCorrected: boolean;
  /** The forecast actually shown — corrected when trustworthy, else raw. */
  forecastC: unknown;
  /** wuRound(forecastC) — the whole-°C call. */
  predictedC: unknown;
  /** Ladder label for that bucket on tomorrow's market, or null when no market/bucket. */
  label: string | null;
  /** Latest best-ask on that bucket, or null when no live quote. */
  ask: unknown;
}

/** Live running-max-so-far for today (0046) — intraday_max, with the observation timestamp ("as of HH:mm"). */
export interface LiveRunMax {
  date: string | null;
  /** Running max in °C at 0.1° resolution. */
  maxTenthsC: unknown;
  maxNative: unknown;
  nObs: unknown;
  lastObsAt: string | null;
}

/** Pooled prediction accuracy across all arms (computed in the loader from the full-population aggregates). */
export interface OverallAccuracy {
  /** Market hit rate = won / graded, pooled over every arm (the number that drives P&L). */
  marketHitRate: number | null;
  nGradedAll: number;
  /** Floor-truth hit rate = truthWon / truth-filled, pooled over every arm (KNMI skill lens). */
  truthHitRate: number | null;
  nTruthAll: number;
}

export interface AmsterdamSimView {
  config: { primaryHour: number; armHours: number[]; compareDays: number; stakeUsd: number };
  coverage: { firstDate: string | null; lastDate: string | null; nDays: unknown; nGradedDays: unknown; nPending: unknown };
  arms: ArmStanding[];
  leaderHour: number | null;
  /** Cumulative net P&L per arm, carried forward onto the shared date axis (null before an arm's first bet). */
  chart: { dates: string[]; byHour: Record<number, (number | null)[]> };
  /** Best-time-to-bet fusion (0044): peak-hour floor confidence × prediction accuracy → recommended lock hour. */
  bestTime: BestTimeView;
  /** Hero chart data (0044): climatology curves + peak-hour band + latest live trace + recommendation. */
  peakHourChart: PeakHourChartView;
  betLog: SimBetRow[];
  latest: { date: string | null; byHour: Record<number, SimLatestRow> };
  /** Floor-truth coverage (0043); null when the RPC predates it. */
  truthCoverage: TruthCoverage | null;
  /** Tomorrow's prediction (0046); null when the RPC predates it. */
  tomorrow: TomorrowView | null;
  /** Live running-max as of now (0046); null when no obs today or the RPC predates it. */
  liveRunMax: LiveRunMax | null;
  /** Pooled prediction accuracy across all arms (computed in the loader, full-population). */
  overall: OverallAccuracy;
}

interface SimEquityPoint {
  date: string;
  cum: unknown;
}
type ArmPointPayload = Omit<
  ArmStanding,
  | 'isLeader'
  | 'hitCiLo'
  | 'hitCiHi'
  | 'edge'
  | 'edgeCiLo'
  | 'edgeCiHi'
  | 'ev'
  | 'evCiLo'
  | 'evCiHi'
  | 'truthHitCiLo'
  | 'truthHitCiHi'
  | 'biasCiLo'
  | 'biasCiHi'
>;
interface SimPayload {
  config: AmsterdamSimView['config'];
  coverage: AmsterdamSimView['coverage'];
  arms: ArmPointPayload[];
  leader: { hour: number; pnl: unknown; nGraded: unknown } | null;
  equityByArm: Record<string, SimEquityPoint[]>;
  /** Per-arm graded (won, ask) rows (0042) — the input to the per-arm market CI computation. */
  betsByArm?: Record<string, { won: boolean | null; ask: unknown }[]>;
  /** Per-arm (truthWon, signedErrorC) rows (0043) — the input to the floor-truth CI computation. */
  truthByArm?: Record<string, { truthWon: boolean | null; signedErrorC: unknown }[]>;
  betLog: SimBetRow[];
  latest: { date: string | null; byHour: Record<string, SimLatestRow> };
  truthCoverage?: TruthCoverage | null;
  /** 0046 — present only once the RPC redefine ships; the loader tolerates their absence. */
  tomorrow?: TomorrowView | null;
  liveRunMax?: LiveRunMax | null;
}

// Coercion MUST mirror format.ts `num`: map null/undefined/'' to null FIRST, because Number(null)===0 and
// Number('')===0 are finite — without the pre-check a present-but-null jsonb field (e.g. a null forecast or
// running max) would silently become 0, defeating the `!= null` filters below (phantom 0°C overlay point,
// wrong hot-climatology selection). Same contract as format.ts so there is one coercion semantics.
const toNum = (x: unknown): number | null => {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/** Europe/Amsterdam calendar month (1..12) for an instant — DST/zone-correct via Intl. */
function amsterdamMonth(now: Date): number {
  const mm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', month: '2-digit' }).format(now);
  return Number(mm);
}

/**
 * The Amsterdam paper-trade head-to-head (dash_amsterdam_sim, 0039) for /amsterdam. Aligns each arm's
 * cumulative equity onto the union date axis (carry-forward) so the four lines share an x-scale, then fuses
 * the 20-yr peak-hour climatology with the empirical hit rates into the best-time-to-bet recommendation +
 * hero chart (0044). Degrades to null (not a thrown 500) if the RPC errors — the page can deploy ahead of
 * the 0039 RPC. `now` is injectable so the best-time month selection is deterministic under test.
 */
export async function getAmsterdamSim(db: WebDb, opts: { now?: Date } = {}): Promise<AmsterdamSimView | null> {
  let v: SimPayload | null;
  try {
    v = await one<SimPayload>(db, 'dash_amsterdam_sim', {});
  } catch {
    return null;
  }
  if (!v) return null;

  const leaderHour = v.leader?.hour ?? null;
  const betsByArm = v.betsByArm ?? {};
  const truthByArm = v.truthByArm ?? {};
  const arms: ArmStanding[] = (v.arms ?? [])
    .map((a) => {
      // Per-arm hit/edge/EV CIs from the graded (won, ask) rows — computed once in core (armEdgeStats)
      // so the dashboard and the best-buy backtest agree. Coerce defensively (jsonb numerics arrive as
      // strings via the port; null `won` can't happen for a graded bet but is filtered for safety).
      const graded = (betsByArm[String(a.hour)] ?? [])
        .map((r) => ({ won: r.won === true, ask: toNum(r.ask) }))
        .filter((r): r is { won: boolean; ask: number } => r.ask != null);
      const s = armEdgeStats(graded);
      // Floor-truth CIs (0043) from the (truthWon, signedErrorC) rows — armTruthStats, same one-place idiom.
      // toNum (not Number) so a null signed error is DROPPED, not coerced to a phantom 0 that inflates n.
      const truth = (truthByArm[String(a.hour)] ?? [])
        .map((r) => ({ truthWon: r.truthWon === true, signedErrorC: toNum(r.signedErrorC) }))
        .filter((r): r is { truthWon: boolean; signedErrorC: number } => r.signedErrorC != null);
      const t = armTruthStats(truth);
      return {
        ...a,
        isLeader: a.hour === leaderHour,
        hitCiLo: s.hitCiLo,
        hitCiHi: s.hitCiHi,
        edge: s.edge,
        edgeCiLo: s.edgeCiLo,
        edgeCiHi: s.edgeCiHi,
        ev: s.ev,
        evCiLo: s.evCiLo,
        evCiHi: s.evCiHi,
        // Point estimates come from the SAME armTruthStats bundle as the CIs (not the RPC), so the table's
        // nTruth/hit/mae/bias and their intervals are guaranteed to share one population — a truth row with a
        // null/NaN signed error (possible when an arm's running_max_c is null) can't count toward the point
        // while being dropped from the interval. Identical to the RPC values whenever the populations agree.
        nTruth: t.nTruth,
        nTruthWon: t.nTruthWon,
        truthHitRate: t.truthHitRate,
        mae: t.mae,
        bias: t.bias,
        truthHitCiLo: t.truthHitCiLo,
        truthHitCiHi: t.truthHitCiHi,
        biasCiLo: t.biasCiLo,
        biasCiHi: t.biasCiHi,
      };
    })
    .sort((a, b) => a.hour - b.hour);

  // Shared, sorted union of every arm's bet dates → carry the last-known cum forward per arm.
  const dateSet = new Set<string>();
  for (const pts of Object.values(v.equityByArm ?? {})) for (const p of pts) dateSet.add(String(p.date).slice(0, 10));
  const dates = [...dateSet].sort();
  const byHour: Record<number, (number | null)[]> = {};
  for (const [hourStr, pts] of Object.entries(v.equityByArm ?? {})) {
    const sorted = [...pts].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let i = 0;
    let last: number | null = null;
    byHour[Number(hourStr)] = dates.map((d) => {
      while (i < sorted.length && String(sorted[i]!.date).slice(0, 10) <= d) {
        last = Number(sorted[i]!.cum);
        i++;
      }
      return last;
    });
  }

  const latestByHour: Record<number, SimLatestRow> = {};
  for (const [h, row] of Object.entries(v.latest?.byHour ?? {})) latestByHour[Number(h)] = row;

  // --- best-time-to-bet (0044): fuse the peak-hour climatology with the empirical arm hit rates ----------
  const month = amsterdamMonth(opts.now ?? new Date());
  const armHours = v.config.armHours ?? [];
  // Today's de-biased forecast (one per-day scalar, written identically onto every arm by the place RPC) →
  // selects the hot-day climatology. Prefer the primary arm's value explicitly, then fall back to the first
  // arm that carries one — so the choice is principled, not iteration-order-dependent, if arms ever diverge.
  const forecastC =
    toNum(latestByHour[v.config.primaryHour]?.forecastC) ??
    armHours.map((h) => toNum(latestByHour[h]?.forecastC)).find((x) => x != null) ??
    null;
  const bestTime = recommendBestTime({
    month,
    forecastC,
    arms: arms.map((a) => ({
      hour: a.hour,
      hitRate: toNum(a.hitRate),
      avgAsk: toNum(a.avgAsk),
      nGraded: toNum(a.nGraded) ?? 0,
    })),
  });

  const climMonth = AMSTERDAM_CLIMATOLOGY.months.find((m) => m.month === month) ?? AMSTERDAM_CLIMATOLOGY.months[0]!;
  const todayRunMax = armHours
    .map((h) => ({ hour: h, runMaxC: toNum(latestByHour[h]?.runMaxC) }))
    .filter((r): r is { hour: number; runMaxC: number } => r.runMaxC != null);
  const peakHourChart: PeakHourChartView = {
    month,
    hot: bestTime.usedHotClimatology,
    avgTempC: climMonth.avgTempC,
    avgRunMaxC: climMonth.avgRunMaxC,
    peakHistogram:
      bestTime.usedHotClimatology && climMonth.hot ? climMonth.hot.peakHourHistogram : climMonth.peakHourHistogram,
    peakWindow: peakHourWindow(bestTime.usedHotClimatology && climMonth.hot ? climMonth.hot : climMonth),
    medianPeakHour: bestTime.medianPeakHour,
    latestDate: v.latest?.date ?? null,
    todayRunMax,
    recommendedHour: bestTime.recommendedHour,
  };

  // Pooled prediction accuracy across all arms — from the full-population arm aggregates (market) and the
  // uncapped per-arm truth rows (floor-truth), NOT from betLog (which the RPC caps at 120 rows). This is the
  // single headline accuracy number the operator asked for.
  // Floor-truth pools over the SAME population as the per-arm cards (armTruthStats — finite signed error),
  // by summing each arm's nTruth/nTruthWon, so the headline reconciles with the truth table (no double
  // population). Market pools nWon/nGraded over the full graded set.
  let nGradedAll = 0;
  let nWonAll = 0;
  let nTruthAll = 0;
  let nTruthWonAll = 0;
  for (const a of arms) {
    nGradedAll += toNum(a.nGraded) ?? 0;
    nWonAll += toNum(a.nWon) ?? 0;
    nTruthAll += toNum(a.nTruth) ?? 0;
    nTruthWonAll += a.nTruthWon;
  }
  const overall: OverallAccuracy = {
    marketHitRate: nGradedAll > 0 ? nWonAll / nGradedAll : null,
    nGradedAll,
    truthHitRate: nTruthAll > 0 ? nTruthWonAll / nTruthAll : null,
    nTruthAll,
  };

  return {
    config: v.config,
    coverage: v.coverage,
    arms,
    leaderHour,
    chart: { dates, byHour },
    bestTime,
    peakHourChart,
    betLog: v.betLog ?? [],
    latest: { date: v.latest?.date ?? null, byHour: latestByHour },
    truthCoverage: v.truthCoverage ?? null,
    tomorrow: v.tomorrow ?? null,
    liveRunMax: v.liveRunMax ?? null,
    overall,
  };
}

// --- /calibration --------------------------------------------------------------------

export interface CalibrationScoreRow {
  city: string | null;
  cityId: string;
  source: string;
  lead: number;
  window: string;
  brier: unknown;
  brierMarket: unknown;
  bootstrapP: unknown;
  ece: unknown;
  sharpness: unknown;
  reliability: unknown;
  n: unknown;
}

export interface CalibrationView {
  scores: CalibrationScoreRow[];
  champion: string;
}

export async function getCalibrationView(db: WebDb): Promise<CalibrationView> {
  const v = await one<{ scores: CalibrationScoreRow[] | null; champion: string | null }>(db, 'dash_calibration', {
    p_champion: (await loadConfig(db)).championSource,
  });
  return { scores: v?.scores ?? [], champion: v?.champion ?? 'house_gaussian' };
}

// --- /bets -------------------------------------------------------------------------

export interface BetsLedgerView {
  mode: string;
  bets: {
    betId: string;
    eventSlug: string;
    city: string;
    label: string;
    status: string;
    mode: string;
    q: unknown;
    edge: unknown;
    execAsk: unknown;
    executedPrice: unknown;
    shares: unknown;
    stake: unknown;
    fee: unknown;
    pnl: unknown;
    recommendedAt: string;
    executedAt: string | null;
  }[];
  totals: { n: unknown; wins: unknown; losses: unknown; pnl: unknown; staked: unknown };
  equityCurve: { at: string; balance: unknown }[];
  hitRateByEdgeDecile: { decile: number; n: unknown; hitRate: unknown; avgEdge: unknown; avgQ: unknown; pnl: unknown }[];
}

export async function getBetsLedger(db: WebDb): Promise<BetsLedgerView> {
  const cfg = await loadConfig(db);
  const v = await one<Omit<BetsLedgerView, 'mode'>>(db, 'dash_bets_ledger', { p_mode: cfg.tradingMode });
  if (!v) throw new Error('dash_bets_ledger returned nothing');
  return { mode: cfg.tradingMode, ...v };
}

// --- /system -------------------------------------------------------------------------

export interface SystemHealthView {
  jobRuns: {
    job: string;
    periodKey: string;
    status: string;
    attempt: number;
    startedAt: string;
    durationMs: unknown;
    error: string | null;
    stats: Record<string, unknown> | null;
  }[];
  failures24h: { job: string; failed: unknown }[];
  alertsRecent: { kind: string; severity: string; title: string; sent: boolean; at: string }[];
  dataGaps: { icao: string; model: string; date: string }[];
  storage: { forecastRows: unknown; snapshotRows: unknown; probRows: unknown };
}

export async function getSystemHealth(db: WebDb): Promise<SystemHealthView> {
  const v = await one<SystemHealthView>(db, 'dash_system_health', {});
  if (!v) throw new Error('dash_system_health returned nothing');
  return v;
}

// --- /admin -------------------------------------------------------------------------

export interface GateReason {
  text: string;
  /**
   * True for the wallet-key condition: the web tier cannot read Edge
   * Function secrets, so this row is re-checked inside execute-bet at
   * execution time (§8.3 boundary) — rendered with that caveat.
   */
  webCaveat: boolean;
}

export interface AdminStateView {
  config: { key: string; value: string }[];
  halts: { key: string; value: string }[];
  audit: { key: string; old: string | null; new: string | null; actor: string; at: string }[];
  unverifiedStations: { id: string; city: string; icao: string; validFrom: string }[];
  tradingMode: string;
  championSource: string;
  goLiveChecklist: { pass: boolean; reasons: GateReason[]; error: string | null };
}

const GEOBLOCK_URL = 'https://docs.polymarket.com/api-reference/geoblock.md';

/** Production gate-readout deps — tests inject their own (§15 9.9). */
export function prodGateDeps(): GateDeps {
  return {
    getEnvVar: (name) => process.env[name],
    fetchGeoblock: async () => {
      const r = await fetch(GEOBLOCK_URL);
      if (!r.ok) throw new Error(`geoblock fetch ${r.status}`);
      return r.text();
    },
    now: new Date(),
  };
}

export async function getAdminState(db: WebDb, gateDeps?: GateDeps): Promise<AdminStateView> {
  const cfg = await loadConfig(db);
  const v = await one<Pick<AdminStateView, 'config' | 'halts' | 'audit' | 'unverifiedStations'>>(
    db,
    'dash_admin_state',
    {},
  );
  if (!v) throw new Error('dash_admin_state returned nothing');

  // goLiveGate READOUT only (§8.3 boundary — execute-bet re-runs it
  // authoritatively on every live placement; @weather-edge/trading is an
  // allowed importer here per the §15 invariant).
  let checklist: AdminStateView['goLiveChecklist'];
  try {
    const gate = await goLiveGate(
      db,
      { tradingMode: cfg.tradingMode, championSource: cfg.championSource },
      gateDeps ?? prodGateDeps(),
    );
    checklist = {
      pass: gate.pass,
      reasons: gate.reasons.map((text) => ({
        text,
        webCaveat: text.includes('execute-bet function secrets'),
      })),
      error: null,
    };
  } catch (e) {
    checklist = { pass: false, reasons: [], error: `gate readout unavailable: ${String(e)}` };
  }

  return {
    ...v,
    tradingMode: cfg.tradingMode,
    championSource: cfg.championSource,
    goLiveChecklist: checklist,
  };
}
