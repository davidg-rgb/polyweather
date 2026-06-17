/**
 * scripts/amsterdam-nowcast-backtest — does a forecast-aware nowcast beat the raw running-max floor?
 *
 * The live Amsterdam sim predicts the day's WU high as wuRound(runningMax) at each lock hour. The
 * running max is a FLOOR — early in the day it systematically under-predicts the peak (the day keeps
 * warming), so 13:00 is only ~53% exact. This backtest measures a forecast-aware nowcast:
 *
 *   basis(hour) = hour <= FORECAST_MAX_HOUR && forecast available
 *                   ? max(runningMax, deBiasedForecast)   -- lift the floor toward the expected peak
 *                   : runningMax                            -- late / no forecast: the floor IS the peak
 *   prediction  = wuRound(basis)
 *
 * deBiasedForecast = rawLead1Forecast + trailingBias, where trailingBias is the mean (actual − forecast)
 * over ONLY prior finalized days (walk-forward — never look-ahead; this is exactly the lead-1 bias the
 * system already measures in dash_station_predictions). The forecast is the cross-model mean of
 * forecast_snapshots.tmax_c at lead_days = 1 (the same blend the /city panel scores).
 *
 * It reports, on the SAME post-warmup test days for both predictors, the per-hour exact-bucket hit
 * rate, MAE, within-1°C, and the win/lose flip counts — an honest, reproducible verdict. The improved
 * predictor is the REAL engine seam (nowcastBasisC) so this scores exactly what production places.
 *
 * Run: pnpm tsx scripts/amsterdam-nowcast-backtest.ts [--icao EHAM] [--warmup 20]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AMSTERDAM_SIM_FORECAST_MAX_HOUR, nowcastBasisC } from '../packages/core/src/index.ts';
import { wuRound } from '../packages/core/src/units.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';

interface DayRow {
  date: string;
  rm: Record<number, number | null>; // running max by lock hour 13..16
  fc1: number | null; // raw cross-model lead-1 forecast (°C)
  actual: number; // finalized WU daily high (°C)
}

const ARM_HOURS = [13, 14, 15, 16] as const;

async function fetchDays(db: ScriptDb, icao: string): Promise<DayRow[]> {
  const rows = await db.query<{
    date_local: string;
    rm13: string | null;
    rm14: string | null;
    rm15: string | null;
    rm16: string | null;
    fc1: string | null;
    actual: string;
  }>(
    `with hrs as (
       select ia.date_local,
         max(ia.max_tenths_c) filter (where ia.local_hour <= 13) as rm13,
         max(ia.max_tenths_c) filter (where ia.local_hour <= 14) as rm14,
         max(ia.max_tenths_c) filter (where ia.local_hour <= 15) as rm15,
         max(ia.max_tenths_c) filter (where ia.local_hour <= 16) as rm16
       from intraday_advances ia where ia.icao = $1 group by ia.date_local
     ),
     fc as (
       select fs.target_date, avg(fs.tmax_c) filter (where fs.lead_days = 1) as fc1
       from forecast_snapshots fs where fs.icao = $1 and fs.lead_days = 1 group by fs.target_date
     )
     select h.date_local::text, h.rm13, h.rm14, h.rm15, h.rm16, fc.fc1,
       (case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0 else o.tmax_wu_native end)::numeric as actual
     from hrs h
     join observations o on o.icao = $1 and o.date_local = h.date_local
       and o.finalized_at is not null and o.tmax_wu_native is not null
     left join fc on fc.target_date = h.date_local
     where h.rm13 is not null and h.rm16 is not null
     order by h.date_local`,
    [icao],
  );
  const num = (v: string | null): number | null => (v == null ? null : Number(v));
  return rows.map((r) => ({
    date: r.date_local,
    rm: { 13: num(r.rm13), 14: num(r.rm14), 15: num(r.rm15), 16: num(r.rm16) },
    fc1: num(r.fc1),
    actual: Number(r.actual),
  }));
}

interface Acc {
  n: number;
  hit: number;
  absErr: number;
  within1: number;
}
const mkAcc = (): Acc => ({ n: 0, hit: 0, absErr: 0, within1: 0 });
function add(a: Acc, predNative: number, actual: number): void {
  a.n += 1;
  if (predNative === wuRound(actual)) a.hit += 1;
  a.absErr += Math.abs(predNative - actual);
  if (Math.abs(predNative - actual) <= 1) a.within1 += 1;
}

function main(): Promise<void> {
  loadEnv();
  const { values } = parseArgs({
    options: {
      icao: { type: 'string', default: 'EHAM' },
      warmup: { type: 'string', default: '20' },
    },
  });
  const icao = values.icao ?? 'EHAM';
  const warmup = Number(values.warmup);
  const db = makeScriptDb();
  return (async () => {
    try {
      const days = await fetchDays(db, icao);

      // Walk-forward: expanding trailing lead-1 bias from prior finalized days only.
      const priorPairs: { fc: number; actual: number }[] = [];
      const base: Record<number, Acc> = {};
      const impr: Record<number, Acc> = {};
      const flips: Record<number, { gain: number; loss: number }> = {};
      for (const h of ARM_HOURS) {
        base[h] = mkAcc();
        impr[h] = mkAcc();
        flips[h] = { gain: 0, loss: 0 };
      }
      let testDays = 0;

      for (const d of days) {
        const haveBias = priorPairs.length >= warmup;
        const trailingBias = haveBias
          ? priorPairs.reduce((s, p) => s + (p.actual - p.fc), 0) / priorPairs.length
          : null;
        const deBiased = d.fc1 != null && trailingBias != null ? d.fc1 + trailingBias : null;

        // Only score days where the de-bias is available, so base vs impr compare on identical days.
        if (haveBias) {
          testDays += 1;
          for (const h of ARM_HOURS) {
            const rm = d.rm[h];
            if (rm == null) continue;
            const basePred = wuRound(rm);
            const imprPred = wuRound(nowcastBasisC(rm, h, deBiased));
            add(base[h]!, basePred, d.actual);
            add(impr[h]!, imprPred, d.actual);
            const baseOk = basePred === wuRound(d.actual);
            const imprOk = imprPred === wuRound(d.actual);
            if (!baseOk && imprOk) flips[h]!.gain += 1;
            if (baseOk && !imprOk) flips[h]!.loss += 1;
          }
        }

        if (d.fc1 != null) priorPairs.push({ fc: d.fc1, actual: d.actual });
      }

      const pct = (x: number, n: number) => (n ? `${((x / n) * 100).toFixed(1)}%` : '—');
      const mae = (a: Acc) => (a.n ? (a.absErr / a.n).toFixed(3) : '—');

      console.log(`\nAmsterdam nowcast backtest — ${icao}`);
      console.log(
        `  ${days.length} finalized days; warmup ${warmup}; test days ${testDays}; ` +
          `forecast-floor applied at hours <= ${AMSTERDAM_SIM_FORECAST_MAX_HOUR} (engine constant).`,
      );
      console.log('  Walk-forward bias correction (trailing lead-1 bias, prior days only). All °C.\n');
      console.log('  hour │  n  │ baseline hit  MAE  w1 │ improved hit  MAE  w1 │  Δhit   flips(+/-)');
      console.log('  ─────┼─────┼───────────────────────┼───────────────────────┼──────────────────');
      for (const h of ARM_HOURS) {
        const b = base[h]!;
        const i = impr[h]!;
        const dHit = b.n ? ((i.hit - b.hit) / b.n) * 100 : 0;
        console.log(
          `  ${String(h).padStart(2)}:00 │ ${String(b.n).padStart(3)} │ ` +
            `${pct(b.hit, b.n).padStart(7)}  ${mae(b)}  ${pct(b.within1, b.n).padStart(5)} │ ` +
            `${pct(i.hit, i.n).padStart(7)}  ${mae(i)}  ${pct(i.within1, i.n).padStart(5)} │ ` +
            `${(dHit >= 0 ? '+' : '') + dHit.toFixed(1)}pp  ${flips[h]!.gain}/${flips[h]!.loss}`,
        );
      }
      console.log('');
    } finally {
      await db.end();
    }
  })();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('amsterdam-nowcast-backtest crashed:', err?.message ?? err);
    process.exit(1);
  });
}
