/**
 * scripts/backfill-forecasts — Previous Runs API lead-time backfill (§6.22).
 *
 * For each (station × model): previousRunsUrl over 14-day chunks from
 * max(model archive_start, --from, default 2024-01-21) → parsePreviousRunsHourly
 * → forecast_snapshots (source 'backfill_prev_runs', snapshot_slot 'backfill' —
 * W19 keeps these out of live builds; run-calibration seeds BOTH slots from
 * them). Plus a per-station day-0 pseudo-truth pass: historicalForecastUrl with
 * all models batched (scope '{icao}:_day0') → lead-0 rows.
 *
 * Resumable via backfill_progress (§7.20: cursor = last COMPLETED chunk end;
 * a killed run restarts at cursor+1). Budget-aware via requestWeight against
 * a persisted per-UTC-day counter (--budget, default 8000 weighted calls/day;
 * the budgeter sleeps to the next UTC midnight and resumes).
 *
 * Run: pnpm tsx scripts/backfill-forecasts.ts [--from 2024-01-21] [--to YYYY-MM-DD]
 *        [--stations RKSI,EGLL,KORD] [--models ecmwf_ifs025,...] [--budget 8000]
 */
import { parseArgs } from 'node:util';
import {
  parseMultiModelDaily,
  parsePreviousRunsHourly,
  previousRunsUrl,
  historicalForecastUrl,
  requestWeight,
} from '../packages/core/src/index.ts';
import { fetchJson as ioFetchJson } from '../packages/io/src/index.ts';
import {
  addDaysISO,
  chunkRanges,
  DayBudget,
  getProgress,
  setProgress,
  splitList,
  todayUTC,
  type Db,
} from './lib/backfill.ts';
import { makeScriptDb } from './lib/script-db.ts';

export const SCRIPT = 'backfill-forecasts';
export const PREVIOUS_RUNS_LEADS = [1, 2, 3, 4, 5, 6, 7];
const CHUNK_DAYS = 14;
const DEFAULT_FROM = '2024-01-21';

export interface BackfillForecastsArgs {
  from?: string;
  to?: string;
  stations?: string[];
  models?: string[];
  budget?: number;
}

export interface BackfillForecastsDeps {
  db: Db;
  fetchJson: (url: string) => Promise<unknown>;
  log: (msg: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  prevRunsBase?: string;
  histBase?: string;
  apiKey?: string;
}

interface StationRow {
  icao: string;
  lat: number;
  lon: number;
  tz: string;
}
interface ModelRow {
  slug: string;
  archive_start: string | Date;
}

export interface ForecastBackfillStats {
  scopes: number;
  scopesDone: number;
  scopesErrored: number;
  chunksFetched: number;
  rowsUpserted: number;
}

const isoDate = (v: string | Date): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

async function upsertRows(
  db: Db,
  rows: { icao: string; model: string; target_date: string; lead_days: number; tmax_c: number; captured_at: string }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({ ...r, snapshot_slot: 'backfill', source: 'backfill_prev_runs' }));
  const [res] = await db.query<{ n: number }>(`select upsert_forecast_rows($1::jsonb) as n`, [
    JSON.stringify(payload),
  ]);
  return Number(res?.n ?? 0);
}

export async function backfillForecasts(
  args: BackfillForecastsArgs,
  deps: BackfillForecastsDeps,
): Promise<ForecastBackfillStats> {
  const { db, log } = deps;
  const prevBase = deps.prevRunsBase ?? `https://${deps.apiKey ? 'customer-' : ''}previous-runs-api.open-meteo.com`;
  const histBase = deps.histBase ?? `https://${deps.apiKey ? 'customer-' : ''}historical-forecast-api.open-meteo.com`;
  const from = args.from ?? DEFAULT_FROM;
  // Historical Forecast data lags ~2 days (research-verified) — same cap for both passes.
  const to = args.to ?? addDaysISO(todayUTC(deps.now()), -2);
  const budget = new DayBudget(db, SCRIPT, args.budget ?? 8000, deps);

  let stations = await db.query<StationRow>(
    `select icao, lat, lon, tz from stations where lat is not null and lon is not null order by icao`,
  );
  if (args.stations) {
    const wanted = new Set(args.stations.map((s) => s.toUpperCase()));
    stations = stations.filter((s) => wanted.has(s.icao.toUpperCase()));
    const found = new Set(stations.map((s) => s.icao.toUpperCase()));
    for (const w of wanted) if (!found.has(w)) log(`WARNING: station ${w} not found (or missing coordinates) — skipped`);
  }

  let models = await db.query<ModelRow>(
    `select slug, archive_start from models
     where enabled and not is_ensemble and archive_start is not null order by slug`,
  );
  if (args.models) {
    const wanted = new Set(args.models);
    models = models.filter((m) => wanted.has(m.slug));
    const found = new Set(models.map((m) => m.slug));
    for (const w of wanted) if (!found.has(w)) log(`WARNING: model ${w} not enabled/backfillable — skipped`);
  }

  const stats: ForecastBackfillStats = { scopes: 0, scopesDone: 0, scopesErrored: 0, chunksFetched: 0, rowsUpserted: 0 };
  log(`${SCRIPT}: ${stations.length} station(s) × ${models.length} model(s), ${from} → ${to}`);

  // --- lead 1–7 via Previous Runs, one (station × model) scope at a time -----
  for (const st of stations) {
    for (const model of models) {
      const scope = `${st.icao}:${model.slug}`;
      stats.scopes++;
      const progress = await getProgress(db, SCRIPT, scope);
      let start = isoDate(model.archive_start) > from ? isoDate(model.archive_start) : from;
      if (progress.cursor && addDaysISO(progress.cursor, 1) > start) start = addDaysISO(progress.cursor, 1);
      if (start > to) {
        if (progress.status !== 'done') await setProgress(db, SCRIPT, scope, progress.cursor ?? to, 'done');
        stats.scopesDone++;
        continue;
      }

      try {
        for (const chunk of chunkRanges(start, to, CHUNK_DAYS)) {
          const days = (Date.parse(`${chunk.end}T00:00:00Z`) - Date.parse(`${chunk.start}T00:00:00Z`)) / 86_400_000 + 1;
          await budget.spend(requestWeight(PREVIOUS_RUNS_LEADS.length, days));
          const json = await deps.fetchJson(
            previousRunsUrl(prevBase, st, [model.slug], PREVIOUS_RUNS_LEADS, chunk, deps.apiKey),
          );
          const parsed = parsePreviousRunsHourly(json, [model.slug], PREVIOUS_RUNS_LEADS, st.tz);
          stats.rowsUpserted += await upsertRows(
            db,
            parsed.map((r) => ({
              icao: st.icao,
              model: r.model,
              target_date: r.targetDate,
              lead_days: r.leadDays,
              tmax_c: r.tmaxC,
              // notional run time: lead days before the target, midday — metadata
              // only ('backfill' rows never feed live builds, W19)
              captured_at: `${addDaysISO(r.targetDate, -r.leadDays)}T12:00:00Z`,
            })),
          );
          stats.chunksFetched++;
          await setProgress(db, SCRIPT, scope, chunk.end, 'running', requestWeight(PREVIOUS_RUNS_LEADS.length, days));
        }
        await setProgress(db, SCRIPT, scope, to, 'done');
        stats.scopesDone++;
      } catch (e) {
        stats.scopesErrored++;
        await setProgress(db, SCRIPT, scope, (await getProgress(db, SCRIPT, scope)).cursor, 'error');
        log(`ERROR ${scope}: ${String(e)} — cursor kept, restart resumes here`);
      }
    }
  }

  // --- day-0 pseudo-truth via Historical Forecast (all models in one call) ----
  const modelSlugs = models.map((m) => m.slug);
  for (const st of stations) {
    if (modelSlugs.length === 0) break;
    const scope = `${st.icao}:_day0`;
    stats.scopes++;
    const progress = await getProgress(db, SCRIPT, scope);
    const start = progress.cursor ? addDaysISO(progress.cursor, 1) : from;
    if (start > to) {
      if (progress.status !== 'done') await setProgress(db, SCRIPT, scope, progress.cursor ?? to, 'done');
      stats.scopesDone++;
      continue;
    }

    try {
      for (const chunk of chunkRanges(start, to, CHUNK_DAYS)) {
        const days = (Date.parse(`${chunk.end}T00:00:00Z`) - Date.parse(`${chunk.start}T00:00:00Z`)) / 86_400_000 + 1;
        await budget.spend(requestWeight(modelSlugs.length, days));
        const json = await deps.fetchJson(historicalForecastUrl(histBase, st, modelSlugs, chunk, deps.apiKey));
        const parsed = parseMultiModelDaily(json, modelSlugs);
        stats.rowsUpserted += await upsertRows(
          db,
          parsed.map((r) => ({
            icao: st.icao,
            model: r.model,
            target_date: r.targetDate,
            lead_days: 0,
            tmax_c: r.tmaxC,
            captured_at: `${r.targetDate}T12:00:00Z`,
          })),
        );
        stats.chunksFetched++;
        await setProgress(db, SCRIPT, scope, chunk.end, 'running', requestWeight(modelSlugs.length, days));
      }
      await setProgress(db, SCRIPT, scope, to, 'done');
      stats.scopesDone++;
    } catch (e) {
      stats.scopesErrored++;
      await setProgress(db, SCRIPT, scope, (await getProgress(db, SCRIPT, scope)).cursor, 'error');
      log(`ERROR ${scope}: ${String(e)} — cursor kept, restart resumes here`);
    }
  }

  log(
    `${SCRIPT} pass complete: ${stats.scopesDone}/${stats.scopes} scope(s) done, ` +
      `${stats.chunksFetched} chunk(s), ${stats.rowsUpserted} row(s) upserted, ${stats.scopesErrored} error(s)`,
  );
  return stats;
}

// CLI entry — only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      stations: { type: 'string' },
      models: { type: 'string' },
      budget: { type: 'string' },
    },
  });
  const db = makeScriptDb();
  try {
    const stats = await backfillForecasts(
      {
        from: values.from,
        to: values.to,
        stations: splitList(values.stations),
        models: splitList(values.models),
        budget: values.budget ? Number(values.budget) : undefined,
      },
      {
        db,
        fetchJson: (url) => ioFetchJson(url),
        log: console.log,
        now: () => new Date(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        apiKey: process.env['OPENMETEO_API_KEY'] || undefined,
      },
    );
    if (stats.scopesErrored > 0) process.exitCode = 1;
  } finally {
    await db.end();
  }
}
