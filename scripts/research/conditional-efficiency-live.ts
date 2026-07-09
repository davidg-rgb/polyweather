/**
 * scripts/research/conditional-efficiency-live — SIGNAL-BACKLOG.md item #3, RE-OPENED on the LIVE panel.
 *
 * WHY THIS EXISTS. Item #3 (regime-conditional efficiency — is the day-before edge `calibratedP − ask`
 * bigger on high-ensemble-disagreement days?) reached a provisional gate-PASS on 2026-07-03 (Q4 +7.47pp)
 * that was REVOKED by hardening: the 104 Q4 bets collapsed to 29 station-days on only **3 distinct
 * weather-days** (high disagreement is synoptic — it hits many stations on the same frontal day), so the
 * day-clustered CI was [−7.86, +23.09] and a permutation false-passed 17.3%. Re-open criterion: **≥10
 * distinct Q4-carrying weather-days in a TEST period.**
 *
 * The blocker (diagnosed 2026-07-09): conditional-efficiency-scan.ts reads `forecast_snapshots` where
 * `snapshot_slot='backfill'` — a ONE-TIME historical reconstruction FROZEN at target_date 2026-06-15.
 * Re-running it reproduces the same 3 Q4 days; nothing accrues. The LIVE operational forecasts live in the
 * `10Z`/`22Z` slots (2026-06-13 → present). On their overlap (06-13→06-15, 360 matched model-days) the two
 * sources are the SAME 8 models with mean signed bias **+0.047°C** (≈0) and 0.5°C of unbiased snapshot
 * jitter — so the EMOS calibration + the per-station quartile cutpoints fit on `backfill` transfer to the
 * live panel WITHOUT systematic contamination (trap #12 cleared at the bias level).
 *
 * THE DESIGN (clean time-split, no within-window peeking):
 *   • Warm-up + TRAIN  = `backfill` slot, 2026-04-09 → the switch date (default 2026-06-15). Per-station
 *     disagreement quartile cutpoints (P25/P50/P75) are fit here, exactly as the pre-registered scan does.
 *   • TEST             = the live slot (default `10Z`), switchDate+1 → `to` (default 2026-07-08). Every Q4
 *     classification uses the TRAIN-fit cutpoints it never influenced.
 *   The walk-forward EMOS fold runs seamlessly across the slot boundary (obs are slot-independent).
 *
 * NOT the pre-registered scan verbatim — the forecast SOURCE for the TEST half is the live slot, a
 * deliberate, disclosed change (the only way to get fresh days). Every business-logic piece is IMPORTED,
 * not re-derived: EmosStation, selectCheapEntries, fitQuartileCutpoints, classifyQuartile, quantile,
 * clusterMeanTCi, armEdgeStats, mulberry32. This file adds ONLY the slot stitch + the (icao,targetDate)
 * carrier bookkeeping the day-clustered CI + permutation null need.
 *
 * THE HARDENED GATE (all reported, verdict is the operator's call):
 *   Q4 per-bet edge (armEdgeStats i.i.d.) · Q4 day-clustered CI · Q4 station-clustered CI ·
 *   distinct Q4 weather-days (the re-open metric) · zero-skill quartile-relabel permutation false-pass rate.
 *
 * Run (outside the reserved :32-:42 UTC cron window):
 *   pnpm tsx scripts/research/conditional-efficiency-live.ts --from 2026-04-21 --switch 2026-06-15 \
 *     --to 2026-07-08 --live-slot 10Z --leads 1,2 [--iters 2000] [--seed 20260709] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  gaussianBucketProbs,
  parseConfigRows,
  toNative,
  fToC,
  type BucketDef,
} from '../../packages/core/src/index.ts';
import { armEdgeStats, type GradedBet } from '../../packages/core/src/sim/stats.ts';
import { clusterMeanTCi, type Ci } from '../../packages/core/src/sim/selector-learn.ts';
import { mulberry32 } from '../../packages/core/src/calibration/scores.ts';
import {
  EmosStation,
  selectEntries as selectCheapEntries,
  type BucketView,
} from './db1-daybefore-efficiency.ts';
import {
  fitQuartileCutpoints,
  classifyQuartile,
  quantile,
  type QuartileCutpoints,
} from './conditional-efficiency-scan.ts';
import { listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'conditional-efficiency-live';

// =====================================================================================
// PURE HELPERS (sanity-checked at runtime; shuffle/partition mirror item3-hardening.ts)
// =====================================================================================

export function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}
export function partitionBySizes<T>(arr: T[], sizes: number[]): T[][] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total !== arr.length) throw new Error(`partitionBySizes: sizes sum to ${total}, array has ${arr.length}`);
  const out: T[][] = [];
  let offset = 0;
  for (const size of sizes) { out.push(arr.slice(offset, offset + size)); offset += size; }
  return out;
}

export interface StationDayCarrier {
  icao: string;
  targetDate: string;
  quartile: 1 | 2 | 3 | 4;
  bets: GradedBet[];
}

export interface LiveArgs {
  from: string;
  switchDate: string; // backfill ≤ switch (TRAIN); live > switch (TEST)
  to: string;
  liveSlot: string; // '10Z' | '22Z'
  leads: number[];
  stations?: string[];
}

interface DecisionPoint { icao: string; targetDate: string; disagreement: number | null; }

interface EventRow {
  eventId: string; icao: string; targetDate: string; unit: 'C' | 'F'; winnerIdx: number;
  bucketDefs: BucketDef[]; bucketIdxs: number[]; asks: Map<number, number | null>;
}

export interface LiveResult {
  nStations: number;
  nTrainDays: number;
  nTestDays: number;
  slotCounts: { backfill: number; live: number };
  regime: Record<1 | 2 | 3 | 4, ReturnType<typeof armEdgeStats>>;
  q4DistinctWeatherDays: number;
  q4DayClustered: { nClusters: number; mean: number; lo: number; hi: number };
  q4StationClustered: { nClusters: number; mean: number; lo: number; hi: number };
  q4Cities: number;
  permutation: { iters: number; seed: number; minN: number; observedEdge: number;
    sizes: [number, number, number, number]; falsePassRate: number; pGeObservedMean: number };
}

async function runLive(args: LiveArgs, deps: { db: Db; log: (m: string) => void }): Promise<LiveResult> {
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

  // STITCHED forecast source: backfill ≤ switchDate (warm-up + TRAIN), live slot > switchDate (TEST).
  // The two WHERE branches are disjoint in target_date, so no (icao,date,model,lead) appears twice.
  const fRows = await db.query<{ icao: string; model: string; target_date: string | Date; lead_days: number; tmax_c: string; snapshot_slot: string }>(
    `select icao, model, target_date, lead_days, tmax_c, snapshot_slot
     from forecast_snapshots
     where icao = any($1) and lead_days = any($2) and target_date <= $3
       and ( (snapshot_slot = 'backfill' and target_date <= $4)
          or (snapshot_slot = $5       and target_date >  $4) )`,
    [icaos, args.leads, args.to, args.switchDate, args.liveSlot],
  );
  const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  const fc = new Map<string, Map<string, Map<number, Map<string, number>>>>();
  let nBackfill = 0, nLive = 0;
  for (const r of fRows) {
    if (r.snapshot_slot === 'backfill') nBackfill++; else nLive++;
    const t = dISO(r.target_date);
    const byT = fc.get(r.icao) ?? new Map();
    const byLead = byT.get(t) ?? new Map();
    const byModel = byLead.get(r.lead_days) ?? new Map();
    byModel.set(r.model, Number(r.tmax_c));
    byLead.set(r.lead_days, byModel);
    byT.set(t, byLead);
    fc.set(r.icao, byT);
  }

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
  const evRows = await db.query<{ event_id: string; icao: string | null; target_date: string | Date; unit: 'C' | 'F'; winning_bucket_idx: number }>(
    `select me.id event_id, me.icao_at_creation icao, me.target_date, me.unit, me.winning_bucket_idx
     from market_events me
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1) and me.target_date >= $2 and me.target_date <= $3`,
    [icaos, args.from, args.to],
  );
  const bRows = await db.query<{ event_id: string; bucket_idx: number; low_native: number | null; high_native: number | null }>(
    `select mb.event_id, mb.bucket_idx, mb.low_native, mb.high_native
     from market_buckets mb join market_events me on me.id = mb.event_id
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1) and me.target_date >= $2 and me.target_date <= $3
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
     from market_events me join market_buckets mb on mb.event_id = me.id
     where me.ladder_ok and me.winning_bucket_idx is not null
       and me.icao_at_creation = any($1) and me.target_date >= $2 and me.target_date <= $3`,
    [icaos, args.from, args.to],
  );

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

  // PASS 1: walk-forward EMOS, recording per-(station,day) disagreement.
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
        if (mu != null && Number.isFinite(mu)) allDays.push({ icao, targetDate: d, disagreement: sm.disagreement(points, decisionLead) });
      }
      foldDay(icao, d);
    }
  }
  log(`${SCRIPT}: walked ${allDays.length} (station,day) decision points (${nBackfill} backfill + ${nLive} live-slot forecast rows)`);

  // splitDate = the day AFTER switchDate → TRAIN = backfill era, TEST = live era.
  const splitDate = addDaysISO(args.switchDate, 1);
  const train = allDays.filter((r) => r.targetDate < splitDate);
  const test = allDays.filter((r) => r.targetDate >= splitDate);
  const byStationTrain = new Map<string, DecisionPoint[]>();
  for (const r of train) { const a = byStationTrain.get(r.icao) ?? []; a.push(r); byStationTrain.set(r.icao, a); }
  const quartileCutpointsByStation = new Map<string, QuartileCutpoints>();
  for (const [icao, rows] of byStationTrain) {
    quartileCutpointsByStation.set(icao, fitQuartileCutpoints(rows.map((r) => r.disagreement).filter((v): v is number => Number.isFinite(v))));
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
    try { probs = gaussianBucketProbs(muNative, sigmaNative, ev.bucketDefs); } catch { return null; }
    return ev.bucketIdxs.map((bucketIdx, i) => ({ bucketIdx, calibratedP: probs[i]!, ask: ev.asks.get(bucketIdx) ?? null, isWinner: bucketIdx === ev.winnerIdx }));
  };

  // PASS 2 (#3): classify each TEST day's disagreement quartile, score its OWN cheap-subset edge,
  // tag carriers with (icao, targetDate) for clustering + permutation.
  const regimeBets: Record<1 | 2 | 3 | 4, GradedBet[]> = { 1: [], 2: [], 3: [], 4: [] };
  const carriers: StationDayCarrier[] = [];
  const q4Cities = new Set<string>();
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
    if (bets.length > 0) { carriers.push({ icao: r.icao, targetDate: r.targetDate, quartile: q, bets }); if (q === 4) q4Cities.add(r.icao); }
  }

  // Q4 clustered CIs (reuse clusterMeanTCi verbatim)
  const clustered = (quartile: 4, key: (c: StationDayCarrier) => string) => {
    const values: number[] = []; const clusters: string[] = [];
    for (const c of carriers) {
      if (c.quartile !== quartile) continue;
      for (const b of c.bets) {
        if (!(Number.isFinite(b.ask) && b.ask > 0 && b.ask <= 1)) continue;
        values.push((b.won ? 1 : 0) - b.ask); clusters.push(key(c));
      }
    }
    const ci: Ci = clusterMeanTCi(values, clusters);
    return { nClusters: new Set(clusters).size, mean: ci.mean, lo: ci.lo, hi: ci.hi };
  };
  const q4ByDay = clustered(4, (c) => c.targetDate);
  const q4ByStation = clustered(4, (c) => c.icao);

  // zero-skill permutation null (quartile-label reshuffle at station-day grain)
  const iters = 2000, seed = 20260709, minN = 30;
  const sizesByQ: Record<1 | 2 | 3 | 4, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const c of carriers) sizesByQ[c.quartile]++;
  const sizes: [number, number, number, number] = [sizesByQ[1], sizesByQ[2], sizesByQ[3], sizesByQ[4]];
  const observedEdge = armEdgeStats(regimeBets[4]).edge;
  const rand = mulberry32(seed);
  const pool = [...carriers];
  let falsePass = 0, geObs = 0;
  for (let i = 0; i < iters; i++) {
    shuffleInPlace(pool, rand);
    const groups = partitionBySizes(pool, sizes);
    const bets: GradedBet[] = [];
    for (const c of groups[3]!) for (const b of c.bets) bets.push(b);
    const s = armEdgeStats(bets);
    if (s.nGraded >= minN && s.edgeCiLo > 0) falsePass++;
    if (Number.isFinite(s.edge) && s.edge >= observedEdge) geObs++;
  }

  return {
    nStations: icaos.length, nTrainDays: train.length, nTestDays: test.length,
    slotCounts: { backfill: nBackfill, live: nLive },
    regime: { 1: armEdgeStats(regimeBets[1]), 2: armEdgeStats(regimeBets[2]), 3: armEdgeStats(regimeBets[3]), 4: armEdgeStats(regimeBets[4]) },
    q4DistinctWeatherDays: q4ByDay.nClusters, q4DayClustered: q4ByDay, q4StationClustered: q4ByStation, q4Cities: q4Cities.size,
    permutation: { iters, seed, minN, observedEdge, sizes, falsePassRate: falsePass / iters, pGeObservedMean: geObs / iters },
  };
}

/** The calendar day after a plain YYYY-MM-DD (UTC day-increment; target_date is a DATE). Pure. */
export function addDaysISO(dateISO: string, n: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// =====================================================================================
// REPORT + SANITY + CLI
// =====================================================================================
const pp = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' : 'n/a');

function report(res: LiveResult, args: LiveArgs, log: (m: string) => void): void {
  log(`=== ${SCRIPT}: item #3 on the LIVE panel ===`);
  log(`  warm-up+TRAIN backfill ≤ ${args.switchDate} · TEST live '${args.liveSlot}' ${addDaysISO(args.switchDate, 1)} → ${args.to}`);
  log(`  ${res.nStations} stations · TRAIN days ${res.nTrainDays} · TEST days ${res.nTestDays} · forecast rows ${res.slotCounts.backfill} backfill + ${res.slotCounts.live} live`);
  log('');
  log('  Per-quartile day-before edge (calibratedP − ask, cheap subset; per-bet i.i.d. CI):');
  for (const q of [1, 2, 3, 4] as const) {
    const s = res.regime[q];
    log(`    Q${q} n=${s.nGraded} edge ${pp(s.edge)} [${pp(s.edgeCiLo)}, ${pp(s.edgeCiHi)}]`);
  }
  log('');
  log(`  RE-OPEN METRIC — distinct Q4 weather-days: ${res.q4DistinctWeatherDays} (criterion ≥10) · Q4 cities ${res.q4Cities}`);
  log(`  Q4 DAY-clustered CI:     nClusters=${res.q4DayClustered.nClusters} mean ${pp(res.q4DayClustered.mean)} CI [${pp(res.q4DayClustered.lo)}, ${pp(res.q4DayClustered.hi)}]`);
  log(`  Q4 STATION-clustered CI: nClusters=${res.q4StationClustered.nClusters} mean ${pp(res.q4StationClustered.mean)} CI [${pp(res.q4StationClustered.lo)}, ${pp(res.q4StationClustered.hi)}]`);
  const p = res.permutation;
  log(`  zero-skill permutation: sizes(Q1..Q4)=${p.sizes.join(',')} · P(n≥${p.minN} & ciLo>0)=${(p.falsePassRate * 100).toFixed(2)}% · P(mean≥obs ${pp(p.observedEdge)})=${(p.pGeObservedMean * 100).toFixed(2)}%`);
  log('');
  const daysOk = res.q4DistinctWeatherDays >= 10;
  const dayCiExcl0 = res.q4DayClustered.lo > 0;
  const permOk = p.falsePassRate < 0.05;
  log(`  HARDENED GATE: distinct-Q4-days≥10 ${daysOk ? 'PASS' : 'FAIL'} · day-clustered ciLo>0 ${dayCiExcl0 ? 'PASS' : 'FAIL'} · permutation<5% ${permOk ? 'PASS' : 'FAIL'}`);
  log(`  → ${daysOk && dayCiExcl0 && permOk ? 'PASS (escalate to operator — genuinely new measured signal)' : daysOk ? 'KILL — well-powered null (≥10 Q4 days but the day-clustered edge includes 0)' : 'INSUFFICIENT_DATA — still <10 distinct Q4 weather-days'}`);
}

function sanity(): void {
  if (quantile([1, 2, 3, 4], 0.5) !== 2.5) throw new Error('sanity: quantile');
  const c = fitQuartileCutpoints([1, 2, 3, 4]);
  if (classifyQuartile(0.5, c) !== 1 || classifyQuartile(100, c) !== 4) throw new Error('sanity: classifyQuartile');
  if (addDaysISO('2026-06-15', 1) !== '2026-06-16') throw new Error('sanity: addDaysISO');
  const r = mulberry32(1); const a = [1, 2, 3, 4, 5]; shuffleInPlace(a, r);
  if ([...a].sort((x, y) => x - y).join(',') !== '1,2,3,4,5') throw new Error('sanity: shuffle multiset');
  if (partitionBySizes([1, 2, 3, 4], [2, 2]).map((g) => g.length).join(',') !== '2,2') throw new Error('sanity: partition');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  console.log(`${SCRIPT}: sanity passed`);
  loadEnv();
  const now = new Date();
  const minute = now.getUTCMinutes();
  if (minute >= 32 && minute <= 42) throw new Error(`${SCRIPT}: inside the reserved :32-:42 UTC window (now :${minute}); retry after :43`);
  const { values } = parseArgs({
    options: {
      from: { type: 'string' }, switch: { type: 'string' }, to: { type: 'string' },
      'live-slot': { type: 'string' }, leads: { type: 'string' }, json: { type: 'boolean' },
    },
  });
  const args: LiveArgs = {
    from: values.from ?? '2026-04-21',
    switchDate: values.switch ?? '2026-06-15',
    to: values.to ?? '2026-07-08',
    liveSlot: values['live-slot'] ?? '10Z',
    leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
  };
  const db = makeScriptDb();
  try {
    const res = await runLive(args, { db, log: console.log });
    report(res, args, console.log);
    if (values.json) console.log('JSON ' + JSON.stringify(res));
  } finally {
    await db.end();
  }
}
