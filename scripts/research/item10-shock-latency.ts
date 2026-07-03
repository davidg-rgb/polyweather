/**
 * scripts/research/item10-shock-latency — SIGNAL-BACKLOG.md item 10: model-update-shock latency.
 *
 * PRE-REGISTERED DESIGN (locked before any measurement — see SIGNAL-BACKLOG.md "## 10." for the full
 * rationale; this file implements exactly the "📌 PRE-REGISTERED (2026-07-03 ~19:15)" block, no deviation):
 *
 *   - SHOCK EVENT: for station S / target day T at pipeline build B_k (the 2×/day '10Z'/'22Z' distribution
 *     builds), Δ_k = |blendedMu(B_k) − blendedMu(B_{k−1})| AT MATCHING LEAD. Consecutive builds "at matching
 *     lead" are the SAME calendar day's 10Z→22Z pair (both target the same T at the same integer lead_days,
 *     since lead is measured from build-CALENDAR-DAY to T) — the overnight 22Z→10Z transition changes
 *     lead_days by construction, so it is excluded by the "matching lead" qualifier, not by omission.
 *     A shock iff Δ_k ≥ the per-station P90 of Δ, fit on the TRAIN half only (2026-04-21→05-27, same window/
 *     split as items 2–4, `conditional-efficiency-scan.ts`).
 *   - SIGNAL (no look-ahead): post-B_k (the 22Z build, the later/revised one) calibratedP vs the first
 *     market_snapshots ask captured ≥ B_k+20min; m = calibratedP − ask.
 *   - ENTRY RULE: taker buy of the max-m bucket iff m ≥ +5pp and ask ≤ 0.60, entry window capped at B_k+2h,
 *     hold to resolution. TEST half only (2026-05-27→06-21).
 *   - GATE: PASS iff n ≥ 40 shock-bets, ≥ 6 cities, per-bet edge 95% CI excludes 0 positive (day-clustered CI
 *     reported alongside). Honest prior: KILL. If intraday post-build asks aren't recoverable at this
 *     resolution from market_snapshots, the outcome is INSUFFICIENT_DATA — this script does NOT substitute
 *     a different data source (e.g. the local market-history archive's synthetic-spread book, or the
 *     per-minute `market_price_history` last-trade-price series) for the pre-registered "snapshot ask";
 *     see the header note in `runItem10` on why those are a DIFFERENT design, not this one.
 *
 * REUSE (no re-derivation): `EmosStation` (db1-daybefore-efficiency.ts) for the walk-forward blended-μ/σ
 * state; `quantile` (conditional-efficiency-scan.ts) for the TRAIN-fit P90 cutoff machinery;
 * `armEdgeStats`/`GradedBet` (core/sim/stats.ts) for the i.i.d. per-bet edge ± CI (this project's standard
 * "edge" statistic — mean(won − ask), the same metric every prior signal test reports); `clusterMeanTCi`
 * (core/sim/selector-learn.ts) for the day-clustered CI, reused verbatim (not re-derived) for the "alongside"
 * report the team asked for.
 *
 * Run: pnpm tsx scripts/research/item10-shock-latency.ts [--from 2026-04-21] [--to 2026-06-21]
 *        [--split-date 2026-05-27] [--leads 1,2] [--stations EHAM,EGLC] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gaussianBucketProbs, parseConfigRows, toNative, fToC, type BucketDef } from '../../packages/core/src/index.ts';
import { armEdgeStats, type GradedBet } from '../../packages/core/src/sim/stats.ts';
import { clusterMeanTCi } from '../../packages/core/src/sim/selector-learn.ts';
import { EmosStation } from './db1-daybefore-efficiency.ts';
import { quantile } from './conditional-efficiency-scan.ts';
import { listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'item10-shock-latency';

// =====================================================================================
// PURE HELPERS (self-tested by sanity() below — no DB access)
// =====================================================================================

export const SHOCK_ENTRY_MIN_EDGE_PP = 0.05; // +5pp
export const SHOCK_ENTRY_MAX_ASK = 0.6;
export const SHOCK_ENTRY_WINDOW_START_MIN = 20;
export const SHOCK_ENTRY_WINDOW_END_MIN = 120; // 2h

/** The pre-registered per-station shock cutoff: P90 of |Δ blendedMu| on TRAIN values only. */
export function fitShockCutoffP90(trainDeltas: number[]): number {
  return quantile([...trainDeltas].sort((a, b) => a - b), 0.9);
}
/** A build-pair is a "shock" iff its Δ clears the station's TRAIN-fit P90. */
export function isShock(delta: number, cutoff: number): boolean {
  return Number.isFinite(delta) && Number.isFinite(cutoff) && delta >= cutoff;
}

/** One bucket's post-shock view: our calibratedP at B_k (the revised/22Z build) + the first recoverable
 *  market_snapshots ask in the [B_k+20min, B_k+2h] window (null when unrecoverable in that window). */
export interface ShockBucketView {
  bucketIdx: number;
  calibratedP: number;
  entryAsk: number | null;
  isWinner: boolean;
}
export interface ShockEntry {
  bucketIdx: number;
  m: number;
  ask: number;
  isWinner: boolean;
}

/**
 * The pre-registered entry rule: among buckets with a recoverable entry ask, pick the MAX-m bucket subject
 * to m ≥ +5pp and ask ≤ 0.60 (m = calibratedP − ask). null when no bucket qualifies (no recoverable ask at
 * all, or none clears both the edge floor and the price ceiling). Deterministic, side-effect-free.
 */
export function selectShockEntry(views: ShockBucketView[]): ShockEntry | null {
  let best: ShockEntry | null = null;
  for (const v of views) {
    const ask = v.entryAsk;
    if (ask == null || !Number.isFinite(ask) || ask <= 0 || ask > 1) continue;
    if (ask > SHOCK_ENTRY_MAX_ASK) continue;
    const m = v.calibratedP - ask;
    if (m < SHOCK_ENTRY_MIN_EDGE_PP) continue;
    if (!best || m > best.m) best = { bucketIdx: v.bucketIdx, m, ask, isWinner: v.isWinner };
  }
  return best;
}

// =====================================================================================
// EXPERIMENT
// =====================================================================================

export interface Item10Args {
  from: string;
  to: string;
  splitDate: string;
  leads: number[];
  stations?: string[];
  json: boolean;
}

interface BuildPoint {
  captured: string; // ISO calendar day of capture (UTC)
  capturedAt: string; // full timestamptz ISO
  points: { model: string; f: number }[];
}
/** One (icao, targetDate, leadDays) build-pair group: the '10Z' and '22Z' rows captured the SAME calendar
 *  day (guaranteed same lead_days — see the header's "at matching lead" note). */
interface BuildPairGroup {
  icao: string;
  targetDate: string;
  leadDays: number;
  capturedDay: string;
  slot10: BuildPoint | null;
  slot22: BuildPoint | null;
}
interface DeltaRow {
  icao: string;
  targetDate: string;
  leadDays: number;
  delta: number;
  bkCapturedAt: string; // the 22Z (post-shock) build's captured_at — B_k for scoring
}

interface EventRow {
  eventId: string;
  icao: string;
  targetDate: string;
  unit: 'C' | 'F';
  winnerIdx: number;
  bucketDefs: BucketDef[];
  bucketIdxs: number[];
}

export interface Item10Result {
  nStations: number;
  nTrainDeltas: number;
  nTestDeltas: number;
  nTestShocks: number;
  nShocksWithMarket: number;
  nShocksWithRecoverableAsk: number;
  nShocksWithQualifyingEntry: number;
  bets: GradedBet[];
  betCities: string[];
  betDates: string[];
  edge: ReturnType<typeof armEdgeStats>;
  dayClusteredEdge: ReturnType<typeof clusterMeanTCi>;
}
export interface Item10Deps {
  db: Db;
  log: (msg: string) => void;
}

const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export async function runItem10(args: Item10Args, deps: Item10Deps): Promise<Item10Result> {
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

  // --- the 2x/day LIVE builds (NOT 'backfill' — that slot is a single-per-day reconstruction with no
  //     intraday pair to diff). captured_at is required to pair same-calendar-day 10Z/22Z rows. ---
  const buildRows = await db.query<{
    icao: string; model: string; target_date: string | Date; lead_days: number;
    snapshot_slot: '10Z' | '22Z'; tmax_c: string; captured_at: string | Date;
  }>(
    `select icao, model, target_date, lead_days, snapshot_slot, tmax_c, captured_at
     from forecast_snapshots
     where snapshot_slot in ('10Z','22Z') and icao = any($1) and lead_days = any($2)
       and target_date >= $3 and target_date <= $4
     order by icao, target_date, lead_days, captured_at`,
    [icaos, args.leads, args.from, args.to],
  );
  log(`${SCRIPT}: ${buildRows.length} raw 10Z/22Z forecast_snapshots rows in scope`);

  const groups = new Map<string, BuildPairGroup>();
  for (const r of buildRows) {
    const targetDate = dISO(r.target_date);
    const capturedAt = typeof r.captured_at === 'string' ? r.captured_at : r.captured_at.toISOString();
    const capturedDay = dISO(capturedAt);
    const key = `${r.icao}|${targetDate}|${r.lead_days}|${capturedDay}`;
    let g = groups.get(key);
    if (!g) { g = { icao: r.icao, targetDate, leadDays: r.lead_days, capturedDay, slot10: null, slot22: null }; groups.set(key, g); }
    const slot = r.snapshot_slot === '10Z' ? 'slot10' : 'slot22';
    let bp = g[slot];
    if (!bp) { bp = { captured: capturedDay, capturedAt, points: [] }; g[slot] = bp; }
    bp.points.push({ model: r.model, f: Number(r.tmax_c) });
    if (capturedAt > bp.capturedAt) bp.capturedAt = capturedAt; // last row's timestamp within the slot (rows share the same run, trivial tie)
  }
  // index groups needing BOTH slots, by (icao, capturedDay) for the O(1) per-day walk-forward lookup
  const groupsByIcaoDay = new Map<string, BuildPairGroup[]>();
  let nPairsTotal = 0;
  for (const g of groups.values()) {
    if (!g.slot10 || !g.slot22) continue;
    nPairsTotal++;
    const k = `${g.icao}|${g.capturedDay}`;
    const arr = groupsByIcaoDay.get(k) ?? [];
    arr.push(g);
    groupsByIcaoDay.set(k, arr);
  }
  log(`${SCRIPT}: ${nPairsTotal} same-day 10Z+22Z build-pairs (both slots present)`);

  // --- finalized observations (identical query to db1-daybefore-efficiency.ts) ---
  const oRows = await db.query<{ icao: string; date_local: string | Date; tmax_wu_native: number; unit: 'C' | 'F' }>(
    `select icao, date_local, tmax_wu_native, unit
     from observations where finalized_at is not null and icao = any($1) and date_local <= $2`,
    [icaos, args.to],
  );
  const obs = new Map<string, Map<string, number>>();
  for (const r of oRows) {
    const m = obs.get(r.icao) ?? new Map<string, number>();
    const native = Number(r.tmax_wu_native);
    m.set(dISO(r.date_local), (r.unit ?? unitByIcao.get(r.icao)) === 'F' ? fToC(native) : native);
    obs.set(r.icao, m);
  }

  // --- resolved bucket markets + ladders (identical shape to db1-daybefore-efficiency.ts, [from,to] scope) ---
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
  const laddersByEvent = new Map<string, { bucketIdx: number; low: number | null; high: number | null }[]>();
  for (const r of bRows) {
    const arr = laddersByEvent.get(r.event_id) ?? [];
    arr.push({ bucketIdx: r.bucket_idx, low: r.low_native, high: r.high_native });
    laddersByEvent.set(r.event_id, arr);
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
    });
  }
  const eventByKey = new Map<string, EventRow>();
  for (const e of events) eventByKey.set(`${e.icao}|${e.targetDate}`, e);
  log(`${SCRIPT}: ${events.length} resolved bucket events with a usable ladder in [${args.from}, ${args.to}]`);

  // --- walk-forward EMOS (IDENTICAL fold discipline to db1/conditional-scan): score builds captured on
  //     day d using state as of day d (before that day's own truth is folded), then fold. ---
  const stateByIcao = new Map(icaos.map((i) => [i, new EmosStation(cfg)]));
  const allTargets = new Set<string>();
  for (const r of buildRows) allTargets.add(dISO(r.target_date));

  // db1/conditional-scan fold the SAME-DAY forecast for (icao, t) as the truth update; we need the identical
  // fold source. Re-derive it from the raw buildRows (10Z preferred, else 22Z — either is a valid same-day
  // forecast-for-today input; the bias EMA is insensitive to which intraday slot supplies it).
  const todaysForecast = new Map<string, Map<string, Map<number, Map<string, number>>>>(); // icao -> t -> lead -> model -> f
  for (const r of buildRows) {
    const t = dISO(r.target_date);
    const byT = todaysForecast.get(r.icao) ?? new Map();
    const byLead = byT.get(t) ?? new Map();
    const byModel = byLead.get(r.lead_days) ?? new Map();
    if (!byModel.has(r.model) || r.snapshot_slot === '22Z') byModel.set(r.model, Number(r.tmax_c)); // 22Z (later, more complete) wins on conflict
    byLead.set(r.lead_days, byModel);
    byT.set(t, byLead);
    todaysForecast.set(r.icao, byT);
  }
  const foldToday = (icao: string, t: string): void => {
    const o = obs.get(icao)?.get(t);
    const byLeadMap = todaysForecast.get(icao)?.get(t);
    if (o === undefined || !byLeadMap) return;
    const sm = stateByIcao.get(icao)!;
    for (const [lead, byModel] of byLeadMap) {
      if (!args.leads.includes(lead)) continue;
      sm.fold([...byModel].map(([model, f]) => ({ model, f })), lead, o);
    }
  };

  for (const t of [...allTargets].sort()) if (t < args.from) for (const icao of icaos) foldToday(icao, t);

  const deltas: DeltaRow[] = [];
  for (const d of listDatesISO(args.from, args.to)) {
    for (const icao of icaos) {
      const sm = stateByIcao.get(icao)!;
      const pairs = groupsByIcaoDay.get(`${icao}|${d}`) ?? [];
      for (const g of pairs) {
        const mu10 = sm.blendedMu(g.slot10!.points, g.leadDays);
        const mu22 = sm.blendedMu(g.slot22!.points, g.leadDays);
        if (mu10 == null || mu22 == null || !Number.isFinite(mu10) || !Number.isFinite(mu22)) continue;
        deltas.push({ icao, targetDate: g.targetDate, leadDays: g.leadDays, delta: Math.abs(mu22 - mu10), bkCapturedAt: g.slot22!.capturedAt });
      }
      foldToday(icao, d);
    }
  }
  log(`${SCRIPT}: ${deltas.length} scoreable build-pair deltas (both blendedMu finite)`);

  const train = deltas.filter((r) => r.targetDate < args.splitDate);
  const test = deltas.filter((r) => r.targetDate >= args.splitDate);

  const cutoffByStation = new Map<string, number>();
  const trainByStation = new Map<string, number[]>();
  for (const r of train) { const a = trainByStation.get(r.icao) ?? []; a.push(r.delta); trainByStation.set(r.icao, a); }
  for (const [icao, ds] of trainByStation) cutoffByStation.set(icao, fitShockCutoffP90(ds));

  const testShocks = test.filter((r) => isShock(r.delta, cutoffByStation.get(r.icao) ?? NaN));
  log(`${SCRIPT}: ${testShocks.length} TEST-half build-pairs clear the per-station TRAIN P90 cutoff`);

  // --- score each TEST shock: needs a resolved event + a recoverable post-B_k ask ---
  let nShocksWithMarket = 0;
  const scorable: { ev: EventRow; icao: string; bkCapturedAt: string; leadDays: number }[] = [];
  for (const s of testShocks) {
    const ev = eventByKey.get(`${s.icao}|${s.targetDate}`);
    if (!ev) continue;
    nShocksWithMarket++;
    scorable.push({ ev, icao: s.icao, bkCapturedAt: s.bkCapturedAt, leadDays: s.leadDays });
  }

  // batch-fetch the first recoverable ask per (event, bucket) in [B_k+20min, B_k+2h] — ONE round trip.
  const entryAsksByEventBucket = new Map<string, number | null>();
  if (scorable.length > 0) {
    const eventIds = scorable.map((s) => s.ev.eventId);
    const bks = scorable.map((s) => s.bkCapturedAt);
    const askRows = await db.query<{ event_id: string; bucket_idx: number; entry_ask: string | null }>(
      `select se.event_id, mb.bucket_idx,
              (select ms.best_ask from market_snapshots ms
                 where ms.bucket_id = mb.id
                   and ms.captured_at >= se.bk_ts + interval '${SHOCK_ENTRY_WINDOW_START_MIN} minutes'
                   and ms.captured_at <= se.bk_ts + interval '${SHOCK_ENTRY_WINDOW_END_MIN} minutes'
                   and ms.best_ask is not null
                 order by ms.captured_at asc limit 1) entry_ask
       from unnest($1::text[], $2::timestamptz[]) as se(event_id, bk_ts)
       join market_buckets mb on mb.event_id::text = se.event_id`,
      [eventIds, bks],
    );
    for (const r of askRows) {
      entryAsksByEventBucket.set(`${r.event_id}|${r.bucket_idx}`, r.entry_ask == null ? null : Number(r.entry_ask));
    }
  }

  let nShocksWithRecoverableAsk = 0;
  let nShocksWithQualifyingEntry = 0;
  const bets: GradedBet[] = [];
  const betDatesList: string[] = []; // parallel to `bets`, 1:1 — the day-cluster key per graded bet
  const betCities = new Set<string>();
  const betDates = new Set<string>();
  for (const s of scorable) {
    const { ev, icao, leadDays } = s;
    const sm = stateByIcao.get(icao)!;
    // recompute calibratedP at B_k = the 22Z (post-shock) build's points — same sigma/bias state used for Δ.
    const key = `${icao}|${ev.targetDate}|${leadDays}|${dISO(s.bkCapturedAt)}`;
    const g = groups.get(key);
    if (!g?.slot22) continue;
    const mu = sm.blendedMu(g.slot22.points, leadDays);
    const sigmaC = sm.sigma(leadDays);
    if (mu == null || sigmaC == null || !Number.isFinite(mu) || !Number.isFinite(sigmaC)) continue;
    const muNative = toNative(mu, ev.unit);
    const sigmaNative = ev.unit === 'F' ? sigmaC * (9 / 5) : sigmaC;
    if (sigmaNative <= 0.2) continue;
    let probs: number[];
    try {
      probs = gaussianBucketProbs(muNative, sigmaNative, ev.bucketDefs);
    } catch {
      continue;
    }
    const anyAsk = ev.bucketIdxs.some((idx) => entryAsksByEventBucket.get(`${ev.eventId}|${idx}`) != null);
    if (anyAsk) nShocksWithRecoverableAsk++;
    const views: ShockBucketView[] = ev.bucketIdxs.map((idx, i) => ({
      bucketIdx: idx,
      calibratedP: probs[i]!,
      entryAsk: entryAsksByEventBucket.get(`${ev.eventId}|${idx}`) ?? null,
      isWinner: idx === ev.winnerIdx,
    }));
    const entry = selectShockEntry(views);
    if (!entry) continue;
    nShocksWithQualifyingEntry++;
    bets.push({ won: entry.isWinner, ask: entry.ask });
    betDatesList.push(ev.targetDate); // 1:1 with `bets` — the day-cluster key for THIS bet
    betCities.add(icao);
    betDates.add(ev.targetDate);
  }

  // day-clustered CI (clusterMeanTCi, reused verbatim from selector-learn.ts) over the SAME (won − ask)
  // values armEdgeStats scores i.i.d. — `betDatesList` is built 1:1 with `bets` above, so no re-derivation.
  const edgeValues = bets.map((b) => (b.won ? 1 : 0) - b.ask);

  return {
    nStations: icaos.length,
    nTrainDeltas: train.length,
    nTestDeltas: test.length,
    nTestShocks: testShocks.length,
    nShocksWithMarket,
    nShocksWithRecoverableAsk,
    nShocksWithQualifyingEntry,
    bets,
    betCities: [...betCities].sort(),
    betDates: [...betDates].sort(),
    edge: armEdgeStats(bets),
    dayClusteredEdge: clusterMeanTCi(edgeValues, betDatesList),
  };
}

// =====================================================================================
// REPORT
// =====================================================================================

const pp = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' : 'n/a');

export function report(res: Item10Result, args: Item10Args, log: (m: string) => void): void {
  log(`=== ${SCRIPT} ${args.from} → ${args.to} (split ${args.splitDate}) · ${res.nStations} stations ===`);
  log('');
  log(`TRAIN deltas ${res.nTrainDeltas} · TEST deltas ${res.nTestDeltas} · TEST shocks (>= per-station P90) ${res.nTestShocks}`);
  log(`  of which: resolved market exists ${res.nShocksWithMarket} · recoverable post-B_k ask in window ${res.nShocksWithRecoverableAsk} · qualifying entry (m>=+5pp, ask<=0.60) ${res.nShocksWithQualifyingEntry}`);
  log('');
  log(`GATE: n=${res.edge.nGraded} shock-bets, ${res.betCities.length} cities`);
  log(`  per-bet edge ${pp(res.edge.edge)} [${pp(res.edge.edgeCiLo)}, ${pp(res.edge.edgeCiHi)}]`);
  log(`  day-clustered edge ${pp(res.dayClusteredEdge.mean)} [${pp(res.dayClusteredEdge.lo)}, ${pp(res.dayClusteredEdge.hi)}] over ${res.betDates.length} day clusters`);
  if (args.json) log('JSON ' + JSON.stringify(res));
}

// =====================================================================================
// SELF-TEST + CLI
// =====================================================================================

function sanity(): void {
  if (fitShockCutoffP90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) !== quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)) {
    throw new Error('sanity: fitShockCutoffP90 wrong');
  }
  if (!isShock(5, 4) || isShock(3, 4)) throw new Error('sanity: isShock wrong');

  const views: ShockBucketView[] = [
    { bucketIdx: 0, calibratedP: 0.4, entryAsk: 0.3, isWinner: false }, // m=+10pp, ask<=0.6 — qualifies
    { bucketIdx: 1, calibratedP: 0.5, entryAsk: 0.2, isWinner: true }, // m=+30pp, ask<=0.6 — qualifies, bigger m
    { bucketIdx: 2, calibratedP: 0.2, entryAsk: 0.7, isWinner: false }, // ask>0.6 — excluded regardless of m
    { bucketIdx: 3, calibratedP: 0.22, entryAsk: 0.2, isWinner: false }, // m=+2pp < 5pp floor — excluded
    { bucketIdx: 4, calibratedP: 0.1, entryAsk: null, isWinner: false }, // unrecoverable — excluded
  ];
  const sel = selectShockEntry(views);
  if (!sel || sel.bucketIdx !== 1) throw new Error(`sanity: selectShockEntry picked wrong bucket: ${JSON.stringify(sel)}`);
  if (Math.abs(sel.m - 0.3) > 1e-9) throw new Error('sanity: selectShockEntry m wrong');

  const none = selectShockEntry([{ bucketIdx: 0, calibratedP: 0.1, entryAsk: null, isWinner: false }]);
  if (none !== null) throw new Error('sanity: selectShockEntry should be null with no recoverable ask');
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
    const args: Item10Args = {
      from: values.from ?? '2026-04-21',
      to: values.to ?? '2026-06-21',
      splitDate: values['split-date'] ?? '2026-05-27',
      leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
      stations: splitList(values.stations),
      json: Boolean(values.json),
    };
    const res = await runItem10(args, { db, log: console.log });
    report(res, args, console.log);
  } finally {
    await db.end();
  }
}
