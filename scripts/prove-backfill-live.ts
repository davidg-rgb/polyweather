/**
 * prove-backfill-live — the §14 P4 SAMPLE backfill evidence run, hosted-free:
 * boots an embedded Postgres (PGlite + full migration chain), seeds the three
 * research stations (RKSI, EGLL, KORD) with their cities, then runs the REAL
 * backfill CLIs against the LIVE APIs:
 *
 *   1. backfill-forecasts — 5 models × 12 months of Previous-Runs leads 1–7
 *      + day-0 pseudo-truth (--budget 2000)
 *   2. backfill-actuals  — 12 months of WU daily maxes with IEM fallback,
 *      advances log + nowcast_lift FINAL PASS
 *   3. run-calibration   — in-process, proving the W19 backfill→stats seeding
 *      path end-to-end on real data (both slots, blend rows, weights)
 *
 * The FULL-universe backfill (49 stations × 8 models from each archive start)
 * is a multi-day budgeted operator run — command in BUILD-STATE Operator TODO.
 *
 * Run: pnpm tsx scripts/prove-backfill-live.ts
 */
import { parseConfigRows } from '../packages/core/src/index.ts';
import { fetchJson } from '../packages/io/src/index.ts';
import { runCalibration } from '../supabase/functions/run-calibration/handler.ts';
import type { Alert } from '../supabase/functions/_shared/slack.ts';
import { freshDb, rows } from '../supabase/tests/harness.ts';
import { pglitePort } from '../supabase/tests/pglite-port.ts';
import { backfillActuals } from './backfill-actuals.ts';
import { backfillForecasts } from './backfill-forecasts.ts';
import { addDaysISO, todayUTC, type Db } from './lib/backfill.ts';

const SAMPLE_STATIONS = ['RKSI', 'EGLL', 'KORD'];
const SAMPLE_MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'jma_seamless', 'gem_seamless'];
const BUDGET = 2000;

const now = new Date();
const from = addDaysISO(todayUTC(now), -365);

const db = await freshDb();
const port = pglitePort(db);
const scriptDb: Db = {
  query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const pgParams = params.map((p) =>
      Array.isArray(p) ? `{${p.map((x) => `"${String(x)}"`).join(',')}}` : p,
    );
    return (await db.query<T>(sql, pgParams)).rows;
  },
};

// --- seed the sample universe (coordinates from research/OurAirports) ---------
await db.exec(`
  insert into stations (icao, name, country_code, tz, lat, lon, us_state, source) values
    ('RKSI', 'Incheon International Airport', 'KR', 'Asia/Seoul', 37.4691, 126.4510, null, 'ourairports'),
    ('EGLL', 'London Heathrow Airport', 'GB', 'Europe/London', 51.4706, -0.461941, null, 'ourairports'),
    ('KORD', 'Chicago O''Hare International Airport', 'US', 'America/Chicago', 41.9786, -87.9048, 'IL', 'ourairports');
  insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen) values
    ('seoul', 'Seoul', 'KR', 'C', 'Asia/Seoul', 'east-asia', now(), now()),
    ('london', 'London', 'GB', 'C', 'Europe/London', 'europe-west', now(), now()),
    ('chicago', 'Chicago', 'US', 'F', 'America/Chicago', 'na-central', now(), now());
  insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
    select id, 'RKSI', 'KR', now(), true from cities where slug = 'seoul';
  insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
    select id, 'EGLL', 'GB', now(), true from cities where slug = 'london';
  insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
    select id, 'KORD', 'US', now(), true from cities where slug = 'chicago';
`);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Gentle pacing on the unofficial WU endpoint; Open-Meteo is fine sequentially. */
const pacedFetchJson = async (url: string): Promise<unknown> => {
  if (url.includes('api.weather.com')) await sleep(150);
  return fetchJson(url);
};

console.log(`— SAMPLE backfill: ${SAMPLE_STATIONS.join(', ')} × ${SAMPLE_MODELS.length} models, ${from} → today, budget ${BUDGET}/day`);

console.log('\n[1/3] backfill-forecasts (live Previous-Runs + Historical Forecast)…');
const t0 = Date.now();
const fc = await backfillForecasts(
  { from, stations: SAMPLE_STATIONS, models: SAMPLE_MODELS, budget: BUDGET },
  {
    db: scriptDb,
    fetchJson: pacedFetchJson,
    log: (m) => console.log(`  ${m}`),
    now: () => new Date(),
    sleep,
    apiKey: process.env['OPENMETEO_API_KEY'] || undefined,
  },
);
console.log(`  forecasts done in ${((Date.now() - t0) / 60_000).toFixed(1)} min:`, JSON.stringify(fc));

console.log('\n[2/3] backfill-actuals (live WU + IEM)…');
const t1 = Date.now();
const ac = await backfillActuals(
  { from, stations: SAMPLE_STATIONS, budget: BUDGET },
  {
    db: scriptDb,
    fetchJson: pacedFetchJson,
    fetchText: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return res.text();
    },
    log: (m) => console.log(`  ${m}`),
    now: () => new Date(),
    sleep,
  },
);
console.log(`  actuals done in ${((Date.now() - t1) / 60_000).toFixed(1)} min:`, JSON.stringify(ac));

console.log('\n[3/3] run-calibration in-process (W19 seeding from backfill rows)…');
const alerts: Alert[] = [];
const config = parseConfigRows(
  (await port.getConfigRows()).filter((r) => !r.key.startsWith('halt:')),
);
const calib = await runCalibration(
  { db: port, config, log: (msg, extra) => console.log(`  [calib] ${msg}`, extra ? JSON.stringify(extra) : ''), startedAt: new Date() },
  { notify: async (a) => (alerts.push(a), true), now: new Date() },
);
console.log('  calibration stats:', JSON.stringify(calib));

// --- evidence ---------------------------------------------------------------
const fcByModel = await rows<{ model: string; leads: string; n: number; days: number }>(
  db,
  `select model, count(distinct lead_days)::text as leads, count(*)::int as n, count(distinct target_date)::int as days
   from forecast_snapshots where snapshot_slot = 'backfill' group by model order by model`,
);
const obsByProv = await rows<{ icao: string; provenance: string; n: number }>(
  db,
  `select icao, provenance, count(*)::int as n from observations group by icao, provenance order by icao, provenance`,
);
const statRows = await rows<{ icao: string; slots: number; models: number; n: number; with_sigma: number }>(
  db,
  `select icao, count(distinct snapshot_slot)::int as slots, count(distinct model)::int as models,
          count(*)::int as n, count(residual_sigma_c)::int as with_sigma
   from model_stats group by icao order by icao`,
);
const blend = (await rows<{ n: number }>(db, `select count(*)::int as n from model_stats where model = 'blend'`))[0]!.n;
const lift = (await rows<{ n: number }>(db, `select count(*)::int as n from nowcast_lift`))[0]!.n;
const advances = (await rows<{ n: number }>(db, `select count(*)::int as n from intraday_advances`))[0]!.n;
const totalFc = (await rows<{ n: number }>(db, `select count(*)::int as n from forecast_snapshots`))[0]!.n;
const totalObs = (await rows<{ n: number }>(db, `select count(*)::int as n from observations where finalized_at is not null`))[0]!.n;

console.log('\n=== P4 SAMPLE backfill evidence ===');
console.log('forecast rows by model (slot=backfill):');
for (const r of fcByModel) console.log(`  ${r.model.padEnd(22)} leads ${r.leads} · ${r.n} rows · ${r.days} target days`);
console.log(`total forecast_snapshots:      ${totalFc}`);
console.log('observations by provenance:');
for (const r of obsByProv) console.log(`  ${r.icao} ${r.provenance.padEnd(14)} ${r.n}`);
console.log(`total finalized observations:  ${totalObs}`);
console.log('model_stats by station:');
for (const r of statRows) console.log(`  ${r.icao}: ${r.n} rows · ${r.models} models · ${r.slots} slots · ${r.with_sigma} with σ`);
console.log(`blend rows:                    ${blend}`);
console.log(`intraday advances:             ${advances}`);
console.log(`nowcast_lift rows:             ${lift}`);
console.log(`calibration residualsAdded:    ${calib['residualsAdded']}`);
console.log(`calibration statsUpserted:     ${calib['statsUpserted']}`);

await db.close();

const bothSlots = statRows.every((r) => r.slots === 2);
const pass =
  totalFc >= 10_000 &&
  totalObs >= 300 &&
  statRows.length === 3 &&
  bothSlots &&
  blend > 0 &&
  lift >= 10 &&
  Number(calib['residualsAdded']) > 1_000;
console.log(pass ? '\nP4 SAMPLE backfill: PASS' : '\nP4 SAMPLE backfill: FAIL');
process.exit(pass ? 0 : 1);
