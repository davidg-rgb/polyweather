/**
 * scripts/research/efficiency-monitor-run — the runnable forward EFFICIENCY-MONITOR loop (operator-requested
 * 2026-07-09). Walks the DB (stitched backfill warm-up + live-slot TEST, exactly like
 * conditional-efficiency-live.ts), builds one `MonitorEvent` per resolved TEST-window market, and feeds the
 * PURE core scorer (`core/sim/efficiency-monitor.ts`) which adjudicates BOTH strategies with the frozen
 * §9R-E gate. This is the local twin of the `efficiency-monitor` Edge function — both call the SAME pure
 * scorer so the number is identical. Read-only; no capital; the rail stays DORMANT.
 *
 *   S1 · regime + forecast cheap-subset (forward-confirms KILL-GATE 2 + C24)
 *   S2 · ladder-geometry troughs on the day-before ask ladder (forward-confirms C23-T2/T3)
 *
 * Run (outside the reserved :32-:42 UTC cron window):
 *   pnpm tsx scripts/research/efficiency-monitor-run.ts --from 2026-04-21 --switch 2026-06-15 \
 *     --to 2026-07-08 --live-slot 10Z --leads 1,2 [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gaussianBucketProbs, parseConfigRows, toNative, fToC, type BucketDef } from '../../packages/core/src/index.ts';
import {
  scoreEfficiencyMonitor, MONITOR_DEFAULTS, type MonitorEvent, type LadderLeg,
} from '../../packages/core/src/sim/efficiency-monitor.ts';
import type { GradedBet } from '../../packages/core/src/sim/stats.ts';
import { EmosStation, selectEntries as selectCheapEntries, type BucketView } from './db1-daybefore-efficiency.ts';
import { fitQuartileCutpoints, classifyQuartile, addDaysISO, type QuartileCutpoints } from './conditional-efficiency-scan.ts';
import { listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'efficiency-monitor-run';

export interface WalkArgs { from: string; switchDate: string; to: string; liveSlot: string; leads: number[]; }

interface EventRow {
  eventId: string; icao: string; targetDate: string; unit: 'C' | 'F'; winnerIdx: number;
  bucketDefs: BucketDef[]; bucketIdxs: number[]; lows: (number | null)[]; highs: (number | null)[];
  asks: Map<number, number | null>;
}

/** Temperature sort key from the bucket's numeric edges (NOT bucket_idx — trap #7). low edge orders
 *  ranges + open-top; open-bottom (low null) sits just below its high edge. Monotone across the ladder. */
function tempKey(low: number | null, high: number | null): number {
  if (low != null) return low;
  if (high != null) return high - 1;
  return Number.NEGATIVE_INFINITY;
}

/** Walk the DB into MonitorEvent[] for the TEST window (mirrors conditional-efficiency-live.ts's walk). */
export async function walkMonitorEvents(args: WalkArgs, deps: { db: Db; log: (m: string) => void }): Promise<MonitorEvent[]> {
  const { db, log } = deps;
  const cfg = parseConfigRows(await db.query<{ key: string; value: string }>(`select key, value from config`));
  const stationRows = await db.query<{ icao: string; unit: 'C' | 'F' }>(
    `select distinct s.icao, c.unit from stations s
     join city_stations cs on cs.icao = s.icao and cs.valid_to is null
     join cities c on c.id = cs.city_id`,
  );
  const icaos = stationRows.map((s) => s.icao);
  const unitByIcao = new Map(stationRows.map((s) => [s.icao, s.unit]));
  if (icaos.length === 0) throw new Error('no stations in scope');

  // stitched forecast source: backfill ≤ switch (warm-up + TRAIN), live slot > switch (TEST)
  const fRows = await db.query<{ icao: string; model: string; target_date: string | Date; lead_days: number; tmax_c: string }>(
    `select icao, model, target_date, lead_days, tmax_c from forecast_snapshots
     where icao = any($1) and lead_days = any($2) and target_date <= $3
       and ( (snapshot_slot='backfill' and target_date <= $4) or (snapshot_slot=$5 and target_date > $4) )`,
    [icaos, args.leads, args.to, args.switchDate, args.liveSlot],
  );
  const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  const fc = new Map<string, Map<string, Map<number, Map<string, number>>>>();
  for (const r of fRows) {
    const t = dISO(r.target_date);
    const byT = fc.get(r.icao) ?? new Map(); const byLead = byT.get(t) ?? new Map(); const byModel = byLead.get(r.lead_days) ?? new Map();
    byModel.set(r.model, Number(r.tmax_c)); byLead.set(r.lead_days, byModel); byT.set(t, byLead); fc.set(r.icao, byT);
  }
  const oRows = await db.query<{ icao: string; date_local: string | Date; tmax_wu_native: number; unit: 'C' | 'F' }>(
    `select icao, date_local, tmax_wu_native, unit from observations
     where finalized_at is not null and icao = any($1) and date_local <= $2`,
    [icaos, args.to],
  );
  const obsC = new Map<string, Map<string, number>>();
  for (const r of oRows) {
    const t = dISO(r.date_local); const native = Number(r.tmax_wu_native); const unit = r.unit ?? unitByIcao.get(r.icao);
    const mC = obsC.get(r.icao) ?? new Map<string, number>(); mC.set(t, unit === 'F' ? fToC(native) : native); obsC.set(r.icao, mC);
  }
  const evRows = await db.query<{ event_id: string; icao: string | null; target_date: string | Date; unit: 'C' | 'F'; winning_bucket_idx: number }>(
    `select me.id event_id, me.icao_at_creation icao, me.target_date, me.unit, me.winning_bucket_idx from market_events me
     where me.ladder_ok and me.winning_bucket_idx is not null and me.icao_at_creation = any($1) and me.target_date >= $2 and me.target_date <= $3`,
    [icaos, args.from, args.to],
  );
  const bRows = await db.query<{ event_id: string; bucket_idx: number; low_native: number | null; high_native: number | null }>(
    `select mb.event_id, mb.bucket_idx, mb.low_native, mb.high_native from market_buckets mb
     join market_events me on me.id = mb.event_id
     where me.ladder_ok and me.winning_bucket_idx is not null and me.icao_at_creation = any($1) and me.target_date >= $2 and me.target_date <= $3
     order by mb.event_id, mb.bucket_idx`,
    [icaos, args.from, args.to],
  );
  const askRows = await db.query<{ event_id: string; bucket_idx: number; day_before_ask: string | null }>(
    `select me.id event_id, mb.bucket_idx,
            (select ms.best_ask from market_snapshots ms
               where ms.bucket_id = mb.id and ms.captured_at >= (me.target_date - 1)::timestamptz
                 and ms.captured_at < (me.target_date)::timestamptz and ms.best_ask is not null
               order by ms.captured_at desc limit 1) day_before_ask
     from market_events me join market_buckets mb on mb.event_id = me.id
     where me.ladder_ok and me.winning_bucket_idx is not null and me.icao_at_creation = any($1) and me.target_date >= $2 and me.target_date <= $3`,
    [icaos, args.from, args.to],
  );

  const laddersByEvent = new Map<string, { bucketIdx: number; low: number | null; high: number | null }[]>();
  for (const r of bRows) { const a = laddersByEvent.get(r.event_id) ?? []; a.push({ bucketIdx: r.bucket_idx, low: r.low_native, high: r.high_native }); laddersByEvent.set(r.event_id, a); }
  const asksByEvent = new Map<string, Map<number, number | null>>();
  for (const r of askRows) { const m = asksByEvent.get(r.event_id) ?? new Map(); m.set(r.bucket_idx, r.day_before_ask == null ? null : Number(r.day_before_ask)); asksByEvent.set(r.event_id, m); }
  const events: EventRow[] = [];
  for (const r of evRows) {
    if (!r.icao) continue;
    const ladder = laddersByEvent.get(r.event_id); if (!ladder || ladder.length < 2) continue;
    events.push({
      eventId: r.event_id, icao: r.icao, targetDate: dISO(r.target_date), unit: r.unit, winnerIdx: r.winning_bucket_idx,
      bucketDefs: ladder.map((b) => ({ low: b.low, high: b.high, unit: r.unit })),
      bucketIdxs: ladder.map((b) => b.bucketIdx), lows: ladder.map((b) => b.low), highs: ladder.map((b) => b.high),
      asks: asksByEvent.get(r.event_id) ?? new Map(),
    });
  }
  const eventByKey = new Map<string, EventRow>();
  for (const e of events) eventByKey.set(`${e.icao}|${e.targetDate}`, e);

  // walk-forward EMOS, record per-(station,day) disagreement
  const stateByIcao = new Map(icaos.map((i) => [i, new EmosStation(cfg)]));
  const decisionLead = args.leads.includes(1) ? 1 : args.leads[0]!;
  const allTargets = new Set<string>();
  for (const byT of fc.values()) for (const t of byT.keys()) allTargets.add(t);
  const foldDay = (icao: string, t: string): void => {
    const o = obsC.get(icao)?.get(t); const byLeadMap = fc.get(icao)?.get(t);
    if (o === undefined || !byLeadMap) return;
    const sm = stateByIcao.get(icao)!;
    for (const [lead, byModel] of byLeadMap) { if (!args.leads.includes(lead)) continue; sm.fold([...byModel].map(([model, f]) => ({ model, f })), lead, o); }
  };
  for (const t of [...allTargets].sort()) if (t < args.from) for (const icao of icaos) foldDay(icao, t);

  const disByStationDay = new Map<string, number | null>();
  for (const d of listDatesISO(args.from, args.to)) {
    for (const icao of icaos) {
      const o = obsC.get(icao)?.get(d); const byLeadMap = fc.get(icao)?.get(d);
      if (o === undefined || !byLeadMap) { foldDay(icao, d); continue; }
      const sm = stateByIcao.get(icao)!;
      const points = [...(byLeadMap.get(decisionLead) ?? new Map())].map(([model, f]) => ({ model, f }));
      if (points.length > 0) { const mu = sm.blendedMu(points, decisionLead); if (mu != null && Number.isFinite(mu)) disByStationDay.set(`${icao}|${d}`, sm.disagreement(points, decisionLead)); }
      foldDay(icao, d);
    }
  }

  // TRAIN-fit per-station quartile cutpoints (backfill era), applied to TEST-era classification
  const splitDate = addDaysISO(args.switchDate, 1);
  const byStationTrain = new Map<string, number[]>();
  for (const [k, dis] of disByStationDay) { const [icao, d] = k.split('|'); if (d! < splitDate && dis != null && Number.isFinite(dis)) { const a = byStationTrain.get(icao!) ?? []; a.push(dis); byStationTrain.set(icao!, a); } }
  const cutByStation = new Map<string, QuartileCutpoints>();
  for (const [icao, vals] of byStationTrain) cutByStation.set(icao, fitQuartileCutpoints(vals));

  const viewsFor = (ev: EventRow, sm: EmosStation): BucketView[] | null => {
    const byLeadMap = fc.get(ev.icao)?.get(ev.targetDate);
    const points = [...(byLeadMap?.get(decisionLead) ?? new Map())].map(([model, f]) => ({ model, f }));
    if (points.length === 0) return null;
    const mu = sm.blendedMu(points, decisionLead); const sigmaC = sm.sigma(decisionLead);
    if (mu == null || sigmaC == null || !Number.isFinite(mu) || !Number.isFinite(sigmaC)) return null;
    const muNative = toNative(mu, ev.unit); const sigmaNative = ev.unit === 'F' ? sigmaC * (9 / 5) : sigmaC;
    if (sigmaNative <= 0.2) return null;
    let probs: number[];
    try { probs = gaussianBucketProbs(muNative, sigmaNative, ev.bucketDefs); } catch { return null; }
    return ev.bucketIdxs.map((bucketIdx, i) => ({ bucketIdx, calibratedP: probs[i]!, ask: ev.asks.get(bucketIdx) ?? null, isWinner: bucketIdx === ev.winnerIdx }));
  };

  // build one MonitorEvent per TEST-window resolved market
  const out: MonitorEvent[] = [];
  for (const [key, ev] of eventByKey) {
    if (ev.targetDate < splitDate) continue; // TEST window only (live-slot era)
    const sm = stateByIcao.get(ev.icao); if (!sm) continue;
    const dis = disByStationDay.get(`${ev.icao}|${ev.targetDate}`);
    const cut = cutByStation.get(ev.icao);
    const quartile = cut && dis != null ? classifyQuartile(dis, cut) : null;
    const views = viewsFor(ev, sm);
    const cheapBets: GradedBet[] = [];
    if (views) for (const e of selectCheapEntries(views).filter((x) => x.inCheapSubset)) cheapBets.push({ won: e.isWinner, ask: e.ask });
    const ladder: LadderLeg[] = ev.bucketIdxs.map((bucketIdx, i) => {
      const ask = ev.asks.get(bucketIdx);
      return ask == null ? null : { tempKey: tempKey(ev.lows[i]!, ev.highs[i]!), ask, won: bucketIdx === ev.winnerIdx };
    }).filter((l): l is LadderLeg => l != null);
    out.push({ city: ev.icao, targetDate: ev.targetDate, quartile, cheapBets, ladder });
  }
  log(`${SCRIPT}: built ${out.length} MonitorEvents in the TEST window ${splitDate} → ${args.to}`);
  return out;
}

const pp = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' : 'n/a');
const pctv = (v: { label: string; nMarkets: number; nCities: number; nDistinctDays: number; winFrac: number; meanNetReturn: number; ciLow: number; ciHigh: number; zeroSkillPassRate: number }): string =>
  `${v.label} · n=${v.nMarkets}/${v.nCities}c/${v.nDistinctDays}d · winFrac ${(v.winFrac * 100).toFixed(1)}% · net ${pp(v.meanNetReturn)} CI [${pp(v.ciLow)}, ${pp(v.ciHigh)}] · zsMC ${(v.zeroSkillPassRate * 100).toFixed(1)}%`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const minute = new Date().getUTCMinutes();
  if (minute >= 32 && minute <= 42) throw new Error(`${SCRIPT}: inside the reserved :32-:42 UTC window (now :${minute}); retry after :43`);
  const { values } = parseArgs({ options: { from: { type: 'string' }, switch: { type: 'string' }, to: { type: 'string' }, 'live-slot': { type: 'string' }, leads: { type: 'string' }, json: { type: 'boolean' }, record: { type: 'boolean' } } });
  const args: WalkArgs = {
    from: values.from ?? '2026-04-21', switchDate: values.switch ?? '2026-06-15', to: values.to ?? '2026-07-08',
    liveSlot: values['live-slot'] ?? '10Z', leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
  };
  const db = makeScriptDb();
  try {
    const events = await walkMonitorEvents(args, { db, log: console.log });
    const r = scoreEfficiencyMonitor(events, MONITOR_DEFAULTS);
    console.log(`\n=== EFFICIENCY MONITOR (paper, forward-confirmation) — TEST window on live '${args.liveSlot}' ===`);
    console.log(`  events ${r.nEvents}`);
    console.log('\n  S1 · REGIME + FORECAST CHEAP-SUBSET (forward-confirms KILL-GATE 2 + C24):');
    console.log(`    ${pctv(r.s1Regime.verdict)}`);
    console.log(`    per-bet edge ${pp(r.s1Regime.edge.edge)} [${pp(r.s1Regime.edge.edgeCiLo)}, ${pp(r.s1Regime.edge.edgeCiHi)}] · n=${r.s1Regime.edge.nGraded}`);
    for (const q of [1, 2, 3, 4] as const) { const s = r.s1Regime.byQuartile[q]; console.log(`      Q${q} n=${s.nGraded} edge ${pp(s.edge)} [${pp(s.edgeCiLo)}, ${pp(s.edgeCiHi)}]`); }
    console.log(`    Q4 distinct weather-days ${r.s1Regime.q4DistinctWeatherDays} · day-clustered ${pp(r.s1Regime.q4DayClustered.mean)} CI [${pp(r.s1Regime.q4DayClustered.lo)}, ${pp(r.s1Regime.q4DayClustered.hi)}]`);
    console.log('\n  S2 · LADDER-GEOMETRY TROUGHS (forward-confirms C23-T2/T3):');
    console.log(`    ${pctv(r.s2Geometry.verdict)}`);
    console.log(`    troughs ${r.s2Geometry.nTroughs} · per-bet edge ${pp(r.s2Geometry.edge.edge)} [${pp(r.s2Geometry.edge.edgeCiLo)}, ${pp(r.s2Geometry.edge.edgeCiHi)}] · hit ${(r.s2Geometry.edge.hitRate * 100).toFixed(1)}% @ ${r.s2Geometry.edge.avgAsk.toFixed(3)}`);
    if (values.json) console.log('\nJSON ' + JSON.stringify(r));

    if (values.record) {
      // the persisted snapshot view (shape read by dash_efficiency_monitor / migration 0091)
      const asOf = events.reduce((m, e) => (e.targetDate > m ? e.targetDate : m), args.from);
      const view = {
        window: { from: args.from, switchDate: args.switchDate, to: args.to, liveSlot: args.liveSlot, leads: args.leads },
        nEvents: r.nEvents,
        s1: {
          verdict: r.s1Regime.verdict, edge: r.s1Regime.edge, byQuartile: r.s1Regime.byQuartile,
          q4DayClustered: r.s1Regime.q4DayClustered, q4DistinctWeatherDays: r.s1Regime.q4DistinctWeatherDays,
          nPurchases: r.s1Regime.nPurchases,
        },
        s2: { verdict: r.s2Geometry.verdict, edge: r.s2Geometry.edge, nTroughs: r.s2Geometry.nTroughs, nPurchases: r.s2Geometry.nPurchases },
      };
      const recRows = await db.query<{ record_efficiency_monitor: number }>(
        `select public.record_efficiency_monitor($1::date, $2::jsonb)`, [asOf, JSON.stringify(view)],
      );
      const id = recRows[0]?.record_efficiency_monitor;
      console.log(`\n${SCRIPT}: recorded snapshot id=${id} (as_of ${asOf}) — needs migration 0091 applied to prod`);
    }
  } finally { await db.end(); }
}
