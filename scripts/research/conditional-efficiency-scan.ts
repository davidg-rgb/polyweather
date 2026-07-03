/**
 * scripts/research/conditional-efficiency-scan — SIGNAL-BACKLOG.md items 2, 3, 4: three conditional
 * re-slices of KILL-GATE 2's exact dataset + edge metric (db1-daybefore-efficiency.ts), pre-registered
 * 2026-07-03 (see SIGNAL-BACKLOG.md items 2-4 for the full rationale). NOT YET RUN — this file prepares
 * the SQL + the walk-forward pass; no DB connection has been opened against it in this session.
 *
 * WHY ONE SCRIPT FOR THREE ITEMS. All three ask "is KILL-GATE 2's pooled null (edge CI straddles 0)
 * actually uniform, or does it hide a conditional signal in some subset?" — and all three read the
 * IDENTICAL base tables db1-daybefore-efficiency.ts already queries (forecast_snapshots, observations,
 * market_events/market_buckets, day-before market_snapshots asks). Per the backlog's own sequencing
 * note: pull that dataset ONCE, walk it ONCE, and classify each (station, day) three different ways
 * rather than three separate DB round-trips.
 *
 *   #2 post-bust reaction:   does YESTERDAY's forecast miss (a "bust") predict a mispricing in TODAY's
 *                            fresh day-before ask for the SAME city (a NEXT-DAY, cross-event question —
 *                            not a re-test of "is today's own bet good", which is #3/pooled KILL-GATE 2).
 *   #3 regime-conditional:   does the day-before edge (calibratedP − ask) vary by ensemble disagreement
 *                            quartile (re-uses l3b-residual-structure.ts's disagreement formula, now
 *                            exposed as EmosStation.disagreement)?
 *   #4 tail-day calibration: on days where the realized Tmax is a genuine climatological extreme (P5/P95
 *                            of the station's OWN history), is the market's FAR-TAIL bucket price
 *                            miscalibrated vs. the realized win rate (a behavioral/anchoring question
 *                            invisible in KILL-GATE 2's pooled Brier)?
 *
 * TRAIN/TEST DISCIPLINE (load-bearing, matches sim-maker-exit.ts --split). Every cutpoint (the bust P75,
 * the disagreement quartiles, the tail P5/P95) is fit PER STATION on the TRAIN half of the window
 * (`target_date < splitDate`) and applied UNCHANGED to classify TEST-half (`target_date >= splitDate`)
 * days. Only TEST-half results are scored against the pre-registered gates — this is the SAME winner's-
 * curse discipline the 2026-06-30 review imposed on the maker-exit tuning loop, applied here from the
 * start rather than retrofitted after a result looks good.
 *
 * Run (once an operator greenlights execution):
 *   pnpm tsx scripts/research/conditional-efficiency-scan.ts --from 2026-04-21 --to 2026-06-21 \
 *     --split-date 2026-05-27 --leads 1,2 [--stations EHAM,EGLC] [--json]
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
import { armEdgeStats, type GradedBet } from '../../packages/core/src/sim/stats.ts';
import {
  EmosStation,
  selectEntries as selectCheapEntries,
  type BucketView,
} from './db1-daybefore-efficiency.ts';
import { listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'conditional-efficiency-scan';

// =====================================================================================
// PURE HELPERS (unit-tested in conditional-efficiency-scan.test.ts — no DB access)
// =====================================================================================

/** Linear-interpolated quantile of a SORTED-ASCENDING array. NaN on empty. Shared by all three splits'
 *  train-fit cutpoints (bust P75, disagreement quartiles, tail P5/P95) — one quantile fn, three uses. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

// ── #2: post-bust reaction ──────────────────────────────────────────────────────────────────────────

/** The pre-registered per-station bust cutoff: P75 of |bust| on TRAIN values only. */
export function fitBustCutoff(trainAbsErrors: number[]): number {
  return quantile([...trainAbsErrors].sort((a, b) => a - b), 0.75);
}
/** A day is a "bust" iff its |forecast − obs| at decision time clears the station's TRAIN-fit P75. */
export function isBust(absError: number, cutoff: number): boolean {
  return Number.isFinite(absError) && Number.isFinite(cutoff) && absError >= cutoff;
}

// ── #3: regime-conditional efficiency ───────────────────────────────────────────────────────────────

export interface QuartileCutpoints {
  q25: number;
  q50: number;
  q75: number;
}
/** The pre-registered per-station disagreement quartile boundaries, fit on TRAIN values only. */
export function fitQuartileCutpoints(trainVals: number[]): QuartileCutpoints {
  const sorted = [...trainVals].sort((a, b) => a - b);
  return { q25: quantile(sorted, 0.25), q50: quantile(sorted, 0.5), q75: quantile(sorted, 0.75) };
}
/** Which TRAIN-fit quartile a TEST value falls into (1=lowest disagreement .. 4=highest). null on non-finite. */
export function classifyQuartile(v: number, c: QuartileCutpoints): 1 | 2 | 3 | 4 | null {
  if (!Number.isFinite(v)) return null;
  if (v <= c.q25) return 1;
  if (v <= c.q50) return 2;
  if (v <= c.q75) return 3;
  return 4;
}

// ── #4: extreme/tail-day calibration ────────────────────────────────────────────────────────────────

export interface TailCutpoints {
  p05: number;
  p95: number;
}
/** The pre-registered per-station climatological tail cutpoints (P5/P95 of realized obs), TRAIN only. */
export function fitTailCutpoints(trainObsNative: number[]): TailCutpoints {
  const sorted = [...trainObsNative].sort((a, b) => a - b);
  return { p05: quantile(sorted, 0.05), p95: quantile(sorted, 0.95) };
}
/** A day is "extreme" iff the realized obs sits at/beyond the station's TRAIN-fit P5 or P95. */
export function isExtremeDay(obsNative: number, c: TailCutpoints): boolean {
  return Number.isFinite(obsNative) && (obsNative <= c.p05 || obsNative >= c.p95);
}

/** The calendar day after a plain YYYY-MM-DD (no tz — target_date is a DATE column, not an instant, so
 *  plain UTC day-increment is correct and needs no IANA lookup). Pure. */
export function addDaysISO(dateISO: string, n: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The FAR-TAIL bucket rule: every bucket ≥ minDistance ladder-positions from the day's calibrated mode —
 * the buckets the FORECAST ITSELF treats as longshots (distinct from #2's CHEAP_LONGSHOT_MAX_ASK, which
 * is a market-PRICE threshold; this is a model-DISTANCE threshold, so it applies even to buckets with no
 * usable ask yet, though only asked buckets are scorable). Pure; [] on an empty/degenerate input.
 */
export function selectFarTailBuckets(views: BucketView[], minDistance = 2): BucketView[] {
  let modePos = -1;
  let modeP = Number.NEGATIVE_INFINITY;
  views.forEach((v, i) => {
    if (v.calibratedP > modeP) {
      modeP = v.calibratedP;
      modePos = i;
    }
  });
  if (modePos < 0) return [];
  return views.filter((_, i) => Math.abs(i - modePos) >= minDistance);
}

// =====================================================================================
// EXPERIMENT (SQL prepared, verified against db1-daybefore-efficiency.ts's live schema — NOT EXECUTED)
// =====================================================================================

export interface ScanArgs {
  from: string;
  to: string;
  /** TRAIN = target_date < splitDate; TEST = target_date >= splitDate. Cutpoints fit on TRAIN only. */
  splitDate: string;
  leads: number[];
  stations?: string[];
}

interface DayObs {
  icao: string;
  targetDate: string;
  absError: number; // #2: |mu_N - obs(N)| at decision time (lead 1)
  disagreement: number | null; // #3: cross-model spread at decision time (lead 1)
  obsNative: number; // #4: the realized Tmax in the station's native unit
}

export interface ScanResult {
  nStations: number;
  bust: { nTrainDays: number; nTestDays: number; nTriggered: number; stats: ReturnType<typeof armEdgeStats> };
  regime: Record<1 | 2 | 3 | 4, ReturnType<typeof armEdgeStats>>;
  tail: { nExtremeDays: number; stats: ReturnType<typeof armEdgeStats> };
}

export interface ScanDeps {
  db: Db;
  log: (msg: string) => void;
}

/**
 * Load + walk the SAME base dataset as db1-daybefore-efficiency.ts's runDb1 (forecasts, observations,
 * resolved bucket markets, day-before asks), fold EmosStation forward exactly once, and classify each
 * (station, day) three ways. Reuses EmosStation/selectCheapEntries verbatim — this function does not
 * re-derive KILL-GATE 2's calibration or entry-selection logic, only ADDS the three conditioning splits.
 *
 * NOT YET RUN. Every query below is copied from (or trivially adapted from) db1-daybefore-efficiency.ts,
 * which IS live-verified — but this function's own control flow (the bust/regime/tail bookkeeping) has
 * only been exercised by the pure-helper unit tests above, never against the real database. Treat the
 * FIRST real run as a first pass, same as any new analysis script in this project — check the printed
 * nTrainDays/nTestDays/nTriggered/nExtremeDays counts for sanity before trusting the gate verdicts.
 */
export async function runScan(args: ScanArgs, deps: ScanDeps): Promise<ScanResult> {
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

  // forecasts (backfill slot) — identical query to db1-daybefore-efficiency.ts
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

  // finalized observations, °C internally (native unit kept separately for #4's climatology) — identical
  // query to db1-daybefore-efficiency.ts, plus we keep the NATIVE value (item #4 classifies in native units).
  const oRows = await db.query<{ icao: string; date_local: string | Date; tmax_wu_native: number; unit: 'C' | 'F' }>(
    `select icao, date_local, tmax_wu_native, unit
     from observations where finalized_at is not null and icao = any($1) and date_local <= $2`,
    [icaos, args.to],
  );
  const obsC = new Map<string, Map<string, number>>(); // °C, for the EMOS fold
  const obsNative = new Map<string, Map<string, number>>(); // native unit, for #4's climatology
  for (const r of oRows) {
    const t = dISO(r.date_local);
    const native = Number(r.tmax_wu_native);
    const unit = r.unit ?? unitByIcao.get(r.icao);
    const mC = obsC.get(r.icao) ?? new Map<string, number>();
    mC.set(t, unit === 'F' ? fToC(native) : native);
    obsC.set(r.icao, mC);
    const mN = obsNative.get(r.icao) ?? new Map<string, number>();
    mN.set(t, native);
    obsNative.set(r.icao, mN);
  }

  // resolved bucket markets + ladders + day-before asks — IDENTICAL queries to db1-daybefore-efficiency.ts
  // (reused verbatim; see that file for the query provenance / forward-capture-audit note on the day-before
  // ask window). #2 needs event N+1 for the SAME city as a bust on day N — the eventByKey index below
  // covers that (bust on icao X day N -> look up icao X day N+1 directly, same map).
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

  // --- PASS 1: walk-forward EMOS, recording per-(station,day) bust/disagreement/obsNative (leads split
  //     TRAIN/TEST by args.splitDate) — no scoring yet, just the classification inputs. ---
  const stateByIcao = new Map(icaos.map((i) => [i, new EmosStation(cfg)]));
  const decisionLead = args.leads.includes(1) ? 1 : args.leads[0]!;
  const allDays: DayObs[] = [];

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
      const oNative = obsNative.get(icao)?.get(d);
      const byLeadMap = fc.get(icao)?.get(d);
      if (o === undefined || oNative === undefined || !byLeadMap) { foldDay(icao, d); continue; }
      const sm = stateByIcao.get(icao)!;
      const points = [...(byLeadMap.get(decisionLead) ?? new Map())].map(([model, f]) => ({ model, f }));
      if (points.length > 0) {
        const mu = sm.blendedMu(points, decisionLead);
        if (mu != null && Number.isFinite(mu)) {
          allDays.push({
            icao, targetDate: d, absError: Math.abs(mu - o),
            disagreement: sm.disagreement(points, decisionLead), obsNative: oNative,
          });
        }
      }
      foldDay(icao, d);
    }
  }
  log(`${SCRIPT}: walked ${allDays.length} (station,day) decision points across ${icaos.length} stations`);

  const train = allDays.filter((r) => r.targetDate < args.splitDate);
  const test = allDays.filter((r) => r.targetDate >= args.splitDate);

  // per-station cutpoints, fit on TRAIN only
  const byStationTrain = new Map<string, DayObs[]>();
  for (const r of train) { const a = byStationTrain.get(r.icao) ?? []; a.push(r); byStationTrain.set(r.icao, a); }
  const bustCutoffByStation = new Map<string, number>();
  const quartileCutpointsByStation = new Map<string, QuartileCutpoints>();
  const tailCutpointsByStation = new Map<string, TailCutpoints>();
  for (const [icao, rows] of byStationTrain) {
    bustCutoffByStation.set(icao, fitBustCutoff(rows.map((r) => r.absError)));
    quartileCutpointsByStation.set(
      icao,
      fitQuartileCutpoints(rows.map((r) => r.disagreement).filter((v): v is number => Number.isFinite(v))),
    );
    tailCutpointsByStation.set(icao, fitTailCutpoints(rows.map((r) => r.obsNative)));
  }

  // --- helper: calibratedP + day-before ask views for ONE event, at the decision lead ---
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

  // --- PASS 2 (#2): for each TEST-period bust day N, score city N's event N+1's cheap-subset edge ---
  const bustBets: GradedBet[] = [];
  let nTriggered = 0;
  for (const r of test) {
    const cutoff = bustCutoffByStation.get(r.icao);
    if (cutoff === undefined || !isBust(r.absError, cutoff)) continue;
    nTriggered++;
    const nextTargetDate = addDaysISO(r.targetDate, 1);
    const evNext = eventByKey.get(`${r.icao}|${nextTargetDate}`);
    if (!evNext) continue; // no resolved N+1 event for this city (edge of the archive, or a gap) — skip
    const views = viewsFor(evNext, stateByIcao.get(r.icao)!, nextTargetDate);
    if (!views) continue;
    for (const e of selectCheapEntries(views).filter((x) => x.inCheapSubset)) {
      bustBets.push({ won: e.isWinner, ask: e.ask });
    }
  }

  // --- PASS 3 (#3): for each TEST day, classify its disagreement quartile and score that event's OWN
  //     cheap-subset edge (KILL-GATE 2's exact metric, sliced by quartile instead of pooled). ---
  const regimeBets: Record<1 | 2 | 3 | 4, GradedBet[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const r of test) {
    const c = quartileCutpointsByStation.get(r.icao);
    if (!c || r.disagreement == null) continue;
    const q = classifyQuartile(r.disagreement, c);
    if (q == null) continue;
    const ev = eventByKey.get(`${r.icao}|${r.targetDate}`);
    if (!ev) continue;
    const views = viewsFor(ev, stateByIcao.get(r.icao)!, r.targetDate);
    if (!views) continue;
    for (const e of selectCheapEntries(views).filter((x) => x.inCheapSubset)) {
      regimeBets[q].push({ won: e.isWinner, ask: e.ask });
    }
  }

  // --- PASS 4 (#4): on TEST-period extreme days, score the far-tail buckets' calibration ---
  const tailBets: GradedBet[] = [];
  let nExtremeDays = 0;
  for (const r of test) {
    const c = tailCutpointsByStation.get(r.icao);
    if (!c || !isExtremeDay(r.obsNative, c)) continue;
    nExtremeDays++;
    const ev = eventByKey.get(`${r.icao}|${r.targetDate}`);
    if (!ev) continue;
    const views = viewsFor(ev, stateByIcao.get(r.icao)!, r.targetDate);
    if (!views) continue;
    for (const v of selectFarTailBuckets(views, 2)) {
      if (v.ask == null || !Number.isFinite(v.ask) || v.ask <= 0 || v.ask > 1) continue;
      tailBets.push({ won: v.isWinner, ask: v.ask });
    }
  }

  return {
    nStations: icaos.length,
    bust: { nTrainDays: train.length, nTestDays: test.length, nTriggered, stats: armEdgeStats(bustBets) },
    regime: { 1: armEdgeStats(regimeBets[1]), 2: armEdgeStats(regimeBets[2]), 3: armEdgeStats(regimeBets[3]), 4: armEdgeStats(regimeBets[4]) },
    tail: { nExtremeDays, stats: armEdgeStats(tailBets) },
  };
}

// =====================================================================================
// REPORT
// =====================================================================================

const pp = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' : 'n/a');

export function report(res: ScanResult, args: ScanArgs, log: (m: string) => void): void {
  log(`=== ${SCRIPT} ${args.from} → ${args.to} (split ${args.splitDate}) · ${res.nStations} stations ===`);
  log('');
  log('#2 POST-BUST REACTION (TEST period only; gate: >=40 events, >=6 cities, edge CI excludes 0):');
  log(`  train days ${res.bust.nTrainDays} · test days ${res.bust.nTestDays} · bust-triggered ${res.bust.nTriggered}`);
  log(`  n=${res.bust.stats.nGraded} edge ${pp(res.bust.stats.edge)} [${pp(res.bust.stats.edgeCiLo)}, ${pp(res.bust.stats.edgeCiHi)}]`);
  log('');
  log('#3 REGIME-CONDITIONAL EFFICIENCY (TEST period only; gate: Q4 edge CI excludes 0, >=30 station-days):');
  for (const q of [1, 2, 3, 4] as const) {
    const s = res.regime[q];
    log(`  Q${q} n=${s.nGraded} edge ${pp(s.edge)} [${pp(s.edgeCiLo)}, ${pp(s.edgeCiHi)}]`);
  }
  log('');
  log('#4 TAIL-DAY CALIBRATION (TEST period only; gate: >=30 extreme days, gap CI excludes 0):');
  log(`  extreme days ${res.tail.nExtremeDays} · far-tail bets n=${res.tail.stats.nGraded}`);
  log(`  realized-vs-ask gap ${pp(res.tail.stats.edge)} [${pp(res.tail.stats.edgeCiLo)}, ${pp(res.tail.stats.edgeCiHi)}]`);
}

// =====================================================================================
// SELF-TEST + CLI
// =====================================================================================

function sanity(): void {
  if (quantile([1, 2, 3, 4], 0.5) !== 2.5) throw new Error('sanity: quantile median wrong');
  if (fitBustCutoff([1, 2, 3, 4, 5, 6, 7, 8]) !== quantile([1, 2, 3, 4, 5, 6, 7, 8], 0.75)) throw new Error('sanity: fitBustCutoff wrong');
  const c = fitQuartileCutpoints([1, 2, 3, 4]);
  if (classifyQuartile(0.5, c) !== 1 || classifyQuartile(100, c) !== 4) throw new Error('sanity: classifyQuartile wrong');
  const t = fitTailCutpoints([10, 20, 30, 40, 50]);
  if (!isExtremeDay(t.p05, t) || isExtremeDay((t.p05 + t.p95) / 2, t)) throw new Error('sanity: isExtremeDay wrong');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      'split-date': { type: 'string' },
      leads: { type: 'string' },
      stations: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const db = makeScriptDb();
  try {
    const args: ScanArgs = {
      from: values.from ?? '2026-04-21',
      to: values.to ?? '2026-06-21',
      splitDate: values['split-date'] ?? '2026-05-27', // ~60/40 split, matching the sim-maker-exit convention
      leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
      stations: splitList(values.stations),
    };
    const res = await runScan(args, { db, log: console.log });
    report(res, args, console.log);
    if (values.json) console.log('JSON ' + JSON.stringify(res));
  } finally {
    await db.end();
  }
}
