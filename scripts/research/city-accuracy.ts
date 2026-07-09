/**
 * scripts/research/city-accuracy — per-city forecast bucket-accuracy backtrack ("won/lost by prediction").
 *
 * THE QUESTION (operator): per city, over as much history as we have forecasts, on how many days would
 * our PREDICTION have won vs lost — i.e. did the house blend μ land in the correct native-degree bucket
 * (the one the market resolves on)?
 *
 * Reuses the MODEL-TRIM walk-forward verbatim: the live model (all 8 core deterministic models, EMA-
 * bias-corrected, inverse-MSE-weighted — the MODEL-TRIM.md-confirmed blend) reconstructed CAUSALLY (each
 * day scored on prior data only) over the FULL stitched panel (backfill 2026-04-09→06-12 + live slot after).
 * WON = round(μ) native == observed native integer high (tmax_wu_native). LOST = miss. NEAR = within ±1°.
 * This is the market-decision accuracy (does μ pick the winning °-bucket), the 1° proxy the /data page uses.
 *
 * Caveats printed with the result: (a) forecast history starts 2026-04-09 (truth goes back to 2024, but a
 * prediction needs a forecast); (b) at the 22Z slot, lead 0 is an *evening-of* near-nowcast (the high is
 * mostly in) — lead 1 is the honest DAY-AHEAD prediction; (c) 1°-bucket proxy — °F markets can use wider
 * buckets, so their true market win-rate is ≥ this.
 *
 * Read-only. Writes only scripts/research/out/city-accuracy-<slot>.csv.
 * Run: pnpm tsx scripts/research/city-accuracy.ts [--leads 0,1,2] [--slot 22Z] [--seam 2026-06-12]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseConfigRows } from '../../packages/core/src/index.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import { splitList, type Db } from '../lib/backfill.ts';
import {
  buildPanels,
  loadRows,
  scoreSubset,
  blendPoint,
  toNativeInt,
  CORE8,
  type TrimArgs,
  type ScoreDay,
} from './model-trim.ts';

export const SCRIPT = 'city-accuracy';

interface CityRow {
  city: string;
  lead: number;
  n: number;
  won: number;
  lost: number;
  near: number; // within ±1°
  winPct: number;
  nearPct: number;
  maeC: number;
  first: string;
  last: string;
}

/** Per-city won/lost, one lead, over the full merged (train+test) causal panel. */
export function cityAccuracy(days: ScoreDay[], lead: number): CityRow[] {
  const byCity = new Map<string, ScoreDay[]>();
  for (const d of days) (byCity.get(d.city) ?? byCity.set(d.city, []).get(d.city)!).push(d);
  const rows: CityRow[] = [];
  for (const [city, cd] of byCity) {
    const s = scoreSubset(cd, new Set(CORE8), 'invmse');
    if (s.n === 0) continue;
    const dates = cd.map((d) => d.date).sort();
    rows.push({
      city,
      lead,
      n: s.n,
      won: s.exact,
      lost: s.n - s.exact,
      near: s.within1,
      winPct: 100 * s.exactRate,
      nearPct: 100 * s.within1Rate,
      maeC: s.maeC,
      first: dates[0]!,
      last: dates[dates.length - 1]!,
    });
  }
  return rows.sort((a, b) => b.winPct - a.winPct || a.city.localeCompare(b.city));
}

/** The CAUSAL house blend μ per (icao, target_date, lead) — the source-of-truth forecast for a downstream
 * P&L join (the archive's baked-in pred is hindsight-calibrated; this one is walk-forward causal). */
export interface ForecastRow {
  icao: string;
  date: string;
  lead: number;
  muC: number;
  unit: string;
  muNative: number;
}
export function forecastRows(panels: Map<number, { train: ScoreDay[]; test: ScoreDay[] }>): ForecastRow[] {
  const out: ForecastRow[] = [];
  for (const [lead, panel] of panels) {
    for (const d of [...panel.train, ...panel.test]) {
      const members = CORE8.map((m) => d.members.get(m)).filter((x): x is NonNullable<typeof x> => x !== undefined);
      const mu = blendPoint(members, 'invmse');
      if (mu === null || !Number.isFinite(mu)) continue;
      out.push({ icao: d.city, date: d.date, lead, muC: mu, unit: d.unit, muNative: toNativeInt(mu, d.unit) });
    }
  }
  return out;
}

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');

export async function run(args: TrimArgs, deps: { db: Db; log: (m: string) => void }, emitPath?: string): Promise<CityRow[]> {
  const { db, log } = deps;
  const cfg = parseConfigRows(await db.query<{ key: string; value: string }>(`select key, value from config`));
  const { fc, obs } = await loadRows(db, args);
  const panels = buildPanels(fc, obs, cfg, args);

  if (emitPath) {
    const rows = forecastRows(panels);
    const csv = ['icao,target_date,lead,mu_c,unit,mu_native']
      .concat(rows.map((r) => `${r.icao},${r.date},${r.lead},${r.muC.toFixed(4)},${r.unit},${r.muNative}`))
      .join('\n');
    mkdirSync(dirname(emitPath), { recursive: true });
    writeFileSync(emitPath, csv + '\n');
    log(`emitted ${rows.length} causal-forecast rows -> ${emitPath}`);
  }

  log(`\n═══════════ CITY PREDICTION ACCURACY — won/lost by forecast bucket ═══════════`);
  log(`model: all-8 inv-MSE bias-corrected blend (MODEL-TRIM-confirmed) · stitched backfill+${args.slot} · full history`);
  log(`WON = round(μ) native == observed native high · NEAR = within ±1° · caveat: 22Z lead 0 is an evening near-nowcast`);

  const all: CityRow[] = [];
  for (const lead of args.leads) {
    const panel = panels.get(lead);
    if (!panel) continue;
    const days = [...panel.train, ...panel.test];
    const rows = cityAccuracy(days, lead);
    all.push(...rows);

    const totN = rows.reduce((a, r) => a + r.n, 0);
    const totW = rows.reduce((a, r) => a + r.won, 0);
    const totNear = rows.reduce((a, r) => a + r.near, 0);
    const spanFirst = rows.map((r) => r.first).sort()[0] ?? '—';
    const spanLast = rows.map((r) => r.last).sort().reverse()[0] ?? '—';
    const label = lead === 1 ? ' (DAY-AHEAD — the headline prediction)' : lead === 0 ? ' (same-day)' : '';

    log(`\n──────── LEAD ${lead}${label} · ${rows.length} cities · ${spanFirst}→${spanLast} ────────`);
    log(`  POOLED: ${totW}/${totN} won = ${f1((100 * totW) / totN)}% exact · ${f1((100 * totNear) / totN)}% within ±1°`);
    log(`  ${'city'.padEnd(6)} ${'days'.padStart(4)} ${'won'.padStart(4)} ${'lost'.padStart(4)} ${'win%'.padStart(6)} ${'±1%'.padStart(6)} ${'MAE°C'.padStart(6)}  span`);
    for (const r of rows) {
      log(`  ${r.city.padEnd(6)} ${String(r.n).padStart(4)} ${String(r.won).padStart(4)} ${String(r.lost).padStart(4)} ${f1(r.winPct).padStart(6)} ${f1(r.nearPct).padStart(6)} ${f2(r.maeC).padStart(6)}  ${r.first}→${r.last}`);
    }
  }

  // artifact
  const dir = 'scripts/research/out';
  mkdirSync(dir, { recursive: true });
  const header = 'lead,city,days,won,lost,near_within1,win_pct,near_pct,mae_c,first_date,last_date';
  const lines = all.map((r) =>
    [r.lead, r.city, r.n, r.won, r.lost, r.near, r.winPct.toFixed(2), r.nearPct.toFixed(2), r.maeC.toFixed(4), r.first, r.last].join(','),
  );
  writeFileSync(`${dir}/city-accuracy-${args.slot}.csv`, [header, ...lines].join('\n') + '\n');
  log(`\nwrote ${dir}/city-accuracy-${args.slot}.csv (${all.length} city×lead rows)`);
  return all;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      leads: { type: 'string' }, slot: { type: 'string' }, seam: { type: 'string' }, stations: { type: 'string' },
      'emit-forecast': { type: 'string' },
    },
  });
  const args: TrimArgs = {
    leads: (splitList(values.leads) ?? ['0', '1', '2']).map(Number),
    slot: values.slot ?? '22Z',
    seam: values.seam ?? '2026-06-12',
    stations: splitList(values.stations),
    marginC: 0.05, minTrain: 25, minTest: 8, warmup: 0, iters: 1, seed: 42, scheme: 'invmse',
  };
  const db = makeScriptDb();
  try {
    await run(args, { db, log: console.log }, values['emit-forecast']);
  } finally {
    await db.end();
  }
}
