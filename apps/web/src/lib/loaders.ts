/**
 * RSC data loaders (§6.21) — one 0022 dash_* RPC round trip per page, plus
 * the derived view-models the pages need (exposure summary via core,
 * EdgeChart display recompute, goLiveGate readout). Framework-free: every
 * loader takes the WebDb port, so the PGlite suite drives the REAL loaders;
 * pages bind serverDb() from supabase.ts.
 */
import { exposureSummary, parseConfigRows } from '@weather-edge/core';
import type { AppConfig, EdgeRow } from '@weather-edge/core';
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
