/**
 * scripts/amsterdam-nowcast-backtest — does a forecast-aware nowcast beat the raw running-max floor?
 *
 * The live Amsterdam sim predicts the day's WU high as wuRound(runningMax) at each lock hour. The
 * running max is a FLOOR — early in the day it under-predicts the peak (the day keeps warming), so 13:00
 * is only ~42% exact on the test window. This backtest measures a forecast-aware nowcast:
 *
 *   basis(hour) = hour <= FORECAST_MAX_HOUR && forecast available
 *                   ? max(runningMax, biasCorrectedForecast)  -- lift the floor toward the expected peak
 *                   : runningMax                               -- late / no forecast: the floor IS the peak
 *   prediction  = wuRound(basis)
 *
 * biasCorrectedForecast = rawLead1Forecast + trailingBias, where trailingBias is the mean (actual −
 * forecast) over the most recent AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS finalized days STRICTLY BEFORE the
 * target (walk-forward — never look-ahead; the same lead-1 bias dash_station_predictions measures),
 * requiring >= AMSTERDAM_SIM_DEBIAS_MIN_PAIRS pairs. The forecast is the cross-model lead-1 mean of
 * forecast_snapshots.tmax_c. PRODUCTION-FAITHFUL: the bias population is every finalized day with a
 * lead-1 forecast (NOT gated on intraday coverage), exactly the amsterdam_sim_place_inputs RPC predicate
 * — and the lift itself is the real engine seam (nowcastBasisC). Scoring happens only on days that also
 * have intraday coverage (so a per-arm running max exists).
 *
 * Reports, on the SAME test days for both predictors, per-arm exact-bucket hit / MAE / within-1°C, the
 * win-gained/lost flip counts, and a McNemar exact (two-sided binomial) p-value on the discordant flips
 * with the test n — so the delta is reported WITH its significance, not as a bare proven win.
 *
 * Run: pnpm tsx scripts/amsterdam-nowcast-backtest.ts [--icao EHAM] [--window 45]  (--window 0 = all-history)
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  AMSTERDAM_SIM_DEBIAS_MIN_PAIRS,
  AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS,
  AMSTERDAM_SIM_FORECAST_MAX_HOUR,
  nowcastBasisC,
} from '../packages/core/src/index.ts';
import { wuRound } from '../packages/core/src/units.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';

interface DayRow {
  date: string;
  rm: Record<number, number | null>; // running max by lock hour 13..16 (null = no intraday that hour)
  fc1: number | null; // raw cross-model lead-1 forecast (°C), null if none captured
  actual: number; // finalized WU daily high (°C)
}

const ARM_HOURS = [13, 14, 15, 16] as const;

/** Every finalized day with its running max per arm, raw lead-1 forecast, and actual — ordered by date.
 *  Base = observations (so the bias population spans ALL finalized days with a forecast, matching the
 *  RPC); intraday is left-joined (rm may be null on days we can't score). */
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
     select o.date_local::text, hrs.rm13, hrs.rm14, hrs.rm15, hrs.rm16, fc.fc1,
       (case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0 else o.tmax_wu_native end)::numeric as actual
     from observations o
     left join hrs on hrs.date_local = o.date_local
     left join fc on fc.target_date = o.date_local
     where o.icao = $1 and o.finalized_at is not null and o.tmax_wu_native is not null
     order by o.date_local`,
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

/** McNemar exact test: two-sided binomial p on the discordant pairs (each 50/50 under H0). n small. */
function mcnemarExactP(gain: number, loss: number): number {
  const n = gain + loss;
  if (n === 0) return 1;
  const m = Math.min(gain, loss);
  let lower = 0;
  for (let k = 0; k <= m; k++) {
    let logC = 0;
    for (let i = 1; i <= k; i++) logC += Math.log(n - i + 1) - Math.log(i);
    lower += Math.exp(logC + n * Math.log(0.5));
  }
  return Math.min(1, 2 * lower);
}

function main(): Promise<void> {
  loadEnv();
  const { values } = parseArgs({
    options: {
      icao: { type: 'string', default: 'EHAM' },
      window: { type: 'string', default: String(AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS) },
    },
  });
  const icao = values.icao ?? 'EHAM';
  const windowDays = Number(values.window); // <= 0 → all-history (for comparison)
  const minPairs = AMSTERDAM_SIM_DEBIAS_MIN_PAIRS;
  const db = makeScriptDb();
  return (async () => {
    try {
      const days = await fetchDays(db, icao);

      // Walk-forward: the bias is the trailing window of (actual − forecast) over prior finalized days
      // that had a lead-1 forecast — independent of intraday coverage, matching the production RPC.
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
      let biasPop = 0;

      for (const d of days) {
        const windowed = windowDays > 0 ? priorPairs.slice(-windowDays) : priorPairs;
        const haveBias = windowed.length >= minPairs;
        const trailingBias = haveBias
          ? windowed.reduce((s, p) => s + (p.actual - p.fc), 0) / windowed.length
          : null;
        const corrected = d.fc1 != null && trailingBias != null ? d.fc1 + trailingBias : null;

        // Score only days where the bias is available AND the day is scorable, so base vs impr share days.
        const scorable = d.rm[13] != null && d.rm[16] != null;
        if (haveBias && scorable) {
          testDays += 1;
          for (const h of ARM_HOURS) {
            const rm = d.rm[h];
            if (rm == null) continue;
            const basePred = wuRound(rm);
            const imprPred = wuRound(nowcastBasisC(rm, h, corrected));
            add(base[h]!, basePred, d.actual);
            add(impr[h]!, imprPred, d.actual);
            const baseOk = basePred === wuRound(d.actual);
            const imprOk = imprPred === wuRound(d.actual);
            if (!baseOk && imprOk) flips[h]!.gain += 1;
            if (baseOk && !imprOk) flips[h]!.loss += 1;
          }
        }

        if (d.fc1 != null) {
          priorPairs.push({ fc: d.fc1, actual: d.actual });
          biasPop += 1;
        }
      }

      const pct = (x: number, n: number) => (n ? `${((x / n) * 100).toFixed(1)}%` : '—');
      const mae = (a: Acc) => (a.n ? (a.absErr / a.n).toFixed(3) : '—');

      console.log(`\nAmsterdam nowcast backtest — ${icao}`);
      console.log(
        `  ${days.length} finalized days; ${biasPop} with a lead-1 forecast (bias population); ` +
          `test days ${testDays}.`,
      );
      console.log(
        `  Bias = trailing ${windowDays > 0 ? `${windowDays}-day` : 'all-history'} mean(actual−forecast), ` +
          `min ${minPairs} pairs; forecast-floor applied at hours <= ${AMSTERDAM_SIM_FORECAST_MAX_HOUR}. ` +
          `Walk-forward, no look-ahead. All °C.\n`,
      );
      console.log('  hour │  n  │ baseline hit  MAE  w1 │ improved hit  MAE  w1 │  Δhit  flips(+/-)  McNemar p');
      console.log('  ─────┼─────┼───────────────────────┼───────────────────────┼───────────────────────────');
      for (const h of ARM_HOURS) {
        const b = base[h]!;
        const i = impr[h]!;
        const dHit = b.n ? ((i.hit - b.hit) / b.n) * 100 : 0;
        const p = mcnemarExactP(flips[h]!.gain, flips[h]!.loss);
        const sig = p < 0.05 ? ' *' : '';
        console.log(
          `  ${String(h).padStart(2)}:00 │ ${String(b.n).padStart(3)} │ ` +
            `${pct(b.hit, b.n).padStart(7)}  ${mae(b)}  ${pct(b.within1, b.n).padStart(5)} │ ` +
            `${pct(i.hit, i.n).padStart(7)}  ${mae(i)}  ${pct(i.within1, i.n).padStart(5)} │ ` +
            `${(dHit >= 0 ? '+' : '') + dHit.toFixed(1)}pp  ${flips[h]!.gain}/${flips[h]!.loss}` +
            `      ${p.toFixed(3)}${sig}`,
        );
      }
      console.log('\n  * p < 0.05 (McNemar exact, two-sided). Δhit without a star is directional, not significant.\n');
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
