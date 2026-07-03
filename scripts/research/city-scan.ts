/**
 * scripts/research/city-scan — SIGNAL-BACKLOG.md #12 CITY-SCAN: historical city-sim replay across all
 * 45 cities × entry hours 9..19 local, pre-registered 2026-07-03 ~21:10 (see SIGNAL-BACKLOG.md "## 12.
 * CITY-SCAN" for the full rationale). Locked design, implemented verbatim.
 *
 * ANALYTICS SELECTION study, NOT a capital gate: replay the city-sim $10/day predicted-bucket taker bet
 * historically across every city × entry hour, to (a) shortlist "another Karachi" candidates for live
 * paper-trade enrollment and (b) map the entry-hour pattern. Honest prior: mechanism-A pooled efficiency
 * (KILL-GATE 2 + 5 confirmations) says the POOLED result should be ≈0; the question is per-city/per-hour
 * heterogeneity, which only live forward data can confirm. This script REPORTS RAW NUMBERS — ranking and
 * tabulating, but never declaring a city "tradable" or issuing a GO/KILL call (the orchestrator adjudicates).
 *
 * DATA: the local maker-exit cache (`loadCache` from ./sim-maker-exit.ts — 844 ev / 45 c / 21 d tick
 * series with REAL bestAsk quotes + resolved winners) + ONE DB pull of `bucket_probabilities`
 * (source='house_gaussian', seeded=false — the production, non-bot-seeded blend) for the cache's event
 * ids, mirroring item6-crosshorizon.ts's "latest build strictly before T" recovery pattern. The cache's
 * OWN baked-in houseProb is a single FROZEN early-snapshot seed (tune-convergence.ts's `loadPanel` picks
 * `order by made_at asc limit 1`) — constant across every tick of an event — so it is NOT point-in-time
 * correct for a bet placed hours later. This script instead recovers, per bet, the latest non-seeded
 * house_gaussian build strictly BEFORE the entry tick; when the DB has no such build for an event (e.g.
 * pruned by the 30-day retention, 0009_cron.sql §7.12) it falls back to the cache's frozen seed and COUNTS
 * how often that happened (reported, not hidden).
 *
 * BET RULE (mirrors the live city-sim, scripts/city-sim.ts + core/sim/amsterdam.ts): at the first
 * captured tick at-or-after H:00 local (city tz, H ∈ {9..19}), take the forecast-mode bucket (argmax of
 * the recovered distribution), read its REAL bestAsk at that tick (the same top-of-book field city-sim's
 * SQL reads via `ms.best_ask`); skip if no ask, ask > 0.95, or the market already resolved by that tick.
 * Stake $10 (AMSTERDAM_SIM_STAKE_USD), fee via `gradeSimBet` (core/sim/amsterdam.ts) — the EXACT engine
 * P&L math (shares·(1−ask) net of the taker fee on a win, −stake net of fee on a loss) — at the taker fee
 * rate the whole system uses for these markets, BOT_DEFAULTS.takerFeeRate (0.05 = weather_fees 5%).
 *
 * MULTIPLICITY CONTROL (the point): TRAIN = target_date ≤ 2026-06-24, TEST = ≥ 2026-06-25. Selection is
 * ONLY on TRAIN — city×arm cells ranked by the entry-watch shrinkage lower bound, reusing
 * `recommendEntryHour`/`WatchedArm.score` from core/sim/entry-watch.ts VERBATIM (score = armEdgeStats'
 * edgeCiLo, the same conservative-lower-bound discipline the live paper-trade watcher uses). The top-5
 * TRAIN cells are then confirmed on TEST ONLY (n, net PnL, win rate, per-bet CI via armEdgeStats, AND the
 * day-clustered CI via `clusterMeanTCi` from core/sim/selector-learn.ts). Everything else is descriptive.
 *
 * Read-only: reads the DB (bucket_probabilities) + the local cache; writes nothing. Places nothing, never
 * imports packages/trading.
 *
 * Run: pnpm tsx scripts/research/city-scan.ts [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadCache } from './sim-maker-exit.ts';
import type { EventReplayInput, ReplayTick } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import { BOT_DEFAULTS } from '../../packages/core/src/sim/opening-convergence.ts';
import { AMSTERDAM_SIM_STAKE_USD, gradeSimBet, type SimPlacement } from '../../packages/core/src/sim/amsterdam.ts';
import { armEdgeStats, quantileSorted, type GradedBet } from '../../packages/core/src/sim/stats.ts';
import { clusterMeanTCi, type Ci } from '../../packages/core/src/sim/selector-learn.ts';
import { recommendEntryHour, type ArmGradedBets, type WatchedArm } from '../../packages/core/src/sim/entry-watch.ts';
import { localHourInstant } from '../../packages/core/src/time.ts';
import { makeScriptDb, type ScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'city-scan';

// =====================================================================================
// PRE-REGISTERED CONFIG (locked — do not move to fit a result)
// =====================================================================================
export const ARM_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19] as const;
export const TRAIN_LAST_DATE = '2026-06-24';
export const TEST_FIRST_DATE = '2026-06-25';
export const MAX_ENTRY_ASK = 0.95;
/** BOT_DEFAULTS.takerFeeRate = 0.05 — the weather_fees 5% taker rate the whole system uses (reused, not re-derived). */
const FEE_RATE = BOT_DEFAULTS.takerFeeRate;
/** AMSTERDAM_SIM_STAKE_USD = 10 — the live city-sim's fixed $10/day stake (reused, not re-derived). */
const STAKE_USD = AMSTERDAM_SIM_STAKE_USD;

const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));

// =====================================================================================
// PURE HELPERS (no DB / no cache access — the testable core)
// =====================================================================================

/** idx of the max finite `p`; ties broken by the LOWEST idx (deterministic). null if no finite value. Pure. */
export function argmaxIdx(pairs: Array<{ idx: number; p: number | null | undefined }>): number | null {
  let best: number | null = null;
  let bestP = Number.NEGATIVE_INFINITY;
  for (const { idx, p } of [...pairs].sort((a, b) => a.idx - b.idx)) {
    if (fin(p) && (p as number) > bestP) {
      bestP = p as number;
      best = idx;
    }
  }
  return best;
}

/** One recovered house_gaussian build, aligned to bucket_idx (probs[i] = P(bucket i)). */
export interface HouseBuild {
  madeAtMs: number;
  probs: number[];
}

/** Group + sort raw DB rows into one ascending-by-madeAtMs series per event (keyed by poly_event_id). Pure. */
export function groupHouseSeries(rows: Array<{ eventId: string; madeAtMs: number; probs: number[] }>): Map<string, HouseBuild[]> {
  const byEvent = new Map<string, HouseBuild[]>();
  for (const r of rows) {
    if (!fin(r.madeAtMs)) continue;
    const arr = byEvent.get(r.eventId) ?? [];
    arr.push({ madeAtMs: r.madeAtMs, probs: r.probs });
    byEvent.set(r.eventId, arr);
  }
  for (const arr of byEvent.values()) arr.sort((a, b) => a.madeAtMs - b.madeAtMs);
  return byEvent;
}

/** The latest build strictly BEFORE tMs (builds pre-sorted ascending by madeAtMs). null if none qualifies. Pure. */
export function latestBuildBefore(builds: HouseBuild[], tMs: number): HouseBuild | null {
  let best: HouseBuild | null = null;
  for (const b of builds) {
    if (b.madeAtMs < tMs) best = b;
    else break;
  }
  return best;
}

/** First tick with capturedAt >= thresholdMs (ticks pre-sorted ascending per EventReplayInput's contract). Pure. */
export function firstTickAtOrAfter(ticks: ReplayTick[], thresholdMs: number): ReplayTick | null {
  for (const t of ticks) {
    if (new Date(t.capturedAt).getTime() >= thresholdMs) return t;
  }
  return null;
}

export type SkipReason =
  | 'bad_tz'
  | 'no_resolution'
  | 'grading_mismatch'
  | 'no_tick'
  | 'resolved_before_ask'
  | 'no_distribution'
  | 'no_ask'
  | 'ask_too_high';

/** One graded (or skipped) city-scan bet — the atomic unit every table below aggregates. */
export interface CityScanBet {
  eventId: string;
  city: string;
  targetDate: string;
  arm: number;
  ask: number;
  won: boolean;
  netPnlUsd: number;
  netReturn: number;
  /** the forecast-mode bucket's probability in the distribution actually used (DB-recovered or fallback). */
  confidence: number;
  usedFallback: boolean;
}

export type ArmOutcome = { status: 'bet'; bet: CityScanBet } | { status: 'skip'; reason: SkipReason };

/**
 * Evaluate ONE (event, arm hour) cell against the locked bet rule. Pure, total. Order of checks: data
 * availability (resolution) → local-hour math → the qualifying tick → "already resolved" → forecast
 * recovery (DB build, else the cache's frozen seed — counted) → the ask gate. Reuses `gradeSimBet`
 * (core/sim/amsterdam.ts) for the P&L — never re-derives the fee/payout formula.
 */
export function evaluateArm(
  event: EventReplayInput,
  arm: number,
  resolvesAtMs: number | null,
  houseSeries: HouseBuild[] | undefined,
): ArmOutcome {
  const { winnerIdx, gradingMismatch } = event.resolution;
  if (winnerIdx == null) return { status: 'skip', reason: 'no_resolution' };
  if (gradingMismatch) return { status: 'skip', reason: 'grading_mismatch' };

  let thresholdMs: number;
  try {
    thresholdMs = localHourInstant(event.tz, event.targetDate, arm).getTime();
  } catch {
    return { status: 'skip', reason: 'bad_tz' };
  }

  const tick = firstTickAtOrAfter(event.ticks, thresholdMs);
  if (!tick) return { status: 'skip', reason: 'no_tick' };
  const tickMs = new Date(tick.capturedAt).getTime();
  if (resolvesAtMs != null && tickMs >= resolvesAtMs) return { status: 'skip', reason: 'resolved_before_ask' };

  // forecast recovery: the latest non-seeded house_gaussian DB build strictly before this tick; fall back
  // to the cache's own frozen seed (tick.buckets[i].houseProb, bucket-idx aligned) if none exists.
  let probsByIdx: Map<number, number>;
  let usedFallback = false;
  const build = houseSeries ? latestBuildBefore(houseSeries, tickMs) : null;
  if (build) {
    probsByIdx = new Map(build.probs.map((p, i): [number, number] => [i, Number(p)]).filter(([, p]) => fin(p)));
  } else {
    usedFallback = true;
    probsByIdx = new Map(tick.buckets.filter((b) => fin(b.houseProb)).map((b) => [b.idx, b.houseProb as number]));
  }
  if (probsByIdx.size === 0) return { status: 'skip', reason: 'no_distribution' };

  const modeIdx = argmaxIdx([...probsByIdx.entries()].map(([idx, p]) => ({ idx, p })));
  if (modeIdx == null) return { status: 'skip', reason: 'no_distribution' };

  const bucket = tick.buckets.find((b) => b.idx === modeIdx);
  const ask = bucket?.bestAsk;
  if (!fin(ask) || (ask as number) <= 0) return { status: 'skip', reason: 'no_ask' };
  if ((ask as number) > MAX_ENTRY_ASK) return { status: 'skip', reason: 'ask_too_high' };

  const shares = STAKE_USD / (ask as number);
  const placement: SimPlacement = {
    predictedNativeC: NaN, // unused by gradeSimBet — only ask/shares/feeRate/bucketIdx/stakeUsd are read.
    bucketIdx: modeIdx,
    ask: ask as number,
    stakeUsd: STAKE_USD,
    shares,
    feeRate: FEE_RATE,
  };
  const grade = gradeSimBet(placement, winnerIdx);

  return {
    status: 'bet',
    bet: {
      eventId: event.eventId,
      city: event.city,
      targetDate: event.targetDate,
      arm,
      ask: ask as number,
      won: grade.won,
      netPnlUsd: grade.pnlUsd,
      netReturn: grade.pnlUsd / STAKE_USD,
      confidence: probsByIdx.get(modeIdx) as number,
      usedFallback,
    },
  };
}

export interface ScanResult {
  bets: CityScanBet[];
  skipCounts: Partial<Record<SkipReason, number>>;
  nFallback: number;
  nDbRecovered: number;
}

/** Replay every (event, arm) cell in the panel. Pure given its inputs (the DB pull + cache are impure callers). */
export function scanEvents(
  events: EventReplayInput[],
  resolves: Map<string, number | null>,
  houseSeriesByEvent: Map<string, HouseBuild[]>,
): ScanResult {
  const bets: CityScanBet[] = [];
  const skipCounts: Partial<Record<SkipReason, number>> = {};
  let nFallback = 0;
  let nDbRecovered = 0;
  for (const event of events) {
    const resolvesAtMs = resolves.get(event.eventId) ?? null;
    const series = houseSeriesByEvent.get(event.eventId);
    for (const arm of ARM_HOURS) {
      const out = evaluateArm(event, arm, resolvesAtMs, series);
      if (out.status === 'skip') {
        skipCounts[out.reason] = (skipCounts[out.reason] ?? 0) + 1;
        continue;
      }
      bets.push(out.bet);
      if (out.bet.usedFallback) nFallback++;
      else nDbRecovered++;
    }
  }
  return { bets, skipCounts, nFallback, nDbRecovered };
}

const isTrain = (targetDate: string): boolean => targetDate <= TRAIN_LAST_DATE;
const isTest = (targetDate: string): boolean => targetDate >= TEST_FIRST_DATE;

// =====================================================================================
// SELECTION (TRAIN only) — reuse core/sim/entry-watch.ts's LB (WatchedArm.score = edgeCiLo) VERBATIM
// =====================================================================================

export interface RankedCell {
  city: string;
  arm: number;
  watched: WatchedArm;
  netUsd: number;
}

/** Rank every city×arm TRAIN cell by the entry-watch shrinkage lower bound. Pure given `bets`. */
export function rankTrainCells(bets: CityScanBet[]): RankedCell[] {
  const trainBets = bets.filter((b) => isTrain(b.targetDate));
  const cities = [...new Set(trainBets.map((b) => b.city))].sort();
  const out: RankedCell[] = [];
  for (const city of cities) {
    const cityBets = trainBets.filter((b) => b.city === city);
    const arms: ArmGradedBets[] = ARM_HOURS.map((h) => ({
      hour: h,
      bets: cityBets.filter((b) => b.arm === h).map((b): GradedBet => ({ won: b.won, ask: b.ask })),
    }));
    const watch = recommendEntryHour(arms);
    for (const w of watch.arms) {
      if (!Number.isFinite(w.score)) continue;
      const cellBets = cityBets.filter((b) => b.arm === w.hour);
      const netUsd = cellBets.reduce((s, b) => s + b.netPnlUsd, 0);
      out.push({ city, arm: w.hour, watched: w, netUsd });
    }
  }
  return out.sort((a, b) => b.watched.score - a.watched.score || a.city.localeCompare(b.city) || a.arm - b.arm);
}

export interface TestConfirmRow {
  city: string;
  arm: number;
  n: number;
  netUsd: number;
  winRate: number;
  perBetCi: { edge: number; lo: number; hi: number };
  clustered: Ci;
  nClusters: number;
}

/** Confirm the given TRAIN-selected cells on TEST ONLY. Pure given `bets`. */
export function confirmOnTest(bets: CityScanBet[], cells: Array<{ city: string; arm: number }>): TestConfirmRow[] {
  const testBets = bets.filter((b) => isTest(b.targetDate));
  return cells.map(({ city, arm }) => {
    const cell = testBets.filter((b) => b.city === city && b.arm === arm);
    const graded: GradedBet[] = cell.map((b) => ({ won: b.won, ask: b.ask }));
    const stats = armEdgeStats(graded);
    const edgeVals = cell.map((b) => (b.won ? 1 : 0) - b.ask);
    const clusters = cell.map((b) => b.targetDate);
    const clustered = clusterMeanTCi(edgeVals, clusters);
    const netUsd = cell.reduce((s, b) => s + b.netPnlUsd, 0);
    const winRate = cell.length ? cell.filter((b) => b.won).length / cell.length : NaN;
    return {
      city,
      arm,
      n: cell.length,
      netUsd,
      winRate,
      perBetCi: { edge: stats.edge, lo: stats.edgeCiLo, hi: stats.edgeCiHi },
      clustered,
      nClusters: new Set(clusters).size,
    };
  });
}

// =====================================================================================
// DESCRIPTIVE (pooled, both TRAIN+TEST) — the pattern read
// =====================================================================================

export interface ArmCurveRow {
  arm: number;
  n: number;
  netUsd: number;
  roi: number;
  winRate: number;
  meanAsk: number;
  clusteredRoi: Ci;
}

export function armCurve(bets: CityScanBet[]): ArmCurveRow[] {
  return ARM_HOURS.map((h) => {
    const cell = bets.filter((b) => b.arm === h);
    const n = cell.length;
    const netUsd = cell.reduce((s, b) => s + b.netPnlUsd, 0);
    const roi = n ? netUsd / (n * STAKE_USD) : NaN;
    const winRate = n ? cell.filter((b) => b.won).length / n : NaN;
    const meanAsk = n ? cell.reduce((s, b) => s + b.ask, 0) / n : NaN;
    const clusteredRoi = clusterMeanTCi(
      cell.map((b) => b.netReturn),
      cell.map((b) => b.targetDate),
    );
    return { arm: h, n, netUsd, roi, winRate, meanAsk, clusteredRoi };
  });
}

export function winnerLoserAsk(bets: CityScanBet[]): { winMeanAsk: number; loseMeanAsk: number; nWon: number; nLost: number } {
  const won = bets.filter((b) => b.won);
  const lost = bets.filter((b) => !b.won);
  const mean = (arr: CityScanBet[]): number => (arr.length ? arr.reduce((s, b) => s + b.ask, 0) / arr.length : NaN);
  return { winMeanAsk: mean(won), loseMeanAsk: mean(lost), nWon: won.length, nLost: lost.length };
}

export interface TercileRow {
  tercile: 'low' | 'mid' | 'high';
  n: number;
  netUsd: number;
  roi: number;
  winRate: number;
  confRange: [number, number];
}

/** Split the pooled bet set into confidence terciles (mode probability of the distribution actually used). */
export function confidenceTerciles(bets: CityScanBet[]): TercileRow[] {
  if (bets.length === 0) return [];
  const sorted = [...bets].sort((a, b) => a.confidence - b.confidence);
  const confs = sorted.map((b) => b.confidence);
  const q1 = quantileSorted(confs, 1 / 3);
  const q2 = quantileSorted(confs, 2 / 3);
  const groups: Record<'low' | 'mid' | 'high', CityScanBet[]> = { low: [], mid: [], high: [] };
  for (const b of sorted) {
    if (b.confidence <= q1) groups.low.push(b);
    else if (b.confidence <= q2) groups.mid.push(b);
    else groups.high.push(b);
  }
  return (['low', 'mid', 'high'] as const).map((k) => {
    const arr = groups[k];
    const n = arr.length;
    const netUsd = arr.reduce((s, b) => s + b.netPnlUsd, 0);
    const roi = n ? netUsd / (n * STAKE_USD) : NaN;
    const winRate = n ? arr.filter((b) => b.won).length / n : NaN;
    const confRange: [number, number] = n
      ? [Math.min(...arr.map((b) => b.confidence)), Math.max(...arr.map((b) => b.confidence))]
      : [NaN, NaN];
    return { tercile: k, n, netUsd, roi, winRate, confRange };
  });
}

export interface PerCityRow {
  city: string;
  bestArm: number | null;
  trainN: number;
  trainNet: number;
  trainLb: number;
  testN: number;
  testNet: number;
}

/** Per-city best-TRAIN-arm summary, ALL cities present in the panel (even those with zero TRAIN bets). */
export function perCityTable(ranked: RankedCell[], bets: CityScanBet[], allCities: string[]): PerCityRow[] {
  const byCity = new Map<string, RankedCell>();
  for (const r of ranked) {
    const cur = byCity.get(r.city);
    if (!cur || r.watched.score > cur.watched.score) byCity.set(r.city, r);
  }
  const testBets = bets.filter((b) => isTest(b.targetDate));
  const out: PerCityRow[] = allCities.map((city) => {
    const r = byCity.get(city);
    if (!r) {
      const anyTest = testBets.filter((b) => b.city === city);
      return { city, bestArm: null, trainN: 0, trainNet: 0, trainLb: NaN, testN: anyTest.length, testNet: anyTest.reduce((s, b) => s + b.netPnlUsd, 0) };
    }
    const testCell = testBets.filter((b) => b.city === city && b.arm === r.arm);
    return {
      city,
      bestArm: r.arm,
      trainN: r.watched.nGraded,
      trainNet: r.netUsd,
      trainLb: r.watched.score,
      testN: testCell.length,
      testNet: testCell.reduce((s, b) => s + b.netPnlUsd, 0),
    };
  });
  out.sort((a, b) => {
    const av = Number.isFinite(a.trainLb) ? a.trainLb : Number.NEGATIVE_INFINITY;
    const bv = Number.isFinite(b.trainLb) ? b.trainLb : Number.NEGATIVE_INFINITY;
    return bv - av;
  });
  return out;
}

// =====================================================================================
// DB PULL (ONE statement, bounded to the cache's event ids — indexed on event_id/source/made_at)
// =====================================================================================

interface RawHouseRow {
  event_id: string;
  made_at: string;
  probs: unknown;
}

/** ONE cheap pull: every non-seeded house_gaussian build for the cache's events (poly_event_id → market_events.id). */
export async function pullHouseSeries(db: ScriptDb, eventIds: string[]): Promise<Map<string, HouseBuild[]>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db.query<RawHouseRow>(
    `select me.poly_event_id as event_id, bp.made_at, bp.probs
       from public.market_events me
       join public.bucket_probabilities bp on bp.event_id = me.id
      where me.poly_event_id = any($1::text[])
        and bp.source = 'house_gaussian'
        and coalesce(bp.seeded, false) = false
      order by me.poly_event_id, bp.made_at asc`,
    [eventIds],
  );
  const parsed = rows
    .filter((r) => Array.isArray(r.probs))
    .map((r) => ({
      eventId: r.event_id,
      madeAtMs: new Date(r.made_at).getTime(),
      probs: (r.probs as unknown[]).map(Number),
    }));
  return groupHouseSeries(parsed);
}

// =====================================================================================
// REPORT
// =====================================================================================

const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const pp = (v: number, d = 1): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}pp` : '—');
const usd = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}` : '—');
const num3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '—');

export function report(
  scan: ScanResult,
  ranked: RankedCell[],
  testRows: TestConfirmRow[],
  curve: ArmCurveRow[],
  wlAsk: { winMeanAsk: number; loseMeanAsk: number; nWon: number; nLost: number },
  terciles: TercileRow[],
  perCity: PerCityRow[],
  meta: { cacheMeta: string; nEvents: number; nDbRows: number; nDbEvents: number },
  log: (m: string) => void,
): void {
  log(`=== ${SCRIPT} — SIGNAL-BACKLOG.md #12 (analytics selection study, NOT a capital gate) ===`);
  log(`  cache: ${meta.cacheMeta}`);
  log(`  DB pull: ${meta.nDbRows} non-seeded house_gaussian rows across ${meta.nDbEvents} events`);
  log(`  bets entered: ${scan.bets.length} (DB-recovered forecast: ${scan.nDbRecovered}, fallback-to-cache-seed: ${scan.nFallback})`);
  log(`  skip breakdown: ${JSON.stringify(scan.skipCounts)}`);
  log('');

  log('--- (b) TOP-20 TRAIN cells by entry-watch shrinkage LB (score = armEdgeStats.edgeCiLo) ---');
  log(`  ${'city'.padEnd(16)}${'arm'.padStart(5)}${'n'.padStart(6)}${'net'.padStart(10)}${'winRate'.padStart(9)}${'edge'.padStart(9)}${'LB(score)'.padStart(11)}${'edgeHi'.padStart(9)}`);
  for (const r of ranked.slice(0, 20)) {
    log(
      `  ${r.city.padEnd(16)}${String(r.arm).padStart(4)}h${String(r.watched.nGraded).padStart(6)}${usd(r.netUsd).padStart(10)}` +
        `${pct(r.watched.hitRate).padStart(9)}${pp(r.watched.edge).padStart(9)}${pp(r.watched.score).padStart(11)}${pp(r.watched.edgeCiHi).padStart(9)}`,
    );
  }
  log('');

  log('--- (c) TOP-5 TRAIN cells, confirmed on TEST ONLY ---');
  log(`  ${'city'.padEnd(16)}${'arm'.padStart(5)}${'n'.padStart(6)}${'net'.padStart(10)}${'winRate'.padStart(9)}${'perBetEdgeCI'.padStart(24)}${'dayClusterCI'.padStart(24)}${'clusters'.padStart(9)}`);
  for (const r of testRows) {
    log(
      `  ${r.city.padEnd(16)}${String(r.arm).padStart(4)}h${String(r.n).padStart(6)}${usd(r.netUsd).padStart(10)}${pct(r.winRate).padStart(9)}` +
        `${`[${pp(r.perBetCi.lo)},${pp(r.perBetCi.hi)}]`.padStart(24)}${`[${pp(r.clustered.lo)},${pp(r.clustered.hi)}]`.padStart(24)}${String(r.nClusters).padStart(9)}`,
    );
  }
  log('');

  log('--- (d) POOLED arm-hour curve (all 45 cities, TRAIN+TEST, descriptive) ---');
  log(`  ${'arm'.padStart(5)}${'n'.padStart(7)}${'net'.padStart(10)}${'ROI'.padStart(8)}${'winRate'.padStart(9)}${'meanAsk'.padStart(9)}${'dayClusterROI-CI'.padStart(24)}`);
  for (const r of curve) {
    log(
      `  ${String(r.arm).padStart(4)}h${String(r.n).padStart(7)}${usd(r.netUsd).padStart(10)}${pp(r.roi).padStart(8)}` +
        `${pct(r.winRate).padStart(9)}${num3(r.meanAsk).padStart(9)}${`[${pp(r.clusteredRoi.lo)},${pp(r.clusteredRoi.hi)}]`.padStart(24)}`,
    );
  }
  log('');

  log('--- (f) descriptive splits ---');
  log(`  entry ask, winners vs losers (pooled): win mean ${num3(wlAsk.winMeanAsk)} (n=${wlAsk.nWon}) vs lose mean ${num3(wlAsk.loseMeanAsk)} (n=${wlAsk.nLost})`);
  log(`  ${'tercile'.padEnd(8)}${'confRange'.padStart(16)}${'n'.padStart(7)}${'net'.padStart(10)}${'ROI'.padStart(8)}${'winRate'.padStart(9)}`);
  for (const t of terciles) {
    log(
      `  ${t.tercile.padEnd(8)}${`[${num3(t.confRange[0])},${num3(t.confRange[1])}]`.padStart(16)}${String(t.n).padStart(7)}` +
        `${usd(t.netUsd).padStart(10)}${pp(t.roi).padStart(8)}${pct(t.winRate).padStart(9)}`,
    );
  }
  log('');

  log('--- (e) per-city best-TRAIN-arm table (all cities, sorted by TRAIN LB) ---');
  log(`  ${'city'.padEnd(16)}${'bestArm'.padStart(8)}${'trainN'.padStart(8)}${'trainNet'.padStart(10)}${'trainLB'.padStart(9)}${'testN'.padStart(7)}${'testNet'.padStart(10)}`);
  for (const r of perCity) {
    log(
      `  ${r.city.padEnd(16)}${(r.bestArm == null ? '—' : `${r.bestArm}h`).padStart(8)}${String(r.trainN).padStart(8)}` +
        `${usd(r.trainNet).padStart(10)}${pp(r.trainLb).padStart(9)}${String(r.testN).padStart(7)}${usd(r.testNet).padStart(10)}`,
    );
  }
  log('');
  log('  (RAW NUMBERS ONLY — no tradability / GO-KILL call made here; the orchestrator adjudicates.)');
}

// =====================================================================================
// SELF-TEST (no DB/network — mirrors item6-crosshorizon.ts's sanity() pattern)
// =====================================================================================

function sanity(): void {
  // argmaxIdx: tie-break lowest idx, ignores non-finite.
  if (argmaxIdx([{ idx: 2, p: 0.3 }, { idx: 0, p: 0.5 }, { idx: 1, p: 0.5 }]) !== 0) throw new Error('sanity: argmaxIdx tie-break');
  if (argmaxIdx([{ idx: 0, p: null }, { idx: 1, p: NaN }]) !== null) throw new Error('sanity: argmaxIdx all-junk -> null');

  // latestBuildBefore: strictly-before semantics.
  const builds: HouseBuild[] = [
    { madeAtMs: 1000, probs: [0.1, 0.9] },
    { madeAtMs: 2000, probs: [0.2, 0.8] },
    { madeAtMs: 3000, probs: [0.3, 0.7] },
  ];
  if (latestBuildBefore(builds, 2000)?.madeAtMs !== 1000) throw new Error('sanity: latestBuildBefore strictly-before');
  if (latestBuildBefore(builds, 2001)?.madeAtMs !== 2000) throw new Error('sanity: latestBuildBefore boundary');
  if (latestBuildBefore(builds, 500) !== null) throw new Error('sanity: latestBuildBefore none-qualify');

  // firstTickAtOrAfter
  const ticks: ReplayTick[] = [
    { capturedAt: '2026-06-01T09:00:00.000Z', buckets: [], tz: 'UTC', targetDate: '2026-06-01', hoursSinceListing: 1 },
    { capturedAt: '2026-06-01T10:00:00.000Z', buckets: [], tz: 'UTC', targetDate: '2026-06-01', hoursSinceListing: 2 },
  ];
  if (firstTickAtOrAfter(ticks, new Date('2026-06-01T09:30:00.000Z').getTime())?.capturedAt !== '2026-06-01T10:00:00.000Z') {
    throw new Error('sanity: firstTickAtOrAfter');
  }
  if (firstTickAtOrAfter(ticks, new Date('2026-06-01T11:00:00.000Z').getTime()) !== null) throw new Error('sanity: firstTickAtOrAfter none');

  // evaluateArm end-to-end, hand-computed single-bet fixture (no DB series -> fallback path).
  // ask=0.20 -> shares=50; fee = 0.05 * 0.20*0.80 * 50 = 0.4; win -> pnl = 50*0.80 - 0.4 = 39.6; netReturn = 3.96.
  const fixtureTick: ReplayTick = {
    capturedAt: '2026-06-01T09:05:00.000Z',
    tz: 'UTC',
    targetDate: '2026-06-01',
    hoursSinceListing: 1,
    buckets: [
      { idx: 0, label: 'a', loF: null, hiF: null, mid: 0.2, bestAsk: 0.2, execAsk: 0.21, depthUsd: 100, bestBid: 0.18, sellbackUsd: 100, execBid: 0.17, sellbackDepthUsd: 100, houseProb: 0.6, tokenYes: '', tokenNo: '', conditionId: '' },
      { idx: 1, label: 'b', loF: null, hiF: null, mid: 0.4, bestAsk: 0.4, execAsk: 0.41, depthUsd: 100, bestBid: 0.38, sellbackUsd: 100, execBid: 0.37, sellbackDepthUsd: 100, houseProb: 0.4, tokenYes: '', tokenNo: '', conditionId: '' },
    ],
  };
  const fixtureEvent: EventReplayInput = {
    eventId: 'fixture-1',
    city: 'testcity',
    targetDate: '2026-06-01',
    tz: 'UTC',
    ticks: [fixtureTick],
    resolution: { winnerIdx: 0, gradingMismatch: false },
  };
  const out = evaluateArm(fixtureEvent, 9, null, undefined);
  if (out.status !== 'bet') throw new Error(`sanity: evaluateArm fixture should enter a bet, got ${JSON.stringify(out)}`);
  const expectedShares = 10 / 0.2;
  const expectedFee = FEE_RATE * 0.2 * 0.8 * expectedShares;
  const expectedPnl = expectedShares * 0.8 - expectedFee;
  if (Math.abs(out.bet.netPnlUsd - expectedPnl) > 1e-9) {
    throw new Error(`sanity: evaluateArm fixture pnl mismatch — got ${out.bet.netPnlUsd}, expected ${expectedPnl}`);
  }
  if (!out.bet.usedFallback) throw new Error('sanity: fixture had no DB series — must report usedFallback=true');
  if (out.bet.ask !== 0.2 || !out.bet.won) throw new Error('sanity: fixture ask/won mismatch');
  process.stderr.write(
    `  sanity OK — hand-computed fixture: ask=0.20 won=true -> netPnlUsd=${out.bet.netPnlUsd.toFixed(4)} ` +
      `(expected ${expectedPnl.toFixed(4)}), netReturn=${out.bet.netReturn.toFixed(4)}\n`,
  );

  // a resolved-before-ask tick must skip, not bet.
  const resolvedOut = evaluateArm(fixtureEvent, 9, new Date('2026-06-01T09:00:00.000Z').getTime(), undefined);
  if (resolvedOut.status !== 'skip' || resolvedOut.reason !== 'resolved_before_ask') throw new Error('sanity: resolved_before_ask gate wrong');

  // an unresolved event must skip, never bet.
  const unresolvedOut = evaluateArm({ ...fixtureEvent, resolution: { winnerIdx: null, gradingMismatch: false } }, 9, null, undefined);
  if (unresolvedOut.status !== 'skip' || unresolvedOut.reason !== 'no_resolution') throw new Error('sanity: no_resolution gate wrong');

  // confidenceTerciles / armCurve on a tiny synthetic set — just check they run + total n is conserved.
  const synthBets: CityScanBet[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    eventId: `e${i}`, city: 'x', targetDate: '2026-06-0' + (1 + (i % 3)), arm: 9 + (i % 2),
    ask: 0.1 + i * 0.05, won: i % 2 === 0, netPnlUsd: i % 2 === 0 ? 5 : -10, netReturn: i % 2 === 0 ? 0.5 : -1,
    confidence: 0.3 + i * 0.1, usedFallback: false,
  }));
  const terc = confidenceTerciles(synthBets);
  if (terc.reduce((s, t) => s + t.n, 0) !== synthBets.length) throw new Error('sanity: confidenceTerciles n conservation');
  const curveTest = armCurve(synthBets);
  if (curveTest.reduce((s, c) => s + c.n, 0) !== synthBets.length) throw new Error('sanity: armCurve n conservation');
}

// =====================================================================================
// CLI
// =====================================================================================
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({ options: { json: { type: 'boolean' } } });

  const db = makeScriptDb();
  try {
    const { events, resolves, meta: cacheMeta } = loadCache();
    const eventIds = events.map((e) => e.eventId);
    const houseSeries = await pullHouseSeries(db, eventIds);
    const nDbRows = [...houseSeries.values()].reduce((s, arr) => s + arr.length, 0);

    const scan = scanEvents(events, resolves, houseSeries);
    const ranked = rankTrainCells(scan.bets);
    const top5 = ranked.slice(0, 5).map((r) => ({ city: r.city, arm: r.arm }));
    const testRows = confirmOnTest(scan.bets, top5);
    const curve = armCurve(scan.bets);
    const wlAsk = winnerLoserAsk(scan.bets);
    const terciles = confidenceTerciles(scan.bets);
    const allCities = [...new Set(events.map((e) => e.city))].sort();
    const perCity = perCityTable(ranked, scan.bets, allCities);

    report(
      scan, ranked, testRows, curve, wlAsk, terciles, perCity,
      { cacheMeta, nEvents: events.length, nDbRows, nDbEvents: houseSeries.size },
      console.log,
    );

    if (values.json) {
      console.log('JSON ' + JSON.stringify({
        nEvents: events.length, nDbRows, nDbEvents: houseSeries.size,
        nBets: scan.bets.length, nFallback: scan.nFallback, nDbRecovered: scan.nDbRecovered,
        skipCounts: scan.skipCounts,
        top20Train: ranked.slice(0, 20),
        top5Test: testRows,
        armCurve: curve,
        winnerLoserAsk: wlAsk,
        confidenceTerciles: terciles,
        perCity,
      }));
    }
  } finally {
    await db.end();
  }
}
