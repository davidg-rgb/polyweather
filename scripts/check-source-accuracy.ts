/**
 * scripts/check-source-accuracy — unified weather-source accuracy comparison.
 *
 * Ranks EVERY temperature source — the 8 Open-Meteo deterministic models
 * (forecast_snapshots) plus the external sources WeatherAPI / OpenWeatherMap
 * (source_forecasts) — against the same finalized WU/IEM truth, on RAW daily-max
 * error (no bias correction, so it's an honest out-of-the-box comparison).
 *
 * "Success rate" = % of daily-max forecasts within ±2 °C of observed. Also
 * reports MAE, signed bias, RMSE, and a by-lead breakdown so degradation
 * patterns are visible. Reads sufficient statistics from the source_accuracy
 * RPC and rolls them up here.
 *
 * Run: pnpm tsx scripts/check-source-accuracy.ts [--window 30] [--leads]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb } from './lib/script-db.ts';

interface Cell {
  source: string;
  icao: string;
  lead_days: number;
  n: number;
  sum_abs: number;
  sum_err: number;
  sum_sq: number;
  hits_1c: number;
  hits_2c: number;
}

interface Agg {
  n: number;
  sumAbs: number;
  sumErr: number;
  sumSq: number;
  h1: number;
  h2: number;
}

const empty = (): Agg => ({ n: 0, sumAbs: 0, sumErr: 0, sumSq: 0, h1: 0, h2: 0 });

function add(a: Agg, c: Cell): void {
  a.n += Number(c.n);
  a.sumAbs += Number(c.sum_abs);
  a.sumErr += Number(c.sum_err);
  a.sumSq += Number(c.sum_sq);
  a.h1 += Number(c.hits_1c);
  a.h2 += Number(c.hits_2c);
}

const mae = (a: Agg): number => (a.n ? a.sumAbs / a.n : NaN);
const bias = (a: Agg): number => (a.n ? a.sumErr / a.n : NaN);
const rmse = (a: Agg): number => (a.n ? Math.sqrt(a.sumSq / a.n) : NaN);
const hit2 = (a: Agg): number => (a.n ? (100 * a.h2) / a.n : NaN);
const hit1 = (a: Agg): number => (a.n ? (100 * a.h1) / a.n : NaN);

export async function reportSourceAccuracy(
  cells: Cell[],
  windowDays: number | null,
  showLeads: boolean,
): Promise<string[]> {
  const out: string[] = [];
  const win = windowDays ? `last ${windowDays} days` : 'all-time';
  out.push(`Source accuracy — every source vs WU/IEM truth (window: ${win})`);
  out.push('  success rate = % of daily-max forecasts within ±2 °C of observed; RAW (no bias correction)');
  out.push('');

  if (cells.length === 0) {
    out.push('  No scored forecast/observation pairs yet — let the backfill + actuals accumulate.');
    return out;
  }

  const bySource = new Map<string, Agg>();
  for (const c of cells) {
    const a = bySource.get(c.source) ?? empty();
    add(a, c);
    bySource.set(c.source, a);
  }

  const ranked = [...bySource.entries()].sort((x, y) => hit2(y[1]) - hit2(x[1]) || mae(x[1]) - mae(y[1]));
  out.push('  RANKING (by ±2 °C success rate):');
  out.push('  ' + 'rank  source                    n      MAE°C  bias°C  RMSE°C   ±1°C%  ±2°C%');
  ranked.forEach(([source, a], i) => {
    out.push(
      '  ' +
        `${String(i + 1).padStart(3)}   ${source.padEnd(22)} ${String(a.n).padStart(7)}  ` +
        `${mae(a).toFixed(2).padStart(5)}  ${bias(a) >= 0 ? '+' : ''}${bias(a).toFixed(2).padStart(5)}  ` +
        `${rmse(a).toFixed(2).padStart(5)}   ${hit1(a).toFixed(1).padStart(5)}  ${hit2(a).toFixed(1).padStart(5)}`,
    );
  });

  if (ranked.length >= 2) {
    out.push('');
    out.push(`  WINNER:  ${ranked[0]![0]} (${hit2(ranked[0]![1]).toFixed(1)}% within ±2 °C, MAE ${mae(ranked[0]![1]).toFixed(2)} °C)`);
    const last = ranked[ranked.length - 1]!;
    out.push(`  LAGGARD: ${last[0]} (${hit2(last[1]).toFixed(1)}% within ±2 °C, MAE ${mae(last[1]).toFixed(2)} °C)`);
  }

  if (showLeads) {
    out.push('');
    out.push('  ACCURACY BY LEAD (±2 °C success rate %, blank = no data):');
    const leads = [...new Set(cells.map((c) => c.lead_days))].sort((a, b) => a - b);
    out.push('  ' + 'source'.padEnd(24) + leads.map((l) => `L${l}`.padStart(6)).join(''));
    for (const [source] of ranked) {
      const byLead = new Map<number, Agg>();
      for (const c of cells.filter((c) => c.source === source)) {
        const a = byLead.get(c.lead_days) ?? empty();
        add(a, c);
        byLead.set(c.lead_days, a);
      }
      const row = leads
        .map((l) => {
          const a = byLead.get(l);
          return (a && a.n ? hit2(a).toFixed(0) : '—').padStart(6);
        })
        .join('');
      out.push('  ' + source.padEnd(24) + row);
    }
  }

  out.push('');
  out.push(`  ${bySource.size} sources, ${cells.reduce((s, c) => s + Number(c.n), 0)} scored forecast-days.`);
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { window: { type: 'string' }, leads: { type: 'boolean' } } });
  const windowDays = values.window ? Number(values.window) : null;
  loadEnv();
  const db = makeScriptDb();
  try {
    const cells = await db.query<Cell>('select * from source_accuracy($1)', [windowDays]);
    const lines = await reportSourceAccuracy(cells, windowDays, values.leads ?? false);
    for (const line of lines) console.log(line);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('check-source-accuracy crashed:', err?.message ?? err);
    process.exit(1);
  });
}
