/**
 * RSC data loaders (§6.21) — one 0022 dash_* RPC round trip per page, plus
 * the derived view-models the pages need (exposure summary via core,
 * EdgeChart display recompute, goLiveGate readout). Framework-free: every
 * loader takes the WebDb port, so the PGlite suite drives the REAL loaders;
 * pages bind serverDb() from supabase.ts.
 */
import {
  AMSTERDAM_CLIMATOLOGY,
  DEFAULT_REPLICA_STRATEGY,
  armEdgeStats,
  armTruthStats,
  dailyLedger,
  exposureSummary,
  parseConfigRows,
  peakHourWindow,
  rankCitiesByRoi,
  recommendBestTime,
  recommendEntryHour,
  scoreLocked,
  summarize,
} from '@weather-edge/core';
import type {
  AppConfig,
  ArmGradedBets,
  BestTimeView,
  CityRoi,
  ConvergenceView,
  DailyRow,
  EdgeRow,
  EntryWatchResult,
  LockedBuy,
  MakerExitView,
  ReplicaStrategy,
  ReplicaSummary,
} from '@weather-edge/core';
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

/**
 * Today's prediction (0052) — the FRESHEST same-day forecast, so the "Predicted high" tile switches in the
 * morning of the day (and tracks the latest NWP capture all day) instead of lagging on the afternoon's first
 * placed bet. Same shape as TomorrowView plus `lead` (0 once the same-day run lands, else 1) and `capturedAt`
 * (the freshness stamp). `forecastC` is the trailing-debias-corrected value when ≥20 prior pairs exist for the
 * matched lead, else the raw cross-model mean (`biasCorrected` flags which); null fields when the NWP feed has
 * no capture for today; the whole object is null when the RPC predates 0052 (the page degrades to the bet-
 * carried forecast / running-max floor).
 */
export interface TodayView {
  targetDate: string | null;
  hasMarket: boolean;
  /** The freshest capture's lead (0 = same-day run, 1 = previous night's run before today's lands). */
  lead: unknown;
  /** The freshest capture instant (UTC) — the "as of HH:mm" freshness stamp. */
  capturedAt: string | null;
  /** Distinct models behind the cross-model mean. */
  nModels: unknown;
  rawForecastC: unknown;
  biasC: unknown;
  biasN: unknown;
  biasCorrected: boolean;
  /** The forecast actually shown — corrected when trustworthy, else raw. */
  forecastC: unknown;
  /** wuRound(forecastC) — today's whole-°C call. */
  predictedC: unknown;
  /** Ladder label for that bucket on today's market, or null when no market/bucket. */
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

/** One revealed bet held by the tracked sharp on the latest pull (0049). */
export interface SharpPosition {
  targetDate: string | null;
  bucketIdx: number | null;
  outcome: string;
  sizeShares: unknown;
  avgPrice: unknown;
  curValueUsd: unknown;
  title: string | null;
}

/**
 * The sharp-wallet disagreement (0049) — the verified #1 WEATHER sharp's revealed Amsterdam bet for the
 * soonest upcoming market, set against our house_ensemble forecast and the market's modal (max-mid) bucket.
 * `hasSharp=false` until the sharp-wallet-track tracker has written a position; the whole object is null
 * when the RPC predates 0049.
 */
export interface SharpsView {
  hasSharp: boolean;
  address: string;
  label: string | null;
  asOfDate: string | null;
  targetDate: string | null;
  /** Latest WEATHER-leaderboard standing (null until the board is snapshotted). */
  rank: unknown;
  pnlUsd: unknown;
  /** Their max-conviction (max-size) YES bucket — the bucket they back to win. */
  sharpBucketIdx: number | null;
  sharpLabel: string | null;
  /** Our house_ensemble argmax bucket. */
  ourBucketIdx: number | null;
  ourLabel: string | null;
  /** The market's modal (max-mid) bucket. */
  marketBucketIdx: number | null;
  marketLabel: string | null;
  /** Distinct calls among {sharp, ours, market}: 1 = full agreement, 3 = three-way split. */
  disagreement: unknown;
  /** sharpBucketIdx − ourBucketIdx in ladder steps (≈ °C for the interior), or null. */
  signedDeltaIdx: number | null;
  positions: SharpPosition[];
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
  /** Today's freshest prediction (0052); null when the RPC predates it. */
  today: TodayView | null;
  /** Live running-max as of now (0046); null when no obs today or the RPC predates it. */
  liveRunMax: LiveRunMax | null;
  /** Sharp-wallet disagreement (0049); null when the RPC predates it. */
  sharps: SharpsView | null;
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
  /** 0052 — present only once the RPC redefine ships; the loader tolerates its absence. */
  today?: TodayView | null;
  liveRunMax?: LiveRunMax | null;
  /** 0049 — present only once the RPC redefine ships; the loader tolerates its absence. */
  sharps?: SharpsView | null;
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
  // Today's de-biased forecast → selects the hot-day climatology. Prefer the FRESH same-day forecast (0052,
  // available in the morning), then the primary arm's bet-carried value, then the first arm that carries one
  // — so the hot-day flag also switches in the morning, not on the afternoon's first placed bet.
  const forecastC =
    toNum(v.today?.forecastC) ??
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
    today: v.today ?? null,
    liveRunMax: v.liveRunMax ?? null,
    sharps: v.sharps ?? null,
    overall,
  };
}

// --- /paper-trade (multi-city paper-trade, dash_city_sim 0070) ------------------------

export interface CitySimArm {
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
  isLeader: boolean;
  /** The entry-time watcher's pick (max edgeCiLo among arms with ≥minGraded bets) — distinct from isLeader (max P&L). */
  recommended: boolean;
  /** 1 = best by edgeCiLo among ELIGIBLE arms; null when the arm is too thin to rank. */
  watchRank: number | null;
  /** Per-arm CIs from the graded (won, ask) rows via core/sim/stats armEdgeStats (same idiom as /amsterdam). */
  hitCiLo: number;
  hitCiHi: number;
  edge: number;
  edgeCiLo: number;
  edgeCiHi: number;
  ev: number;
  evCiLo: number;
  evCiHi: number;
}

export interface CitySimBetRow {
  date: string;
  hour: number;
  predictedC: unknown;
  label: string | null;
  ask: unknown;
  runMaxC: unknown;
  forecastC: unknown;
  status: string;
  won: boolean | null;
  pnl: unknown;
  actualC: unknown;
}

export interface CitySimCity {
  slug: string;
  displayName: string;
  icao: string;
  unit: string;
  tz: string;
  armHours: number[];
  stakeUsd: unknown;
  coverage: { firstDate: string | null; lastDate: string | null; nDays: unknown; nGradedDays: unknown; nPending: unknown };
  arms: CitySimArm[];
  leaderHour: number | null;
  /** The continuously-updated entry-time recommendation from the graded ledger (core/sim/entry-watch). */
  entryWatch: EntryWatchResult;
  totals: { pnl: unknown; nGraded: unknown; nWon: unknown; staked: unknown };
  chart: { dates: string[]; byHour: Record<number, (number | null)[]> };
  betLog: CitySimBetRow[];
  latest: { date: string | null; byHour: Record<number, { predictedC: unknown; label: string | null; ask: unknown; status: string; won: boolean | null; pnl: unknown; actualC: unknown; runMaxC: unknown }> };
}

export interface CitySimView {
  generatedAt: string;
  cities: CitySimCity[];
  overall: { pnl: unknown; nGraded: unknown; nWon: unknown };
}

interface CitySimCityPayload {
  slug: string;
  displayName: string;
  icao: string;
  unit: string;
  tz: string;
  armHours: number[];
  stakeUsd: unknown;
  coverage: CitySimCity['coverage'];
  arms: Omit<CitySimArm, 'isLeader' | 'recommended' | 'watchRank' | 'hitCiLo' | 'hitCiHi' | 'edge' | 'edgeCiLo' | 'edgeCiHi' | 'ev' | 'evCiLo' | 'evCiHi'>[];
  leader: { hour: number } | null;
  totals: CitySimCity['totals'];
  equityByArm: Record<string, { date: string; cum: unknown; status: string }[]>;
  betsByArm: Record<string, { won: boolean; ask: unknown }[]>;
  betLog: CitySimBetRow[];
  latest: CitySimCity['latest'];
}
interface CitySimPayload {
  generatedAt: string;
  cities: CitySimCityPayload[];
  overall: CitySimView['overall'];
}

/**
 * The multi-city paper-trade head-to-head (dash_city_sim, 0070) for /paper-trade — the Amsterdam sim
 * generalized to N operator-chosen cities (Singapore + Karachi). Per city: aligns each arm's cumulative
 * equity onto the union date axis (carry-forward) so the lines share an x-scale, and computes the per-arm
 * hit/edge/EV CIs (armEdgeStats) from the graded (won, ask) rows. Degrades to null (not a 500) if the RPC
 * errors — the page can deploy ahead of the RPC.
 */
export async function getCitySim(db: WebDb): Promise<CitySimView | null> {
  let v: CitySimPayload | null;
  try {
    v = await one<CitySimPayload>(db, 'dash_city_sim', {});
  } catch {
    return null;
  }
  if (!v) return null;

  const cities: CitySimCity[] = (v.cities ?? []).map((c) => {
    const leaderHour = c.leader?.hour ?? null;
    const betsByArm = c.betsByArm ?? {};
    // The graded (won, ask) bets per arm — the single source the per-arm CIs AND the entry-time watcher read.
    const armBets: ArmGradedBets[] = (c.arms ?? []).map((a) => ({
      hour: a.hour,
      bets: (betsByArm[String(a.hour)] ?? [])
        .map((r) => ({ won: r.won === true, ask: toNum(r.ask) }))
        .filter((r): r is { won: boolean; ask: number } => r.ask != null),
    }));
    // The continuously-updated optimal-entry-hour recommendation (recomputed every load as the ledger grows).
    const entryWatch = recommendEntryHour(armBets);
    const watchByHour = new Map(entryWatch.arms.map((w) => [w.hour, w]));
    const arms: CitySimArm[] = (c.arms ?? [])
      .map((a) => {
        const graded = armBets.find((x) => x.hour === a.hour)?.bets ?? [];
        const s = armEdgeStats(graded);
        const w = watchByHour.get(a.hour);
        return {
          ...a,
          isLeader: a.hour === leaderHour,
          recommended: w?.recommended ?? false,
          watchRank: w?.rank ?? null,
          hitCiLo: s.hitCiLo,
          hitCiHi: s.hitCiHi,
          edge: s.edge,
          edgeCiLo: s.edgeCiLo,
          edgeCiHi: s.edgeCiHi,
          ev: s.ev,
          evCiLo: s.evCiLo,
          evCiHi: s.evCiHi,
        };
      })
      .sort((a, b) => a.hour - b.hour);

    // Shared sorted union of every arm's bet dates → carry the last-known cum forward per arm.
    const dateSet = new Set<string>();
    for (const pts of Object.values(c.equityByArm ?? {})) for (const p of pts) dateSet.add(String(p.date).slice(0, 10));
    const dates = [...dateSet].sort();
    const byHour: Record<number, (number | null)[]> = {};
    for (const [hourStr, pts] of Object.entries(c.equityByArm ?? {})) {
      const sorted = [...pts].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      let i = 0;
      let last: number | null = null;
      byHour[Number(hourStr)] = dates.map((d) => {
        while (i < sorted.length && String(sorted[i]!.date).slice(0, 10) <= d) {
          last = toNum(sorted[i]!.cum);
          i++;
        }
        return last;
      });
    }

    const latestByHour: Record<number, CitySimCity['latest']['byHour'][number]> = {};
    for (const [h, row] of Object.entries(c.latest?.byHour ?? {})) latestByHour[Number(h)] = row;

    return {
      slug: c.slug,
      displayName: c.displayName,
      icao: c.icao,
      unit: c.unit,
      tz: c.tz,
      armHours: c.armHours ?? [],
      stakeUsd: c.stakeUsd,
      coverage: c.coverage,
      arms,
      leaderHour,
      entryWatch,
      totals: c.totals,
      chart: { dates, byHour },
      betLog: c.betLog ?? [],
      latest: { date: c.latest?.date ?? null, byHour: latestByHour },
    };
  });

  return { generatedAt: v.generatedAt, cities, overall: v.overall };
}

// --- /paper-trade pre-placement forecast (dash_city_forecast, 0080) --------------------

/**
 * Today's PRE-PLACEMENT forecast for one enrolled city — the number the sim INTENDS to bet before the daily
 * 10:00 UTC tick places it. Fields are the bias-corrected lead-1 forecast center (mirror of
 * city_sim_place_inputs), converted to the city's native unit and wuRounded to the whole-° call, priced
 * against today's live ladder. jsonb-string-safe numerics (file convention) — the page coerces with num().
 */
export interface CityForecast {
  slug: string;
  displayName: string;
  icao: string;
  unit: string;
  tz: string;
  armHours: number[];
  forecastMaxHour: unknown;
  /** City-local target day this forecast is for (the day the tick will bet). */
  targetDate: string | null;
  hasMarket: boolean;
  /** Freshest lead-1 capture instant (UTC) — the "as of" freshness stamp. */
  capturedAt: string | null;
  nModels: unknown;
  rawForecastC: unknown;
  biasC: unknown;
  biasN: unknown;
  /** True when ≥20 trailing pairs let the bias correction be trusted; false → forecastC is the raw mean. */
  biasCorrected: boolean;
  /** The displayed forecast in °C (bias-corrected when trustworthy, else the raw cross-model mean). */
  forecastC: unknown;
  /** The forecast converted to the city's native unit — what predictedNative rounds from. */
  forecastNative: unknown;
  /** wuRound(forecastNative) — today's whole-° call the sim intends to bet. */
  predictedNative: unknown;
  /** Ladder label for that bucket on today's market, or null (no market / no covering bucket). */
  label: string | null;
  /** Latest best-ask on that bucket, or null when no live quote. */
  ask: unknown;
  /** Whether the daily tick has already placed today's bet for this city. */
  alreadyPlacedToday: boolean;
}

export interface CityForecastView {
  generatedAt: string;
  cities: CityForecast[];
}

/**
 * Today's pre-placement forecast per enrolled city (dash_city_forecast, 0080) — so the /paper-trade
 * current-bet box can headline today's INTENDED temperature before the daily tick, instead of lagging on
 * yesterday's placed bet. Degrades to null (not a thrown 500) if the RPC errors or the page deploys ahead of
 * the 0080 RPC — the box then falls back to the placed-bet behaviour (ships dark). Same null-tolerant idiom
 * as getCitySim.
 */
export async function getCityForecast(db: WebDb): Promise<CityForecastView | null> {
  let v: CityForecastView | null;
  try {
    v = await one<CityForecastView>(db, 'dash_city_forecast', {});
  } catch {
    return null;
  }
  if (!v) return null;
  return { generatedAt: v.generatedAt, cities: v.cities ?? [] };
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

// --- /replica badatmath paper-trial dashboard (0053) -------------------------------------------------

/** One persisted replica position row (dash_replica_sim), jsonb-string-safe (coerced below). */
interface ReplicaPositionRow {
  source: 'backtest' | 'forward';
  conditionId: string | null;
  eventId: string;
  citySlug: string;
  region: string | null;
  targetDate: string;
  bucketIdx: unknown;
  bucketLabel: string | null;
  resolutionTs: unknown;
  entryTs: unknown;
  entryDayUtc: string;
  makerPrice: unknown;
  takerPrice: unknown;
  stakeUsd: unknown;
  feeRate: unknown;
  bucketWon: boolean | null;
  makerRealisticFilled: boolean | null;
  status: 'open' | 'resolved';
  placedAtUtc: string | null;
  closedAtUtc: string | null;
}

/** A persisted run row (the strategy + whitelist + funnel/tally counts). */
interface ReplicaRunRow {
  mode: string;
  ranAt: string | null;
  seedFrom: string | null;
  seedTo: string | null;
  whitelist: string[] | null;
  strat: Record<string, unknown> | null;
  nCandidates: unknown;
  nBand: unknown;
  nSelected: unknown;
  nAllocated: unknown;
  nOpen: unknown;
  nClosed: unknown;
  nOpened: unknown;
  nReconciled: unknown;
}

interface ReplicaPayload {
  positions: ReplicaPositionRow[];
  runs: { backtest: ReplicaRunRow | null; forward: ReplicaRunRow | null };
  recentRuns: { mode: string; ranAt: string; nOpen: unknown; nClosed: unknown; nOpened: unknown; nReconciled: unknown }[];
}

/** The per-scope (backtest / forward) roll-up — all from the SAME core engine the scripts use. */
export interface ReplicaScopeView {
  summary: ReplicaSummary;
  daily: DailyRow[];
  cities: CityRoi[];
}

/** One open (placed, awaiting-resolution) forward position for the live table. */
export interface ReplicaOpenRow {
  citySlug: string;
  region: string;
  targetDate: string;
  bucketLabel: string;
  makerPrice: number;
  takerPrice: number;
  stakeUsd: number;
  resolutionTs: number;
  placedAtUtc: string | null;
}

export interface ReplicaSimView {
  /** The strategy actually used (latest forward run → backtest run → DEFAULT). */
  strat: ReplicaStrategy;
  /** "His best-performing cities" computed by the latest forward run (the live whitelist). */
  whitelist: string[];
  backtest: ReplicaScopeView;
  forward: ReplicaScopeView;
  /** Forward positions still open (placed, awaiting resolution), soonest-resolving first. */
  open: ReplicaOpenRow[];
  lastBacktestRunAt: string | null;
  lastForwardRunAt: string | null;
  recentRuns: { mode: string; ranAt: string; nOpen: number; nClosed: number; nOpened: number; nReconciled: number }[];
  /** Forward funnel headline counts (placed = open+resolved). */
  forwardPlaced: number;
  forwardResolved: number;
  forwardOpen: number;
  /** Backtest resolved count (the seed sample size). */
  backtestResolved: number;
  /** Backtest funnel (from the run row) — candidates → band-eligible → selected → bought. */
  backtestFunnel: { nCandidates: number; nBand: number; nSelected: number; nAllocated: number } | null;
  hasData: boolean;
}

/** Coerce a persisted position row into the core LockedBuy the engine scores. */
function toLockedBuy(r: ReplicaPositionRow): LockedBuy {
  return {
    conditionId: r.conditionId ?? '',
    eventId: r.eventId,
    citySlug: r.citySlug,
    region: r.region ?? '',
    targetDate: String(r.targetDate).slice(0, 10),
    bucketIdx: toNum(r.bucketIdx) ?? 0,
    bucketLabel: r.bucketLabel ?? '',
    resolutionTs: toNum(r.resolutionTs) ?? 0,
    entryTs: toNum(r.entryTs) ?? 0,
    entryDayUtc: String(r.entryDayUtc).slice(0, 10),
    makerPrice: toNum(r.makerPrice) ?? 0,
    takerPrice: toNum(r.takerPrice) ?? 0,
    stakeUsd: toNum(r.stakeUsd) ?? 0,
    feeRate: toNum(r.feeRate) ?? 0,
    bucketWon: r.bucketWon == null ? null : r.bucketWon === true,
    makerRealisticFilled: r.makerRealisticFilled === true,
  };
}

/** Coerce a persisted strat jsonb into a full ReplicaStrategy (fields missing → DEFAULT). */
function parseReplicaStrat(raw: Record<string, unknown> | null | undefined): ReplicaStrategy {
  const n = (k: keyof ReplicaStrategy): number => toNum(raw?.[k]) ?? DEFAULT_REPLICA_STRATEGY[k];
  return {
    cheapBandLo: n('cheapBandLo'),
    cheapBandHi: n('cheapBandHi'),
    entryLeadHours: n('entryLeadHours'),
    breadthPerCityDay: n('breadthPerCityDay'),
    positionStakeUsd: n('positionStakeUsd'),
    dailyBankrollCapUsd: n('dailyBankrollCapUsd'),
    tickSize: n('tickSize'),
    feeRate: n('feeRate'),
  };
}

/** Roll one scope's positions up through the core engine (one source of truth with the scripts). */
function scopeView(rows: ReplicaPositionRow[], strat: ReplicaStrategy, minCityN: number): ReplicaScopeView {
  const scored = rows.map((r) => scoreLocked(toLockedBuy(r), strat));
  return {
    summary: summarize(scored, { nCandidates: scored.length, nBandEligible: scored.length }),
    daily: dailyLedger(scored),
    cities: rankCitiesByRoi(scored, { leg: 'makerIdeal', minResolved: minCityN }),
  };
}

/**
 * The badatmath replica paper-trial (dash_replica_sim, 0053) for /replica. Returns the persisted positions +
 * the latest runs; the loader scores them through the core engine (scoreLocked → summarize/dailyLedger/
 * rankCitiesByRoi) so the web roll-ups can never drift from the scripts'. Degrades to null (not a thrown 500)
 * if the RPC errors — the page can deploy ahead of the 0053 RPC.
 */
export async function getReplicaSim(db: WebDb): Promise<ReplicaSimView | null> {
  let v: ReplicaPayload | null;
  try {
    v = await one<ReplicaPayload>(db, 'dash_replica_sim', {});
  } catch {
    return null;
  }
  if (!v) return null;

  const positions = v.positions ?? [];
  const backtestRows = positions.filter((p) => p.source === 'backtest');
  const forwardRows = positions.filter((p) => p.source === 'forward');

  // Strategy for scoring + display: latest forward run, else backtest run, else the §15 default.
  const strat = parseReplicaStrat(v.runs?.forward?.strat ?? v.runs?.backtest?.strat ?? null);

  // Forward cities surface sooner (small n) at minResolved 3; the backtest seed uses the fuller 8.
  const backtest = scopeView(backtestRows, strat, 8);
  const forward = scopeView(forwardRows, strat, 3);

  const open: ReplicaOpenRow[] = forwardRows
    .filter((p) => p.status === 'open')
    .map((p) => ({
      citySlug: p.citySlug,
      region: p.region ?? '',
      targetDate: String(p.targetDate).slice(0, 10),
      bucketLabel: p.bucketLabel ?? '',
      makerPrice: toNum(p.makerPrice) ?? 0,
      takerPrice: toNum(p.takerPrice) ?? 0,
      stakeUsd: toNum(p.stakeUsd) ?? 0,
      resolutionTs: toNum(p.resolutionTs) ?? 0,
      placedAtUtc: p.placedAtUtc,
    }))
    .sort((a, b) => a.resolutionTs - b.resolutionTs);

  const forwardResolved = forwardRows.filter((p) => p.status === 'resolved').length;
  const forwardOpen = forwardRows.length - forwardResolved;
  const bRun = v.runs?.backtest ?? null;

  return {
    strat,
    whitelist: v.runs?.forward?.whitelist ?? [],
    backtest,
    forward,
    open,
    lastBacktestRunAt: v.runs?.backtest?.ranAt ?? null,
    lastForwardRunAt: v.runs?.forward?.ranAt ?? null,
    recentRuns: (v.recentRuns ?? []).map((r) => ({
      mode: r.mode,
      ranAt: r.ranAt,
      nOpen: toNum(r.nOpen) ?? 0,
      nClosed: toNum(r.nClosed) ?? 0,
      nOpened: toNum(r.nOpened) ?? 0,
      nReconciled: toNum(r.nReconciled) ?? 0,
    })),
    forwardPlaced: forwardRows.length,
    forwardResolved,
    forwardOpen,
    backtestResolved: backtestRows.filter((p) => p.status === 'resolved').length,
    backtestFunnel: bRun
      ? {
          nCandidates: toNum(bRun.nCandidates) ?? 0,
          nBand: toNum(bRun.nBand) ?? 0,
          nSelected: toNum(bRun.nSelected) ?? 0,
          nAllocated: toNum(bRun.nAllocated) ?? 0,
        }
      : null,
    hasData: positions.length > 0,
  };
}

// --- /rewards — REC-8/9 Phase A reward-farming feed (dash_market_rewards, 0058) ----------------------------

/** One per-capture point of the pool-vs-competing-capital time series (jsonb-string-safe; page coerces). */
export interface RewardSeriesPoint {
  capturedAt: string;
  nMarkets: unknown;
  totalPoolUsd: unknown;
  totalInBandUsd: unknown;
}

/** One funded-weather market in the latest capture (top-by-pool). */
export interface RewardMarketRow {
  slug: string | null;
  dailyPoolUsd: unknown;
  mid: unknown;
  bestBid: unknown;
  bestAsk: unknown;
  bidDepthUsd: unknown;
  askDepthUsd: unknown;
  maxSpreadCents: unknown;
}

export interface RewardLatest {
  capturedAt: string | null;
  nMarkets: unknown;
  totalPoolUsd: unknown;
  totalInBandUsd: unknown;
}

export interface RewardsView {
  /** Per-capture series (pool vs in-band competing maker capital), ascending. */
  series: RewardSeriesPoint[];
  /** Most-recent capture headline (null when no captures yet). */
  latest: RewardLatest | null;
  /** Top funded markets by daily pool in the latest capture. */
  topMarkets: RewardMarketRow[];
  /** The window actually requested (days), echoed for the UI caption. */
  days: number;
}

interface RewardsPayload {
  series: RewardSeriesPoint[] | null;
  latest: RewardLatest | null;
  topMarkets: RewardMarketRow[] | null;
}

/**
 * The funded-weather reward-farming feed (dash_market_rewards, 0058) for /rewards. The page watches the
 * thin-book trend — is competing maker capital thickening (window closing) or staying thin (window open).
 * Degrades to null (not a thrown 500) if the RPC errors — the page can deploy ahead of the 0058 RPC.
 */
export async function getMarketRewards(
  db: WebDb,
  opts: { days?: number; top?: number } = {},
): Promise<RewardsView | null> {
  const days = opts.days ?? 7;
  let v: RewardsPayload | null;
  try {
    v = await one<RewardsPayload>(db, 'dash_market_rewards', { p_days: days, p_top: opts.top ?? 20 });
  } catch {
    return null;
  }
  if (!v) return null;
  return {
    series: v.series ?? [],
    latest: v.latest ?? null,
    topMarkets: v.topMarkets ?? [],
    days,
  };
}

// --- /sharps — SPORTS-leaderboard roster + per-trader fingerprints (dash_sharps, 0059) ---------------------

/** One odds-histogram bucket in a trader's fingerprint. */
export interface OddsHistogramBin {
  label: string;
  lo: number;
  hi: number;
  count: number;
  notionalUsd: number;
}

/** One SPORTS-sharp trader in the latest capture (rich row). */
export interface SharpTraderRow {
  rank: number | null;
  wallet: string;
  /** traderName when set, else wallet (already coalesced in the RPC). */
  trader: string;
  pnlAllUsd: unknown;
  volAllUsd: unknown;
  roiProxy: unknown;
  archetype: string | null;
  nFills: unknown;
  sweepFraction: unknown;
  midOddsFraction: unknown;
  vwapEntry: unknown;
  sportsMix: Record<string, number> | null;
  oddsHistogram: OddsHistogramBin[] | null;
}

/** Latest-capture meta for the /sharps page. */
export interface SportsSharpsLatest {
  capturedAt: string | null;
  nTraders: unknown;
}

export interface SportsSharpsView {
  latest: SportsSharpsLatest | null;
  roster: SharpTraderRow[];
}

interface SportsSharpsPayload {
  latest: SportsSharpsLatest | null;
  roster: SharpTraderRow[] | null;
}

/**
 * The SPORTS-sharps roster + fingerprints (dash_sharps, 0059) for /sharps. Returns null (not a thrown 500)
 * if the RPC errors — the page can deploy ahead of the 0059 RPC.
 */
export async function getSharps(
  db: WebDb,
  opts: { limit?: number } = {},
): Promise<SportsSharpsView | null> {
  try {
    const v = await one<SportsSharpsPayload>(db, 'dash_sharps', { p_limit: opts.limit ?? 20 });
    if (!v) return null;
    return {
      latest: v.latest ?? null,
      roster: v.roster ?? [],
    };
  } catch {
    return null;
  }
}

// --- /whaletracker — past-N-days ≥$min Polymarket whale trades (dash_whale_tracker, 0058) ------------------

/** One recorded ≥$min whale fill (rich row — profile link, bet link, what + value). */
export interface WhaleBetRow {
  tradedAt: string;
  proxyWallet: string;
  /** trader_name when present, else the proxy wallet (already coalesced in the RPC). */
  trader: string;
  side: string | null;
  outcome: string | null;
  title: string | null;
  notionalUsd: unknown;
  price: unknown;
  sizeShares: unknown;
  link: string | null;
  txHash: string;
  eventSlug: string | null;
}

/** One UTC-day aggregate for the daily-notional bar chart. */
export interface WhaleDailyRow {
  date: string;
  count: unknown;
  totalUsd: unknown;
}

export interface WhaleTrackerView {
  /** Individual bets in the window, newest first (capped at 500). */
  bets: WhaleBetRow[];
  /** Per-UTC-day notional + count, ascending. */
  daily: WhaleDailyRow[];
  /** Window meta — uncapped totals (independent of the 500-row bets cap). */
  meta: { days: number; minUsd: unknown; count: unknown; totalUsd: unknown };
}

interface WhaleTrackerPayload {
  bets: WhaleBetRow[] | null;
  daily: WhaleDailyRow[] | null;
  meta: WhaleTrackerView['meta'] | null;
}

/**
 * The Polymarket whale tracker (dash_whale_tracker, 0058) for /whaletracker. Window + min-USD are params so
 * the planned filter expansion is purely additive (DASHBOARDS-HANDOFF §3). Degrades to null (not a thrown 500)
 * if the RPC errors — the page can deploy ahead of the 0058 RPC.
 */
export async function getWhaleTracker(
  db: WebDb,
  opts: { days?: number; minUsd?: number } = {},
): Promise<WhaleTrackerView | null> {
  const days = opts.days ?? 10;
  const minUsd = opts.minUsd ?? 100_000;
  let v: WhaleTrackerPayload | null;
  try {
    v = await one<WhaleTrackerPayload>(db, 'dash_whale_tracker', { p_days: days, p_min_usd: minUsd });
  } catch {
    return null;
  }
  if (!v) return null;
  return {
    bets: v.bets ?? [],
    daily: v.daily ?? [],
    meta: v.meta ?? { days, minUsd, count: 0, totalUsd: 0 },
  };
}

// --- /data — forecast accuracy by market (dash_data, 0065) -------------------------------------------------

/** One forecast-horizon row of the headline table: our champion vs the market on the SAME matched events. */
export interface DataLeadRow {
  /** 0 = day-of, 1 = day-before, 2 = two-days-out. */
  lead: number;
  n: unknown;
  stations: unknown;
  /** Fractions (0..1) — page formats with fmtPct. */
  houseExact: unknown;
  houseWithin1: unknown;
  /** Mean whole-degree miss (|argmax − winner|, native unit). */
  houseMiss: unknown;
  marketExact: unknown;
  marketWithin1: unknown;
  marketMiss: unknown;
}

/** One per-station (market) row at the day-before lead — our accuracy + the market's, same events. */
export interface DataStationRow {
  city: string;
  region: string;
  n: unknown;
  exactPct: unknown;
  within1Pct: unknown;
  meanMiss: unknown;
  marketWithin1Pct: unknown;
  marketMeanMiss: unknown;
}

/** One day of the pooled forecast-vs-market Brier gap series (lead 1). */
export interface DataBrierPoint {
  date: string;
  nHouse: unknown;
  brierHouse: unknown;
  nMarket: unknown;
  brierMarket: unknown;
}

export interface DataAccuracyView {
  meta: {
    champion: string;
    /** The lead the per-station table is scored at (1 = day-before). */
    leadStation: unknown;
    generatedAt: string | null;
    /** Bucket-distribution window (first/last resolved target_date). */
    firstDay: string | null;
    lastDay: string | null;
    nStations: unknown;
  };
  byLead: DataLeadRow[];
  /** Ranked best→worst by mean miss (the RPC orders it; the page slices top/bottom). */
  byStation: DataStationRow[];
  brierSeries: DataBrierPoint[];
}

interface DataAccuracyPayload {
  meta: DataAccuracyView['meta'] | null;
  byLead: DataLeadRow[] | null;
  byStation: DataStationRow[] | null;
  brierSeries: DataBrierPoint[] | null;
}

/**
 * Forecast accuracy by market (dash_data, 0065) for /data. The champion's most-likely whole-°C bucket vs the
 * resolved high, scored at day-of / day-before / two-days-out, per station, against the market on the same
 * events — plus the daily Brier gap. Degrades to null (not a thrown 500) if the RPC errors, so the page can
 * deploy ahead of the 0065 RPC.
 */
export async function getDataAccuracy(db: WebDb): Promise<DataAccuracyView | null> {
  let v: DataAccuracyPayload | null;
  try {
    v = await one<DataAccuracyPayload>(db, 'dash_data', {});
  } catch {
    return null;
  }
  if (!v || !v.meta) return null;
  return {
    meta: v.meta,
    byLead: v.byLead ?? [],
    byStation: v.byStation ?? [],
    brierSeries: v.brierSeries ?? [],
  };
}

// --- /convergence — opening-convergence forward-paper overview (dash_convergence, 0069) ---------------------

/** The /convergence snapshot feed: the latest computed view + when the Edge tick produced it. */
export interface ConvergenceFeed {
  /** when the convergence-panel Edge tick produced the snapshot (null if none captured yet). */
  generatedAt: string | null;
  /** the computed view (entries / per-day / tuning / money tracker / gate); null until the first tick runs. */
  view: ConvergenceView | null;
}

interface ConvergencePayload {
  generatedAt: string | null;
  view: ConvergenceView | null;
}

/**
 * The opening-convergence forward-paper overview (dash_convergence, 0069) for /convergence. The page reads the
 * latest snapshot the convergence-panel Edge tick computed (the bracket-replay view: logged entries, exits,
 * per-day chances, the TP tuning sweep, the §9R-E gate, and the FICTIVE money tracker). Degrades to null (not a
 * thrown 500) if the RPC errors so the page can deploy ahead of the 0069 RPC.
 */
export async function getConvergence(db: WebDb): Promise<ConvergenceFeed | null> {
  let v: ConvergencePayload | null;
  try {
    v = await one<ConvergencePayload>(db, 'dash_convergence', {});
  } catch {
    return null;
  }
  if (!v) return null;
  return { generatedAt: v.generatedAt ?? null, view: v.view ?? null };
}

/** The persisted forward §9R-E verdict (the gate-of-record bot_deadman watches), surfaced in the page header. */
export interface MakerExitGateSnapshot {
  computedAt: string | null;
  label: string;
  nMarkets: number | null;
  nCities: number | null;
  nDistinctDays: number | null;
  winFrac: number | null;
  meanNetReturn: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  zeroSkillPassRate: number | null;
  makerExitFrac: number | null;
  realizedRebateUsd: number | null;
  totalNetUsd: number | null;
  nOpen: number | null;
  reason: string | null;
}

export interface MakerExitFeed {
  /** when the maker-exit-panel Edge tick produced the snapshot (null if none captured yet). */
  generatedAt: string | null;
  /** the computed view (entries / the three measured assumptions / money tracker / gate); null until the first tick. */
  view: MakerExitView | null;
  /** the latest persisted forward verdict row (separate from the in-view gate; null until the first gate write). */
  gateSnapshot: MakerExitGateSnapshot | null;
}

/**
 * The forward maker-exit paper loop (dash_maker_exit, 0073) for /maker-exit. The page reads the latest snapshot
 * the maker-exit-panel Edge tick computed (the maker-exit replay view: logged entries, the three measured
 * assumptions — maker-fill rate / realized rebate / days — the FICTIVE money tracker, and the §9R-E gate).
 * Degrades to null (not a thrown 500) if the RPC errors so the page can deploy ahead of the 0073 RPC.
 */
export async function getMakerExit(db: WebDb): Promise<MakerExitFeed | null> {
  let v: MakerExitFeed | null;
  try {
    v = await one<MakerExitFeed>(db, 'dash_maker_exit', {});
  } catch {
    return null;
  }
  if (!v) return null;
  return { generatedAt: v.generatedAt ?? null, view: v.view ?? null, gateSnapshot: v.gateSnapshot ?? null };
}

/**
 * One maker_exit_panel snapshot's assumption scalars at a point in time (dash_maker_exit_history, 0079). Every
 * scalar is nullable: a NaN assumption (no realized trades yet / a zero denominator per REWARD-INSTR-ROLLOUT.md)
 * round-trips as JSON null and MUST stay null here — the sparkline breaks its line at a null, never draws a zero.
 */
export interface MakerExitHistoryPoint {
  capturedAt: string;
  makerFillRate: number | null;
  meanMakerFillLatencyTicks: number | null;
  realizedRebateUsd: number | null;
  rebateRateUsed: number | null;
  meanObservedEntrySpread: number | null;
  meanObservedExitSpread: number | null;
  qualifyingTickFrac: number | null;
  nQualifyingRestingTicks: number | null;
  nRestingTicks: number | null;
  meanDistFromMidPp: number | null;
  fracWithinAdvertisedBand: number | null;
  fracFailsMinSize: number | null;
  dominantDisqualifier: string | null;
  nMarkets: number | null;
  nCities: number | null;
  nDistinctDays: number | null;
}

export interface MakerExitHistoryFeed {
  generatedAt: string | null;
  n: number;
  points: MakerExitHistoryPoint[];
}

/**
 * The /maker-exit "assumptions over time" trend (dash_maker_exit_history, 0079) — the last p_limit maker_exit_panel
 * snapshots' three measured assumptions (+ the v2 WHY fields) as an ascending (oldest→newest) time series, so the
 * page can draw small-multiple sparklines above tile #4. STAGE-DARK safe: if the 0079 RPC is not deployed yet the
 * call throws → we return null → the page renders exactly its current behaviour (no sparklines), never a 500.
 */
export async function getMakerExitHistory(db: WebDb, limit = 200): Promise<MakerExitHistoryFeed | null> {
  let v: MakerExitHistoryFeed | null;
  try {
    v = await one<MakerExitHistoryFeed>(db, 'dash_maker_exit_history', { p_limit: limit });
  } catch {
    return null;
  }
  if (!v || !Array.isArray(v.points)) return null;
  return { generatedAt: v.generatedAt ?? null, n: v.n ?? v.points.length, points: v.points };
}
