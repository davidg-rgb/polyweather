/**
 * scripts/research/wo4-nowcast-value — WO-4 (FORECASTING-RD-HANDOFF), DF5 lever 2 / ADR-15.
 *
 * THE QUESTION: the intraday running max + climatological lift is the ONE non-NWP signal the system
 * has (used at lead 0 via applyRunningMaxConstraint). Does it actually beat the NWP house μ, and at
 * which local hours? If it strongly beats NWP late in the day, the lead-0 nowcast is earning its keep
 * and EXTENDING it (e.g., a partial-day constraint on late lead-1 builds) has headroom. If it never
 * beats NWP, there's no extension lever.
 *
 * METHOD (read-only, walk-forward): for each (station, target day) compute the NWP lead-0 build μ
 * (baseline blend of lead-1 forecasts — imported StationModel). For each local hour h with a recorded
 * running max M_h (intraday_advances.max_tenths_c/10 °C), the nowcast point estimate is
 *   M_h + liftP50[station, h]   where liftP50 is the median (obs − M_h) over PRIOR days only (no
 * lookahead; nowcast_lift in the DB is recomputed globally so we refit it walk-forward here). Compare
 * |nowcast − obs| vs |μ_NWP − obs| by hour, and a min-combine (does using the nowcast when it's past
 * the NWP help?). Data: intraday_advances spans ~182 days × 45 stations.
 *
 * Run: pnpm tsx scripts/research/wo4-nowcast-value.ts [--from] [--to] [--min-lift-n 20]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fToC, parseConfigRows } from '../../packages/core/src/index.ts';
import { StationModel } from './mos-pointskill.ts';
import { listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'wo4-nowcast-value';

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface HourAcc {
  n: number;
  seNwp: number; // NWP μ squared error on the SAME matched samples
  seNow: number; // nowcast squared error
  seMin: number; // min-combine (pick whichever of NWP/nowcast is closer is NOT walk-forward; see seGate)
  seGate: number; // walk-forward gate: use nowcast only when M_h already exceeds μ_NWP (a hard signal)
}
const emptyHour = (): HourAcc => ({ n: 0, seNwp: 0, seNow: 0, seMin: 0, seGate: 0 });

export interface Wo4Args {
  from: string;
  to: string;
  minLiftN: number;
  stations?: string[];
}
export interface Wo4Deps {
  db: Db;
  log: (msg: string) => void;
}

export async function runWo4(args: Wo4Args, deps: Wo4Deps): Promise<Map<number, HourAcc>> {
  const { db, log } = deps;
  const cfg = parseConfigRows(await db.query<{ key: string; value: string }>(`select key, value from config`));

  let stationRows = await db.query<{ icao: string; unit: 'C' | 'F' }>(
    `select distinct s.icao, c.unit from stations s
     join city_stations cs on cs.icao = s.icao and cs.valid_to is null join cities c on c.id = cs.city_id`,
  );
  if (args.stations) {
    const want = new Set(args.stations.map((s) => s.toUpperCase()));
    stationRows = stationRows.filter((s) => want.has(s.icao.toUpperCase()));
  }
  const unitByIcao = new Map(stationRows.map((s) => [s.icao, s.unit]));
  const icaos = stationRows.map((s) => s.icao);
  const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

  // NWP inputs: lead-1 backfill forecasts (the lead-0 build column) → icao → target → model → tmaxC
  const fRows = await db.query<{ icao: string; model: string; target_date: string | Date; tmax_c: string }>(
    `select icao, model, target_date, tmax_c from forecast_snapshots
     where snapshot_slot='backfill' and lead_days = 1 and icao = any($1) and target_date between $2 and $3`,
    [icaos, '2024-01-01', args.to],
  );
  const fc = new Map<string, Map<string, Map<string, number>>>();
  for (const r of fRows) {
    const t = dISO(r.target_date);
    const byT = fc.get(r.icao) ?? new Map();
    const byModel = byT.get(t) ?? new Map();
    byModel.set(r.model, Number(r.tmax_c));
    byT.set(t, byModel);
    fc.set(r.icao, byT);
  }

  const oRows = await db.query<{ icao: string; date_local: string | Date; tmax_wu_native: number; unit: 'C' | 'F' }>(
    `select icao, date_local, tmax_wu_native, unit from observations
     where finalized_at is not null and icao = any($1) and date_local <= $2`,
    [icaos, args.to],
  );
  const obs = new Map<string, Map<string, number>>();
  for (const r of oRows) {
    const m = obs.get(r.icao) ?? new Map<string, number>();
    m.set(dISO(r.date_local), (r.unit ?? unitByIcao.get(r.icao)) === 'F' ? fToC(Number(r.tmax_wu_native)) : Number(r.tmax_wu_native));
    obs.set(r.icao, m);
  }

  // Intraday running max by (icao, day, hour), in °C.
  const iRows = await db.query<{ icao: string; date_local: string | Date; local_hour: number; max_tenths_c: string }>(
    `select icao, date_local, local_hour, max_tenths_c from intraday_advances
     where icao = any($1) and date_local <= $2`,
    [icaos, args.to],
  );
  const intra = new Map<string, Map<string, Map<number, number>>>(); // icao → day → hour → maxC
  for (const r of iRows) {
    const t = dISO(r.date_local);
    const byT = intra.get(r.icao) ?? new Map();
    const byH = byT.get(t) ?? new Map();
    // NB: `max_tenths_c` is a MISNOMER — it stores the running max already in °C (verified: KORD
    // 2026-06-01 hour-14 = 22.2 == obs 72°F == 22.2°C). Do NOT divide by 10.
    byH.set(Number(r.local_hour), Number(r.max_tenths_c));
    byT.set(t, byH);
    intra.set(r.icao, byT);
  }

  const days = [...new Set([...intra.values()].flatMap((m) => [...m.keys()]))].sort();
  const firstIntra = days[0] ?? args.from;
  const from = args.from > firstIntra ? args.from : firstIntra;

  // walk-forward state: NWP blend per station (lead 1) + per-(icao,hour) lift windows (obs − M_h, prior days).
  const nwp = new Map(icaos.map((i) => [i, new StationModel(cfg, 10)]));
  const liftWin = new Map<string, number[]>(); // `${icao}|${hour}` → (obs − M_h) over prior days
  const byHour = new Map<number, HourAcc>();
  const getH = (h: number): HourAcc => {
    let a = byHour.get(h);
    if (!a) {
      a = emptyHour();
      byHour.set(h, a);
    }
    return a;
  };

  // warm-up NWP folds (fold every target before `from`)
  const allTargets = new Set<string>();
  for (const byT of fc.values()) for (const t of byT.keys()) allTargets.add(t);
  const foldNwp = (icao: string, t: string) => {
    const o = obs.get(icao)?.get(t);
    const fm = fc.get(icao)?.get(t);
    if (o === undefined || !fm) return;
    nwp.get(icao)!.fold([...fm].map(([model, f]) => ({ model, f })), 1, o);
  };
  for (const t of [...allTargets].sort()) if (t < from) for (const icao of icaos) foldNwp(icao, t);

  let scored = 0;
  for (const d of listDatesISO(from, args.to)) {
    for (const icao of icaos) {
      const o = obs.get(icao)?.get(d);
      const fm = fc.get(icao)?.get(d);
      const hours = intra.get(icao)?.get(d);
      if (o === undefined || !fm || !hours) continue;

      // NWP lead-0 build μ (baseline blend of lead-1 corrected points)
      const sm = nwp.get(icao)!;
      const entries = [...fm].map(([model, f]) => ({ model, f }));
      let muNwp = NaN;
      if (entries.length > 0) {
        const corrected = entries.map((e) => sm.correctedPoint('baseline', e.model, 1, e.f));
        const w = sm.baselineWeights(entries.map((e) => e.model), 1);
        const haveW = [...w.values()].some((v) => v > 0);
        let num = 0;
        let den = 0;
        entries.forEach((e, i) => {
          const weight = haveW ? (w.get(e.model) ?? 0) : 1 / entries.length;
          if (weight <= 0) return;
          num += weight * corrected[i]!;
          den += weight;
        });
        if (den > 0) muNwp = num / den;
      }

      if (!Number.isNaN(muNwp)) {
        for (const [h, mH] of hours) {
          const win = liftWin.get(`${icao}|${h}`);
          if (!win || win.length < args.minLiftN) continue; // not enough prior lift history at this hour
          const lift = median(win);
          const nowcast = mH + lift;
          const errNwp = muNwp - o;
          const errNow = nowcast - o;
          // walk-forward gate: trust the nowcast only when the running max already EXCEEDS the NWP μ
          // (a hard lower-bound violation → NWP is provably too low). Otherwise keep NWP.
          const errGate = mH > muNwp ? errNow : errNwp;
          const a = getH(h);
          a.n++;
          a.seNwp += errNwp * errNwp;
          a.seNow += errNow * errNow;
          a.seMin += Math.min(Math.abs(errNwp), Math.abs(errNow)) ** 2; // oracle (NOT walk-forward) upper bound
          a.seGate += errGate * errGate;
          scored++;
        }
      }
    }
    // fold the day: NWP truth + each hour's lift residual (obs − M_h)
    for (const icao of icaos) {
      foldNwp(icao, d);
      const o = obs.get(icao)?.get(d);
      const hours = intra.get(icao)?.get(d);
      if (o === undefined || !hours) continue;
      for (const [h, mH] of hours) {
        const k = `${icao}|${h}`;
        const win = liftWin.get(k) ?? [];
        win.push(o - mH);
        if (win.length > 400) win.shift();
        liftWin.set(k, win);
      }
    }
  }

  // --- report ----------------------------------------------------------------------
  const rmse = (se: number, n: number) => Math.sqrt(se / Math.max(1, n));
  const pct = (base: number, x: number) => ((base - x) / base) * 100;
  log(`=== wo4-nowcast-value ${from} → ${args.to} · minLiftN ${args.minLiftN} ===`);
  log(`scope: ${icaos.length} stations · ${scored} (station,day,hour) nowcast samples · intraday from ${firstIntra}`);
  log('');
  log('by LOCAL HOUR — does running-max + walk-forward lift beat the NWP lead-0 μ? (RMSE °C, matched samples)');
  log('hour     n   RMSE(nwp)  RMSE(nowcast)   Δ%    gate(nwp+max)  Δ%    oracle-min');
  let bestGate = -Infinity;
  for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
    const a = byHour.get(h)!;
    if (a.n < 100) continue;
    const rn = rmse(a.seNwp, a.n);
    const ro = rmse(a.seNow, a.n);
    const rg = rmse(a.seGate, a.n);
    const rm = rmse(a.seMin, a.n);
    bestGate = Math.max(bestGate, pct(rn, rg));
    log(
      `${String(h).padStart(3)} ${String(a.n).padStart(6)}   ${rn.toFixed(4)}     ${ro.toFixed(4)} ` +
        `(${pct(rn, ro) >= 0 ? '+' : ''}${pct(rn, ro).toFixed(1)}%)  ${rg.toFixed(4)} ` +
        `(${pct(rn, rg) >= 0 ? '+' : ''}${pct(rn, rg).toFixed(1)}%)  ${rm.toFixed(4)}`,
    );
  }
  log('');
  log('  Δ% = RMSE reduction vs NWP. nowcast = M_h + liftP50 (can be worse early when lift is uncertain).');
  log('  gate = use nowcast only when running-max M_h already EXCEEDS μ_NWP (a provable NWP-too-low signal) —');
  log('  this is the walk-forward, productionizable variant. oracle-min = unrealizable per-sample best (upper bound).');
  log('');
  log(
    bestGate >= 1.5
      ? `VERDICT: the gate variant clears +1.5% at some hour (best ${bestGate.toFixed(1)}%) — the intraday signal ` +
        `adds real lead-0 value; worth a productionization sketch (tighten/extend the running-max constraint).`
      : `VERDICT: gate best ${bestGate.toFixed(1)}% < +1.5% — the running-max hard signal rarely fires before close on ` +
        `this data; the lead-0 nowcast's point-RMSE lift is marginal. (See the oracle-min column for the ceiling.)`,
  );
  return byHour;
}

// --- CLI --------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      'min-lift-n': { type: 'string' },
      stations: { type: 'string' },
    },
  });
  const db = makeScriptDb();
  try {
    await runWo4(
      {
        from: values.from ?? '2025-12-16',
        to: values.to ?? '2026-06-12',
        minLiftN: values['min-lift-n'] ? Number(values['min-lift-n']) : 20,
        stations: splitList(values.stations),
      },
      { db, log: console.log },
    );
  } finally {
    await db.end();
  }
}
