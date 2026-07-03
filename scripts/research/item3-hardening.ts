/**
 * scripts/research/item3-hardening — adversarial hardening pass on SIGNAL-BACKLOG.md item #3's
 * provisional gate-PASS (conditional-efficiency-scan.ts's regime split, Q4 +7.47pp CI [+1.06,+13.87]
 * n=104, TEST half `--from 2026-04-21 --to 2026-06-21 --split-date 2026-05-27 --leads 1,2`).
 *
 * WHAT THIS CHECKS (raw numbers only — no verdict, no gate wording, that's the operator's call):
 *   1. What `armEdgeStats`'s reported CI actually IS (per-bet i.i.d., not clustered) — see the file:line
 *      note above `crossCheck()` below.
 *   2. The SAME Q4 bet set's edge CI recomputed two clustered ways (by target-date "weather-day", by
 *      station) via `clusterMeanTCi` (REUSED verbatim from core/sim/selector-learn.ts — not re-derived;
 *      that's the REC-1/selector-learn cluster-mean-t idiom this project already trusts).
 *   3. A zero-skill permutation null: reshuffle which QUARTILE LABEL each bet-carrying station-day
 *      originally received (preserving the original per-quartile station-day COUNTS), recompute the
 *      "Q4-equivalent" (last-labeled) cell's pooled i.i.d. edge CI (the SAME armEdgeStats methodology the
 *      original result used, so the null is apples-to-apples), and report how often pure random relabeling
 *      alone produces something that would have looked like a PASS.
 *
 * WHY A SEPARATE DATA WALK. conditional-efficiency-scan.ts's `runScan()` returns only the AGGREGATED
 * per-quartile armEdgeStats bundle — it does not expose which station-day or which target-date each bet
 * came from, which clustering requires. Rather than edit that file (another agent's uncommitted work —
 * off limits), this script REPLICATES its PASS-1 (walk-forward EMOS classification) + PASS-3 (regime
 * scoring) control flow, importing every pure/stateful piece it can (`EmosStation`, `selectEntries`,
 * `fitQuartileCutpoints`, `classifyQuartile`, `quantile` — zero re-derived business logic), adding ONLY
 * the (icao, targetDate) bookkeeping clustering needs. Because that is a hand-written duplicate, its
 * output is CROSS-CHECKED against the original `runScan()` (imported unmodified) before anything else
 * runs — the report below leads with `crossCheck()`'s file:line and match/mismatch, exactly so a
 * silent divergence between the duplicate and the source of truth is caught, not laundered into a nicer-
 * looking permutation result.
 *
 * Run (same window as the item-3 result being hardened):
 *   pnpm tsx scripts/research/item3-hardening.ts --from 2026-04-21 --to 2026-06-21 \
 *     --split-date 2026-05-27 --leads 1,2 [--iters 2000] [--seed 20260703] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  gaussianBucketProbs,
  parseConfigRows,
  toNative,
  fToC,
  type AppConfig,
  type BucketDef,
} from '../../packages/core/src/index.ts';
import { armEdgeStats, type GradedBet, type ArmEdgeStats } from '../../packages/core/src/sim/stats.ts';
import { clusterMeanTCi, type Ci } from '../../packages/core/src/sim/selector-learn.ts';
import { mulberry32 } from '../../packages/core/src/calibration/scores.ts';
import {
  EmosStation,
  selectEntries as selectCheapEntries,
  type BucketView,
} from './db1-daybefore-efficiency.ts';
import {
  runScan,
  fitQuartileCutpoints,
  classifyQuartile,
  type QuartileCutpoints,
  type ScanArgs,
} from './conditional-efficiency-scan.ts';
import { listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'item3-hardening';

// =====================================================================================
// PURE HELPERS (this script's own — sanity-checked at runtime in sanity() below, no test file)
// =====================================================================================

/** Fisher-Yates in-place shuffle, driven by an injected RNG (mulberry32 for reproducibility). */
export function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/** Slice an array into consecutive groups of the given sizes. Throws if sizes don't sum to arr.length
 *  (a silent under/over-count would corrupt the permutation null without any visible symptom). */
export function partitionBySizes<T>(arr: T[], sizes: number[]): T[][] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total !== arr.length) {
    throw new Error(`partitionBySizes: sizes sum to ${total}, array has ${arr.length}`);
  }
  const out: T[][] = [];
  let offset = 0;
  for (const size of sizes) {
    out.push(arr.slice(offset, offset + size));
    offset += size;
  }
  return out;
}

// =====================================================================================
// REPLICATED DATA WALK (mirrors conditional-efficiency-scan.ts's runScan PASS 1 + PASS 3 — see the
// file-header note above on why this duplicates rather than imports; every business-logic piece below
// is IMPORTED, not re-derived: EmosStation, selectCheapEntries, fitQuartileCutpoints, classifyQuartile).
// =====================================================================================

interface DecisionPoint {
  icao: string;
  targetDate: string;
  disagreement: number | null;
}

/** One TEST-half (station, day) that contributed >=1 cheap-subset bet, tagged with its ORIGINAL
 *  train-fit quartile label — the unit the permutation test reshuffles. */
export interface StationDayCarrier {
  icao: string;
  targetDate: string;
  quartile: 1 | 2 | 3 | 4;
  bets: GradedBet[];
}

export interface HardeningWalkResult {
  /** Per-quartile pooled bets, IDENTICAL shape to conditional-efficiency-scan.ts's regimeBets — used
   *  only to cross-check this duplicate walk against the original runScan(). */
  regimeBets: Record<1 | 2 | 3 | 4, GradedBet[]>;
  /** Bet-carrying station-days across ALL FOUR quartiles, each tagged with its original label — the
   *  permutation population. */
  carriers: StationDayCarrier[];
}

export interface WalkDeps {
  db: Db;
  log: (msg: string) => void;
}

async function runHardeningWalk(args: ScanArgs, deps: WalkDeps): Promise<HardeningWalkResult> {
  const { db, log } = deps;
  const cfg = parseConfigRows(await db.query<{ key: string; value: string }>(`select key, value from config`));

  let stationRows = await db.query<{ icao: string; unit: 'C' | 'F' }>(
    `select distinct s.icao, c.unit
     from stations s
     join city_stations cs on cs.icao = s.icao and cs.valid_to is null
     join cities c on c.id = cs.city_id`,
  );
  if (args.stations) {
    const want = new Set(args.stations.map((s) => s.toUpperCase()));
    stationRows = stationRows.filter((s) => want.has(s.icao.toUpperCase()));
  }
  const icaos = stationRows.map((s) => s.icao);
  const unitByIcao = new Map(stationRows.map((s) => [s.icao, s.unit]));
  if (icaos.length === 0) throw new Error('no stations in scope');

  const fRows = await db.query<{ icao: string; model: string; target_date: string | Date; lead_days: number; tmax_c: string }>(
    `select icao, model, target_date, lead_days, tmax_c
     from forecast_snapshots
     where snapshot_slot = 'backfill' and icao = any($1) and lead_days = any($2) and target_date <= $3`,
    [icaos, args.leads, args.to],
  );
  const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  const fc = new Map<string, Map<string, Map<number, Map<string, number>>>>();
  for (const r of fRows) {
    const t = dISO(r.target_date);
    const byT = fc.get(r.icao) ?? new Map();
    const byLead = byT.get(t) ?? new Map();
    const byModel = byLead.get(r.lead_days) ?? new Map();
    byModel.set(r.model, Number(r.tmax_c));
    byLead.set(r.lead_days, byModel);
    byT.set(t, byLead);
    fc.set(r.icao, byT);
  }

  // finalized observations, °C internally — same query as conditional-efficiency-scan.ts (native unit
  // column read but not retained: the regime split never needs it, only #4's tail split did).
  const oRows = await db.query<{ icao: string; date_local: string | Date; tmax_wu_native: number; unit: 'C' | 'F' }>(
    `select icao, date_local, tmax_wu_native, unit
     from observations where finalized_at is not null and icao = any($1) and date_local <= $2`,
    [icaos, args.to],
  );
  const obsC = new Map<string, Map<string, number>>();
  for (const r of oRows) {
    const t = dISO(r.date_local);
    const native = Number(r.tmax_wu_native);
    const unit = r.unit ?? unitByIcao.get(r.icao);
    const mC = obsC.get(r.icao) ?? new Map<string, number>();
    mC.set(t, unit === 'F' ? fToC(native) : native);
    obsC.set(r.icao, mC);
  }

  // resolved bucket markets + ladders + day-before asks — IDENTICAL queries to conditional-efficiency-scan.ts
  const evRows = await db.query<{
    event_id: string; icao: string | null; target_date: string | Date; unit: 'C' | 'F'; winning_bucket_idx: number;
  }>(
    `select me.id event_id, me.icao_at_creation icao, me.target_date, me.unit, me.winning_bucket_idx
     from market_events me
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1)
       and me.target_date >= $2 and me.target_date <= $3`,
    [icaos, args.from, args.to],
  );
  const bRows = await db.query<{ event_id: string; bucket_idx: number; low_native: number | null; high_native: number | null }>(
    `select mb.event_id, mb.bucket_idx, mb.low_native, mb.high_native
     from market_buckets mb
     join market_events me on me.id = mb.event_id
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1)
       and me.target_date >= $2 and me.target_date <= $3
     order by mb.event_id, mb.bucket_idx`,
    [icaos, args.from, args.to],
  );
  const askRows = await db.query<{ event_id: string; bucket_idx: number; day_before_ask: string | null }>(
    `select me.id event_id, mb.bucket_idx,
            (select ms.best_ask from market_snapshots ms
               where ms.bucket_id = mb.id
                 and ms.captured_at >= (me.target_date - 1)::timestamptz
                 and ms.captured_at <  (me.target_date)::timestamptz
                 and ms.best_ask is not null
               order by ms.captured_at desc limit 1) day_before_ask
     from market_events me
     join market_buckets mb on mb.event_id = me.id
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1)
       and me.target_date >= $2 and me.target_date <= $3`,
    [icaos, args.from, args.to],
  );

  interface EventRow {
    eventId: string; icao: string; targetDate: string; unit: 'C' | 'F'; winnerIdx: number;
    bucketDefs: BucketDef[]; bucketIdxs: number[]; asks: Map<number, number | null>;
  }
  const laddersByEvent = new Map<string, { bucketIdx: number; low: number | null; high: number | null }[]>();
  for (const r of bRows) {
    const arr = laddersByEvent.get(r.event_id) ?? [];
    arr.push({ bucketIdx: r.bucket_idx, low: r.low_native, high: r.high_native });
    laddersByEvent.set(r.event_id, arr);
  }
  const asksByEvent = new Map<string, Map<number, number | null>>();
  for (const r of askRows) {
    const m = asksByEvent.get(r.event_id) ?? new Map<number, number | null>();
    m.set(r.bucket_idx, r.day_before_ask == null ? null : Number(r.day_before_ask));
    asksByEvent.set(r.event_id, m);
  }
  const events: EventRow[] = [];
  for (const r of evRows) {
    if (!r.icao) continue;
    const ladder = laddersByEvent.get(r.event_id);
    if (!ladder || ladder.length < 2) continue;
    events.push({
      eventId: r.event_id, icao: r.icao, targetDate: dISO(r.target_date), unit: r.unit, winnerIdx: r.winning_bucket_idx,
      bucketDefs: ladder.map((b) => ({ low: b.low, high: b.high, unit: r.unit })),
      bucketIdxs: ladder.map((b) => b.bucketIdx),
      asks: asksByEvent.get(r.event_id) ?? new Map(),
    });
  }
  const eventByKey = new Map<string, EventRow>();
  for (const e of events) eventByKey.set(`${e.icao}|${e.targetDate}`, e);

  // PASS 1: walk-forward EMOS, recording per-(station,day) disagreement only (this hardening pass only
  // needs item #3's regime split, not #2's bust or #4's tail).
  const stateByIcao = new Map(icaos.map((i) => [i, new EmosStation(cfg)]));
  const decisionLead = args.leads.includes(1) ? 1 : args.leads[0]!;
  const allDays: DecisionPoint[] = [];

  const allTargets = new Set<string>();
  for (const byT of fc.values()) for (const t of byT.keys()) allTargets.add(t);
  const foldDay = (icao: string, t: string): void => {
    const o = obsC.get(icao)?.get(t);
    const byLeadMap = fc.get(icao)?.get(t);
    if (o === undefined || !byLeadMap) return;
    const sm = stateByIcao.get(icao)!;
    for (const [lead, byModel] of byLeadMap) {
      if (!args.leads.includes(lead)) continue;
      sm.fold([...byModel].map(([model, f]) => ({ model, f })), lead, o);
    }
  };
  for (const t of [...allTargets].sort()) if (t < args.from) for (const icao of icaos) foldDay(icao, t);

  for (const d of listDatesISO(args.from, args.to)) {
    for (const icao of icaos) {
      const o = obsC.get(icao)?.get(d);
      const byLeadMap = fc.get(icao)?.get(d);
      if (o === undefined || !byLeadMap) { foldDay(icao, d); continue; }
      const sm = stateByIcao.get(icao)!;
      const points = [...(byLeadMap.get(decisionLead) ?? new Map())].map(([model, f]) => ({ model, f }));
      if (points.length > 0) {
        const mu = sm.blendedMu(points, decisionLead);
        if (mu != null && Number.isFinite(mu)) {
          allDays.push({ icao, targetDate: d, disagreement: sm.disagreement(points, decisionLead) });
        }
      }
      foldDay(icao, d);
    }
  }
  log(`${SCRIPT}: walked ${allDays.length} (station,day) decision points across ${icaos.length} stations`);

  const train = allDays.filter((r) => r.targetDate < args.splitDate);
  const test = allDays.filter((r) => r.targetDate >= args.splitDate);

  const byStationTrain = new Map<string, DecisionPoint[]>();
  for (const r of train) { const a = byStationTrain.get(r.icao) ?? []; a.push(r); byStationTrain.set(r.icao, a); }
  const quartileCutpointsByStation = new Map<string, QuartileCutpoints>();
  for (const [icao, rows] of byStationTrain) {
    quartileCutpointsByStation.set(
      icao,
      fitQuartileCutpoints(rows.map((r) => r.disagreement).filter((v): v is number => Number.isFinite(v))),
    );
  }

  const viewsFor = (ev: EventRow, sm: EmosStation, targetDate: string): BucketView[] | null => {
    const byLeadMap = fc.get(ev.icao)?.get(targetDate);
    const points = [...(byLeadMap?.get(decisionLead) ?? new Map())].map(([model, f]) => ({ model, f }));
    if (points.length === 0) return null;
    const mu = sm.blendedMu(points, decisionLead);
    const sigmaC = sm.sigma(decisionLead);
    if (mu == null || sigmaC == null || !Number.isFinite(mu) || !Number.isFinite(sigmaC)) return null;
    const muNative = toNative(mu, ev.unit);
    const sigmaNative = ev.unit === 'F' ? sigmaC * (9 / 5) : sigmaC;
    if (sigmaNative <= 0.2) return null;
    let probs: number[];
    try {
      probs = gaussianBucketProbs(muNative, sigmaNative, ev.bucketDefs);
    } catch {
      return null;
    }
    return ev.bucketIdxs.map((bucketIdx, i) => ({
      bucketIdx, calibratedP: probs[i]!, ask: ev.asks.get(bucketIdx) ?? null, isWinner: bucketIdx === ev.winnerIdx,
    }));
  };

  // PASS 3 (#3, with cluster tagging added): classify each TEST day's quartile, score its OWN
  // cheap-subset edge, and — the addition this script needs — tag each bet with (icao, targetDate) so
  // clustering + permutation can operate on the station-day unit, not the pooled bet.
  const regimeBets: Record<1 | 2 | 3 | 4, GradedBet[]> = { 1: [], 2: [], 3: [], 4: [] };
  const carriers: StationDayCarrier[] = [];
  for (const r of test) {
    const c = quartileCutpointsByStation.get(r.icao);
    if (!c || r.disagreement == null) continue;
    const q = classifyQuartile(r.disagreement, c);
    if (q == null) continue;
    const ev = eventByKey.get(`${r.icao}|${r.targetDate}`);
    if (!ev) continue;
    const views = viewsFor(ev, stateByIcao.get(r.icao)!, r.targetDate);
    if (!views) continue;
    const bets: GradedBet[] = [];
    for (const e of selectCheapEntries(views).filter((x) => x.inCheapSubset)) {
      const bet: GradedBet = { won: e.isWinner, ask: e.ask };
      regimeBets[q].push(bet);
      bets.push(bet);
    }
    if (bets.length > 0) carriers.push({ icao: r.icao, targetDate: r.targetDate, quartile: q, bets });
  }

  return { regimeBets, carriers };
}

// =====================================================================================
// CROSS-CHECK against the original runScan() (imported unmodified — see file header)
// =====================================================================================

export interface QuartileCrossCheck {
  q: 1 | 2 | 3 | 4;
  duplicateNGraded: number;
  officialNGraded: number;
  duplicateEdge: number;
  officialEdge: number;
  duplicateCiLo: number;
  officialCiLo: number;
  duplicateCiHi: number;
  officialCiHi: number;
  matches: boolean;
}

/**
 * armEdgeStats' CI IS per-bet i.i.d.: `packages/core/src/sim/stats.ts:195-220` (`armEdgeStats`) reduces
 * bets to `meanConfidenceInterval` (`packages/core/src/sim/stats.ts:63-71`) — mean ± z·SE over the pooled
 * (won − ask) values treating every bet as an independent draw. No day/station clustering anywhere in
 * that path. Quartile assignment: `scripts/research/conditional-efficiency-scan.ts:426-438` (PASS 3)
 * classifies ONE ROW PER (station, day) TEST decision point (`r` from the `test` array, one row per
 * (icao, targetDate) with a valid decision-lead forecast+obs pair — see `conditional-efficiency-scan.ts:
 * 344-363`'s walk) into a quartile via that station's TRAIN-fit cutpoints, then scores THAT SAME day's
 * OWN event: `n` in the reported Q4=104 is BET count (one station-day can contribute the modal bucket AND
 * 0+ cheap-longshot buckets — `db1-daybefore-efficiency.ts:102-128`'s `selectEntries`, filtered to
 * `inCheapSubset`), not station-day count. This file's `carriers` (below) is the station-day-count view.
 */
function crossCheck(mine: Record<1 | 2 | 3 | 4, GradedBet[]>, official: Record<1 | 2 | 3 | 4, ArmEdgeStats>): QuartileCrossCheck[] {
  const EPS = 1e-9;
  return ([1, 2, 3, 4] as const).map((q) => {
    const dup = armEdgeStats(mine[q]);
    const off = official[q];
    const matches =
      dup.nGraded === off.nGraded &&
      Math.abs(dup.edge - off.edge) < EPS &&
      Math.abs(dup.edgeCiLo - off.edgeCiLo) < EPS &&
      Math.abs(dup.edgeCiHi - off.edgeCiHi) < EPS;
    return {
      q, duplicateNGraded: dup.nGraded, officialNGraded: off.nGraded,
      duplicateEdge: dup.edge, officialEdge: off.edge,
      duplicateCiLo: dup.edgeCiLo, officialCiLo: off.edgeCiLo,
      duplicateCiHi: dup.edgeCiHi, officialCiHi: off.edgeCiHi,
      matches,
    };
  });
}

// =====================================================================================
// CLUSTERED CI (item 2 of the assignment) + PERMUTATION NULL (item 3)
// =====================================================================================

export interface ClusteredCiResult {
  nClusters: number;
  mean: number;
  lo: number;
  hi: number;
}

function clusteredEdgeCi(carriers: StationDayCarrier[], quartile: 1 | 2 | 3 | 4, clusterKey: (c: StationDayCarrier) => string): ClusteredCiResult {
  const values: number[] = [];
  const clusters: string[] = [];
  for (const c of carriers) {
    if (c.quartile !== quartile) continue;
    for (const b of c.bets) {
      if (!(Number.isFinite(b.ask) && b.ask > 0 && b.ask <= 1)) continue; // same usability filter armEdgeStats applies
      values.push((b.won ? 1 : 0) - b.ask);
      clusters.push(clusterKey(c));
    }
  }
  const ci: Ci = clusterMeanTCi(values, clusters);
  return { nClusters: new Set(clusters).size, mean: ci.mean, lo: ci.lo, hi: ci.hi };
}

export interface PermutationResult {
  iters: number;
  seed: number;
  minN: number;
  observedEdge: number;
  sizes: [number, number, number, number];
  totalCarriers: number;
  falsePassCount: number;
  falsePassRate: number;
  geObservedMeanCount: number;
  pGeObservedMean: number;
}

/**
 * Zero-skill null: reshuffle which quartile LABEL each bet-carrying station-day originally received
 * (a pure relabeling — preserves the exact original per-quartile station-day COUNTS among the carrying
 * population), recompute the last-labeled ("Q4-equivalent") cell's pooled i.i.d. edge via armEdgeStats
 * (the SAME estimator the reported result used), and tally how often pure noise alone produces something
 * that would have read as a PASS (n>=minN AND ciLo>0) or matched/exceeded the observed mean edge.
 */
function permutationNull(
  carriers: StationDayCarrier[],
  opts: { observedEdge: number; minN: number; iters: number; seed: number },
): PermutationResult {
  const sizesByQ: Record<1 | 2 | 3 | 4, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const c of carriers) sizesByQ[c.quartile]++;
  const sizes: [number, number, number, number] = [sizesByQ[1], sizesByQ[2], sizesByQ[3], sizesByQ[4]];

  const rand = mulberry32(opts.seed);
  const pool = [...carriers];
  let falsePassCount = 0;
  let geObservedMeanCount = 0;
  for (let iter = 0; iter < opts.iters; iter++) {
    shuffleInPlace(pool, rand);
    const groups = partitionBySizes(pool, sizes);
    const q4Equivalent = groups[3]!;
    const bets: GradedBet[] = [];
    for (const c of q4Equivalent) for (const b of c.bets) bets.push(b);
    const stats = armEdgeStats(bets);
    if (stats.nGraded >= opts.minN && stats.edgeCiLo > 0) falsePassCount++;
    if (Number.isFinite(stats.edge) && stats.edge >= opts.observedEdge) geObservedMeanCount++;
  }
  return {
    iters: opts.iters, seed: opts.seed, minN: opts.minN, observedEdge: opts.observedEdge,
    sizes, totalCarriers: carriers.length,
    falsePassCount, falsePassRate: falsePassCount / opts.iters,
    geObservedMeanCount, pGeObservedMean: geObservedMeanCount / opts.iters,
  };
}

// =====================================================================================
// DB-TIMING GUARD (per operating rule: never a query in flight during :35-:42 of any hour)
// =====================================================================================

function assertOutsideReservedWindow(now: Date = new Date()): void {
  const minute = now.getUTCMinutes();
  if (minute >= 32 && minute <= 42) {
    throw new Error(
      `${SCRIPT}: refusing to open a DB connection at :${String(minute).padStart(2, '0')} UTC — inside the reserved :32-:42 window; retry after :43`,
    );
  }
}

// =====================================================================================
// SANITY (this script's own pure helpers only — clusterMeanTCi/armEdgeStats are reused, already tested
// elsewhere, not re-checked here)
// =====================================================================================

function sanity(): void {
  // shuffleInPlace: a permutation, not a resample — same multiset in/out, reproducible for a fixed seed
  const rand1 = mulberry32(1);
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  shuffleInPlace(a, rand1);
  if (a.length !== 10) throw new Error('sanity: shuffleInPlace changed length');
  if ([...a].sort((x, y) => x - y).join(',') !== '1,2,3,4,5,6,7,8,9,10') throw new Error('sanity: shuffleInPlace changed the multiset');
  const rand2 = mulberry32(1);
  const b = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  shuffleInPlace(b, rand2);
  if (a.join(',') !== b.join(',')) throw new Error('sanity: shuffleInPlace not reproducible for a fixed seed');

  // partitionBySizes: total-size guard + exact slicing
  const groups = partitionBySizes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [3, 3, 2, 2]);
  if (groups.map((g) => g.length).join(',') !== '3,3,2,2') throw new Error('sanity: partitionBySizes wrong group sizes');
  if (groups.flat().join(',') !== '1,2,3,4,5,6,7,8,9,10') throw new Error('sanity: partitionBySizes lost/reordered elements');
  let threw = false;
  try {
    partitionBySizes([1, 2, 3], [1, 1]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('sanity: partitionBySizes must throw on a size mismatch');
}

// =====================================================================================
// REPORT + CLI
// =====================================================================================

const pp = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' : 'n/a');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  console.log(`${SCRIPT}: sanity checks passed`);
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      'split-date': { type: 'string' },
      leads: { type: 'string' },
      stations: { type: 'string' },
      iters: { type: 'string' },
      seed: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const args: ScanArgs = {
    from: values.from ?? '2026-04-21',
    to: values.to ?? '2026-06-21',
    splitDate: values['split-date'] ?? '2026-05-27',
    leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
    stations: splitList(values.stations),
  };
  const iters = values.iters ? Number(values.iters) : 2000;
  const seed = values.seed ? Number(values.seed) : 20260703;

  const t0 = Date.now();
  assertOutsideReservedWindow();
  console.log(`${SCRIPT}: starting at ${new Date().toISOString()} (UTC minute ${new Date().getUTCMinutes()})`);

  const db = makeScriptDb();
  try {
    console.log(`${SCRIPT}: pass 1/2 — official runScan() (the source-of-truth aggregate)`);
    const official = await runScan(args, { db, log: console.log });

    assertOutsideReservedWindow();
    console.log(`${SCRIPT}: pass 2/2 — duplicate cluster-tagged walk`);
    const walk = await runHardeningWalk(args, { db, log: console.log });

    const elapsedMs = Date.now() - t0;

    const cc = crossCheck(walk.regimeBets, official.regime);
    console.log('');
    console.log(`=== ${SCRIPT} cross-check (duplicate walk vs official runScan()) ===`);
    for (const r of cc) {
      console.log(
        `  Q${r.q} n ${r.duplicateNGraded}/${r.officialNGraded} · edge ${pp(r.duplicateEdge)}/${pp(r.officialEdge)} · ` +
        `CI [${pp(r.duplicateCiLo)},${pp(r.duplicateCiHi)}]/[${pp(r.officialCiLo)},${pp(r.officialCiHi)}] · ${r.matches ? 'MATCH' : 'MISMATCH'}`,
      );
    }
    const allMatch = cc.every((r) => r.matches);
    if (!allMatch) {
      console.log(`  *** ${SCRIPT}: at least one quartile MISMATCHED — the clustered/permutation numbers below rest on an unverified duplicate walk ***`);
    }

    const q4ByDay = clusteredEdgeCi(walk.carriers, 4, (c) => c.targetDate);
    const q4ByStation = clusteredEdgeCi(walk.carriers, 4, (c) => c.icao);
    console.log('');
    console.log('=== Q4 clustered edge CI (same bet set, clustered inference) ===');
    console.log(`  by target-date (weather-day): nClusters=${q4ByDay.nClusters} mean ${pp(q4ByDay.mean)} CI [${pp(q4ByDay.lo)}, ${pp(q4ByDay.hi)}]`);
    console.log(`  by station:                   nClusters=${q4ByStation.nClusters} mean ${pp(q4ByStation.mean)} CI [${pp(q4ByStation.lo)}, ${pp(q4ByStation.hi)}]`);

    const observedEdge = armEdgeStats(walk.regimeBets[4]).edge;
    const perm = permutationNull(walk.carriers, { observedEdge, minN: 30, iters, seed });
    console.log('');
    console.log('=== zero-skill permutation (quartile-label reshuffle, station-day grain) ===');
    console.log(`  carrying station-days total=${perm.totalCarriers} sizes(Q1..Q4)=${perm.sizes.join(',')}`);
    console.log(`  iters=${perm.iters} seed=${perm.seed} minN=${perm.minN} observedEdge=${pp(perm.observedEdge)}`);
    console.log(`  P(shuffled Q4-equivalent: n>=${perm.minN} AND ciLo>0)  = ${perm.falsePassCount}/${perm.iters} = ${(perm.falsePassRate * 100).toFixed(2)}%`);
    console.log(`  P(shuffled Q4-equivalent mean edge >= observed ${pp(perm.observedEdge)}) = ${perm.geObservedMeanCount}/${perm.iters} = ${(perm.pGeObservedMean * 100).toFixed(2)}%`);

    console.log('');
    console.log(`${SCRIPT}: elapsed ${(elapsedMs / 1000).toFixed(1)}s`);

    if (values.json) {
      console.log('JSON ' + JSON.stringify({ crossCheck: cc, allMatch, q4ByDay, q4ByStation, permutation: perm, elapsedMs }));
    }
  } finally {
    await db.end();
  }
}
