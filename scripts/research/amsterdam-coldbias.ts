/**
 * scripts/research/amsterdam-coldbias — does a climatology-upside lift remove the late-arm COLD bias
 * without hurting the (already strong) normal days?
 *
 * VERDICT (2026-06-21): NO — the lift was REJECTED, the engine predictor was left unchanged. On the 69 live
 * walk-forward days the best variant (C7 = all-day upside at 15/16) showed ZERO integer-bucket flips and a big
 * decimal-MAE / signed-bias improvement, which looked like a free calibration win. But that "0 flips" was a
 * SMALL-SAMPLE ACCIDENT: the 20-year validation (scripts/research/amsterdam-peak-hour.ts --validate-lift)
 * proves the same lift DEGRADES integer exact-hit in EVERY month (Δexact −3 to −16pp; flips overwhelmingly
 * losses). The running-max floor is a biased-LOW *continuous* estimator but the BETTER *integer* estimator —
 * remaining warming is right-skewed near 0, so wuRound(floor) already lands on the high's integer and adding
 * the mean upside overshoots. The cold bias is thus an inherent right-skew artifact, NOT a fixable predictor
 * error; the late-arm/hot-day integer miss is irreducible (bet later — the best-time model already steers
 * hot days to 16:00+). This harness is kept as the reproducible evidence. See AMSTERDAM-SIM.md §"cold bias".
 *
 * Finding that motivated this (2026-06-21): over the full walk-forward backtest the forecast-aware nowcast
 * is healthy (15:00 82.6% exact, 16:00 92.8%), BUT through a June warm spell the recent paper bets ran
 * ~1.1–1.4°C COLD (the floor under-predicts a late-peaking hot day; the forecast lift is gated OFF at
 * 15/16). The 20-yr KNMI climatology says exactly why: on hot June days the mean remaining warming after
 * 15:00 is 0.63°C (vs 0.43 all-day) and after 16:00 0.29°C — so the pure floor is a biased-low estimate of
 * the peak. The principled fix: lift the floor by the climatological expected remaining upside,
 * hot-day-aware (the ≥25°C sub-climatology). This harness bakes off candidate basis functions WALK-FORWARD
 * on the same test days and reports, per arm and split by hot/normal: exact-hit, decimal MAE, SIGNED bias
 * (basis − real high), within-1, and a McNemar exact p vs the live baseline.
 *
 * Everything is walk-forward / no look-ahead: the trailing debias is prior-days-only (the production RPC
 * predicate), the climatology is a fixed 2006–2025 prior, and the hot flag uses the corrected forecast
 * known before the day starts. KNMI decimal truth is the scoring basis (run amsterdam-truth-backfill first).
 *
 * Run: pnpm tsx scripts/research/amsterdam-coldbias.ts [--icao EHAM] [--window 30]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  AMSTERDAM_CLIMATOLOGY,
  type AmsterdamClimatology,
  AMSTERDAM_SIM_DEBIAS_MIN_PAIRS,
  AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS,
  BESTTIME_HOT_FORECAST_C,
} from '../../packages/core/src/index.ts';
import { wuRound } from '../../packages/core/src/units.ts';
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from '../lib/script-db.ts';

const ARM_HOURS = [13, 14, 15, 16] as const;

interface DayRow {
  date: string;
  month: number;
  rm: Record<number, number | null>;
  fc1: number | null;
  actual: number; // WU integer high (°C) — market truth
  truth: number | null; // KNMI decimal high (°C)
}

async function fetchDays(db: ScriptDb, icao: string): Promise<DayRow[]> {
  const rows = await db.query<{
    date_local: string;
    rm13: string | null;
    rm14: string | null;
    rm15: string | null;
    rm16: string | null;
    fc1: string | null;
    actual: string;
    truth: string | null;
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
       (case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0 else o.tmax_wu_native end)::numeric as actual,
       t.tx_tenths_c::numeric as truth
     from observations o
     left join hrs on hrs.date_local = o.date_local
     left join fc on fc.target_date = o.date_local
     left join amsterdam_truth t on t.date_local = o.date_local
     where o.icao = $1 and o.finalized_at is not null and o.tmax_wu_native is not null
     order by o.date_local`,
    [icao],
  );
  const num = (v: string | null): number | null => (v == null ? null : Number(v));
  return rows.map((r) => ({
    date: r.date_local,
    month: Number(r.date_local.slice(5, 7)),
    rm: { 13: num(r.rm13), 14: num(r.rm14), 15: num(r.rm15), 16: num(r.rm16) },
    fc1: num(r.fc1),
    actual: Number(r.actual),
    truth: num(r.truth),
  }));
}

/** Expected remaining upside (°C) after local hour h for the month — hot-aware (≥25°C sub-climatology). */
function meanUpside(clim: AmsterdamClimatology, month: number, hour: number, hot: boolean): number {
  const m = clim.months.find((x) => x.month === month) ?? clim.months[clim.months.length - 1]!;
  const period = hot && m.hot ? m.hot : m;
  return period.decisionByHour.find((s) => s.hour === hour)?.meanUpsideC ?? 0;
}

/** Candidate basis functions. ctx carries everything known at decision time (walk-forward safe). */
interface BasisCtx {
  rm: number;
  hour: number;
  month: number;
  hot: boolean;
  fc: number | null; // bias-corrected lead-1 forecast, or null
  up: number; // hot-aware climatological expected remaining upside after `hour`
  upND: number; // all-day (non-hot) climatological expected remaining upside after `hour`
}
type Candidate = { key: string; label: string; basis: (c: BasisCtx) => number };
const early = (c: BasisCtx): boolean => c.fc != null && c.hour <= 14;

const CANDIDATES: Candidate[] = [
  { key: 'C0', label: 'baseline (fc≤14, pure floor 15/16)', basis: (c) => (early(c) ? Math.max(c.rm, c.fc!) : c.rm) },
  { key: 'C1', label: 'forecast lift at ALL arms', basis: (c) => (c.fc != null ? Math.max(c.rm, c.fc) : c.rm) },
  { key: 'C3', label: 'floor + clim upside (all arms, hot-aware)', basis: (c) => c.rm + c.up },
  { key: 'C5', label: 'max(forecast, floor+upside) all arms', basis: (c) => Math.max(c.fc ?? -Infinity, c.rm + c.up) },
  { key: 'C6', label: 'SURGICAL: fc≤14, floor+HOT-upside at 15/16', basis: (c) => (early(c) ? Math.max(c.rm, c.fc!) : c.rm + c.up) },
  { key: 'C7', label: 'SURGICAL: fc≤14, floor+ALLDAY-upside at 15/16', basis: (c) => (early(c) ? Math.max(c.rm, c.fc!) : c.rm + c.upND) },
  { key: 'C8', label: 'SURGICAL: fc≤14, floor+0.5×HOT-upside at 15/16', basis: (c) => (early(c) ? Math.max(c.rm, c.fc!) : c.rm + 0.5 * c.up) },
];

interface Acc {
  n: number;
  hit: number; // wuRound(basis) === wuRound(actual)  [market grain]
  truthN: number;
  truthHit: number; // wuRound(basis) === floor(truth) [floor-truth]
  absErr: number; // |basis − truth|  (decimal MAE)
  signed: number; // basis − truth     (signed bias; <0 = cold)
  within1: number; // |wuRound(basis) − actual| ≤ 1
}
const mkAcc = (): Acc => ({ n: 0, hit: 0, truthN: 0, truthHit: 0, absErr: 0, signed: 0, within1: 0 });

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
    options: { icao: { type: 'string', default: 'EHAM' }, window: { type: 'string', default: String(AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS) } },
  });
  const icao = values.icao ?? 'EHAM';
  const windowDays = Number(values.window);
  const minPairs = AMSTERDAM_SIM_DEBIAS_MIN_PAIRS;
  const clim = AMSTERDAM_CLIMATOLOGY;
  const db = makeScriptDb();
  return (async () => {
    try {
      const days = await fetchDays(db, icao);

      // accumulators[segment][candidate][hour]; segments: all / hot / normal (by corrected-forecast hotness)
      const segs = ['all', 'hot', 'normal'] as const;
      type Seg = (typeof segs)[number];
      const acc: Record<Seg, Record<string, Record<number, Acc>>> = { all: {}, hot: {}, normal: {} };
      // flips vs C0 (market exact-hit) per segment×candidate×hour
      const flips: Record<Seg, Record<string, Record<number, { gain: number; loss: number }>>> = { all: {}, hot: {}, normal: {} };
      for (const s of segs)
        for (const c of CANDIDATES) {
          acc[s][c.key] = {};
          flips[s][c.key] = {};
          for (const h of ARM_HOURS) {
            acc[s][c.key]![h] = mkAcc();
            flips[s][c.key]![h] = { gain: 0, loss: 0 };
          }
        }

      const priorPairs: { fc: number; actual: number }[] = [];
      let testDays = 0;
      let hotDays = 0;

      for (const d of days) {
        const windowed = windowDays > 0 ? priorPairs.slice(-windowDays) : priorPairs;
        const haveBias = windowed.length >= minPairs;
        const trailingBias = haveBias ? windowed.reduce((s, p) => s + (p.actual - p.fc), 0) / windowed.length : null;
        const corrected = d.fc1 != null && trailingBias != null ? d.fc1 + trailingBias : null;
        const hot = corrected != null && corrected >= BESTTIME_HOT_FORECAST_C;
        const scorable = d.rm[13] != null && d.rm[16] != null;

        if (haveBias && scorable) {
          testDays += 1;
          if (hot) hotDays += 1;
          const seg: Seg = hot ? 'hot' : 'normal';
          for (const h of ARM_HOURS) {
            const rm = d.rm[h];
            if (rm == null) continue;
            const up = meanUpside(clim, d.month, h, hot);
            const upND = meanUpside(clim, d.month, h, false);
            const ctx = { rm, hour: h, month: d.month, hot, fc: corrected, up, upND };
            const c0ok = wuRound(CANDIDATES[0]!.basis(ctx)) === wuRound(d.actual);
            for (const c of CANDIDATES) {
              const basis = c.basis(ctx);
              const pred = wuRound(basis);
              for (const target of ['all', seg] as Seg[]) {
                const a = acc[target][c.key]![h]!;
                a.n += 1;
                if (pred === wuRound(d.actual)) a.hit += 1;
                if (Math.abs(pred - d.actual) <= 1) a.within1 += 1;
                if (d.truth != null) {
                  a.truthN += 1;
                  if (pred === Math.floor(d.truth)) a.truthHit += 1;
                  a.absErr += Math.abs(basis - d.truth);
                  a.signed += basis - d.truth;
                }
                const ok = pred === wuRound(d.actual);
                if (!c0ok && ok) flips[target][c.key]![h]!.gain += 1;
                if (c0ok && !ok) flips[target][c.key]![h]!.loss += 1;
              }
            }
          }
        }
        if (d.fc1 != null) priorPairs.push({ fc: d.fc1, actual: d.actual });
      }

      const pct = (x: number, n: number) => (n ? `${((x / n) * 100).toFixed(0)}%` : '—');
      const f3 = (x: number, n: number) => (n ? (x / n).toFixed(3) : '—');
      const sgn = (x: number, n: number) => (n ? `${x / n >= 0 ? '+' : ''}${(x / n).toFixed(2)}` : '—');

      console.log(`\nAmsterdam COLD-BIAS bake-off — ${icao}`);
      console.log(`  ${days.length} finalized days; test days ${testDays} (hot=${hotDays} by corrected fc≥${BESTTIME_HOT_FORECAST_C}°C).`);
      console.log(`  Walk-forward: trailing ${windowDays}-day debias (min ${minPairs}); climatology 2006–2025 (hot-aware). Truth=KNMI 0.1°C.\n`);

      for (const s of segs) {
        const anyN = CANDIDATES.some((c) => ARM_HOURS.some((h) => acc[s][c.key]![h]!.n > 0));
        if (!anyN) continue;
        console.log(`══ segment: ${s.toUpperCase()} ${s === 'hot' ? '(corrected fc ≥ 25°C — where the cold bias lives)' : ''}`);
        console.log('  cand  arm │  n  truthN │ exact  flr-hit  decMAE  bias   w1 │ McNemar(+/-) p   def');
        console.log('  ──────────┼────────────┼──────────────────────────────────┼─────────────────────');
        for (const c of CANDIDATES) {
          for (const h of ARM_HOURS) {
            const a = acc[s][c.key]![h]!;
            const fl = flips[s][c.key]![h]!;
            const p = c.key === 'C0' ? null : mcnemarExactP(fl.gain, fl.loss);
            const sig = p != null && p < 0.05 ? '*' : ' ';
            console.log(
              `  ${c.key.padEnd(4)} ${String(h)}:00 │ ${String(a.n).padStart(3)} ${String(a.truthN).padStart(5)} │ ` +
                `${pct(a.hit, a.n).padStart(4)}  ${pct(a.truthHit, a.truthN).padStart(6)}  ${f3(a.absErr, a.truthN).padStart(6)}  ` +
                `${sgn(a.signed, a.truthN).padStart(5)}  ${pct(a.within1, a.n).padStart(4)} │ ` +
                (p == null ? '  (ref baseline)      ' : `${String(fl.gain)}/${String(fl.loss)}`.padStart(7) + `  ${p.toFixed(3)}${sig}`) +
                (h === 13 ? `  ${c.label}` : ''),
            );
          }
          console.log('  ──────────┼────────────┼──────────────────────────────────┼─────────────────────');
        }
        console.log('');
      }
      console.log('  exact = wuRound(basis)==wuRound(WU high) · flr-hit = wuRound(basis)==floor(KNMI high)');
      console.log('  decMAE = mean|basis−KNMI| · bias = mean(basis−KNMI) (negative = COLD) · w1 = within 1°C of WU high');
      console.log('  * McNemar exact p<0.05 vs C0 baseline (market exact-hit flips). All °C.\n');
    } finally {
      await db.end();
    }
  })();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('amsterdam-coldbias crashed:', err?.message ?? err);
    process.exit(1);
  });
}
